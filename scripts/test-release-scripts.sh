#!/usr/bin/env bash
set -euo pipefail

# Regression tests for scripts/release-validate.sh, scripts/release-publish-draft.sh,
# scripts/macos-build-signed.sh, and scripts/verify-macos-bundle.sh.
# Uses stateful mocked CLIs (`gh`, `codesign`, `security`, `pnpm`, etc.) and temporary
# directories; makes zero network calls.

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to run test-release-scripts.sh." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synapseread-release-tests.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

MOCK_BIN="$TMP_DIR/bin"
STATE_DIR="$TMP_DIR/state"
ASSETS_DIR="$TMP_DIR/assets"
mkdir -p "$MOCK_BIN" "$STATE_DIR" "$ASSETS_DIR"

APP_VERSION="$(jq -r '.version' "$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json")"
TAG_NAME="v${APP_VERSION}"
DMG_NAME="SynapseRead_${APP_VERSION}_universal.dmg"
ZIP_NAME="SynapseRead_${APP_VERSION}_universal.app.zip"
SUMS_NAME="SHA256SUMS.txt"

SHA_A="1111111111111111111111111111111111111111"
SHA_B="2222222222222222222222222222222222222222"
TAG_OBJ_SHA="3333333333333333333333333333333333333333"
OTHER_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"

printf 'fake-dmg-bytes\n' > "${ASSETS_DIR}/${DMG_NAME}"
printf 'fake-app-zip-bytes\n' > "${ASSETS_DIR}/${ZIP_NAME}"
(
  cd "$ASSETS_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$DMG_NAME" "$ZIP_NAME" > "$SUMS_NAME"
  else
    sha256sum "$DMG_NAME" "$ZIP_NAME" > "$SUMS_NAME"
  fi
)

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

DMG_DIGEST="sha256:$(sha256_of "${ASSETS_DIR}/${DMG_NAME}")"
ZIP_DIGEST="sha256:$(sha256_of "${ASSETS_DIR}/${ZIP_NAME}")"
SUMS_DIGEST="sha256:$(sha256_of "${ASSETS_DIR}/${SUMS_NAME}")"

cat > "$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${MOCK_GH_STATE_DIR:?}"
LOG_FILE="${STATE_DIR}/calls.log"
printf '%s\n' "$*" >> "$LOG_FILE"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

subcmd="${1:-}"
shift || true

case "$subcmd" in
  api)
    method="GET"
    endpoint=""
    tag_name=""
    target_commitish=""
    draft=""
    input_file=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --method)
          method="$2"
          shift 2
          ;;
        --paginate)
          shift
          ;;
        --input)
          input_file="$2"
          shift 2
          ;;
        -H)
          shift 2
          ;;
        -f|-F)
          kv="$2"
          case "$kv" in
            tag_name=*) tag_name="${kv#tag_name=}" ;;
            target_commitish=*) target_commitish="${kv#target_commitish=}" ;;
            draft=*) draft="${kv#draft=}" ;;
          esac
          shift 2
          ;;
        -*)
          shift
          ;;
        *)
          endpoint="$1"
          shift
          ;;
      esac
    done

    case "${method}:${endpoint}" in
      GET:repos/*/git/ref/tags/*)
        if [ -f "${STATE_DIR}/ref.json" ]; then
          cat "${STATE_DIR}/ref.json"
          exit 0
        fi
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
        ;;
      GET:repos/*/git/tags/*)
        obj_sha="${endpoint##*/}"
        if [ -f "${STATE_DIR}/tag_${obj_sha}.json" ]; then
          cat "${STATE_DIR}/tag_${obj_sha}.json"
          exit 0
        fi
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
        ;;
      GET:repos/*/releases)
        cat "${STATE_DIR}/releases.json"
        exit 0
        ;;
      GET:repos/*/releases/*/assets)
        rel_id="${endpoint%/assets}"
        rel_id="${rel_id##*/}"
        jq -c --argjson id "$rel_id" '([.[] | select(.id == $id)] | .[0].assets) // []' "${STATE_DIR}/releases.json"
        exit 0
        ;;
      GET:repos/*/releases/*)
        rel_id="${endpoint##*/}"
        rel_obj="$(jq -c --argjson id "$rel_id" '[.[] | select(.id == $id)] | .[0] // empty' "${STATE_DIR}/releases.json")"
        if [ -z "$rel_obj" ]; then
          echo "gh: Not Found (HTTP 404)" >&2
          exit 1
        fi
        printf '%s\n' "$rel_obj"
        exit 0
        ;;
      POST:repos/*/releases)
        new_id=9001
        draft_bool=false
        [ "$draft" = "true" ] && draft_bool=true
        created_obj="$(jq -c -n \
          --argjson id "$new_id" \
          --arg tag "$tag_name" \
          --arg commitish "$target_commitish" \
          --argjson is_draft "$draft_bool" \
          '{id: $id, tag_name: $tag, target_commitish: $commitish, draft: $is_draft, upload_url: ("https://uploads.github.com/repos/owner/repo/releases/" + ($id|tostring) + "/assets{?name,label}"), assets: []}')"
        jq -c --argjson obj "$created_obj" '. + [$obj]' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
        mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
        printf '%s\n' "$created_obj"
        exit 0
        ;;
      POST:https://uploads.github.com/repos/*/releases/*/assets\?name=*)
        base_part="${endpoint%\?name=*}"
        asset_name="${endpoint#*\?name=}"
        rel_id="${base_part%/assets}"
        rel_id="${rel_id##*/}"

        if [ -z "$input_file" ] || [ ! -f "$input_file" ]; then
          echo "Mock gh error: missing --input file for asset upload" >&2
          exit 1
        fi

        if [ -f "${STATE_DIR}/publish_before_first_upload_immutable" ]; then
          rm -f "${STATE_DIR}/publish_before_first_upload_immutable"
          jq -c --argjson id "$rel_id" 'map(if .id == $id then .draft = false else . end)' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
          mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
          echo "gh: Validation Failed: Release is immutable (HTTP 422)" >&2
          exit 1
        fi

        if [ -f "${STATE_DIR}/publish_before_first_upload_mutable" ]; then
          rm -f "${STATE_DIR}/publish_before_first_upload_mutable"
          jq -c --argjson id "$rel_id" 'map(if .id == $id then .draft = false else . end)' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
          mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
        fi

        if [ -f "${STATE_DIR}/upload_fail_500_then_publish" ]; then
          rm -f "${STATE_DIR}/upload_fail_500_then_publish"
          jq -c --argjson id "$rel_id" 'map(if .id == $id then .draft = false else . end)' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
          mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
          echo "gh: Internal Server Error (HTTP 500)" >&2
          exit 1
        fi

        if [ -f "${STATE_DIR}/upload_fail_500_once" ]; then
          rm -f "${STATE_DIR}/upload_fail_500_once"
          echo "gh: Internal Server Error (HTTP 500)" >&2
          exit 1
        fi

        if [ -f "${STATE_DIR}/upload_fail_502_clean" ]; then
          rm -f "${STATE_DIR}/upload_fail_502_clean"
          echo "gh: Bad Gateway (HTTP 502)" >&2
          exit 1
        fi

        if [ -f "${STATE_DIR}/upload_fail_502_starter" ]; then
          rm -f "${STATE_DIR}/upload_fail_502_starter"
          starter_obj="$(jq -c -n --arg name "$asset_name" '{id: 701, name: $name, state: "starter", size: 0, digest: null}')"
          jq -c --argjson id "$rel_id" --argjson asset "$starter_obj" \
            'map(if .id == $id then .assets = ((.assets // []) + [$asset]) else . end)' \
            "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
          mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
          echo "gh: Bad Gateway (HTTP 502)" >&2
          exit 1
        fi

        existing="$(jq -c --argjson id "$rel_id" --arg name "$asset_name" '[.[] | select(.id == $id) | .assets[]? | select(.name == $name)] | length' "${STATE_DIR}/releases.json")"
        if [ "$existing" -gt 0 ]; then
          echo "gh: Validation Failed: ReleaseAsset already_exists (HTTP 422)" >&2
          exit 1
        fi

        digest="sha256:$(sha256_of "$input_file")"
        asset_obj="$(jq -c -n --arg name "$asset_name" --arg digest "$digest" '{id: 700, name: $name, state: "uploaded", digest: $digest}')"
        jq -c --argjson id "$rel_id" --argjson asset "$asset_obj" \
          'map(if .id == $id then .assets = ((.assets // []) + [$asset]) else . end)' \
          "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
        mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
        printf '%s\n' "$asset_obj"
        exit 0
        ;;
      *)
        echo "Unexpected gh api call: ${method} ${endpoint}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unexpected gh subcommand (gh release upload / delete must never be called): ${subcmd} $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$MOCK_BIN/gh"

export PATH="${MOCK_BIN}:$PATH"
export MOCK_GH_STATE_DIR="$STATE_DIR"
export RELEASE_UPLOAD_RETRY_DELAY=0

reset_state() {
  rm -f "${STATE_DIR}"/ref.json "${STATE_DIR}"/tag_*.json \
    "${STATE_DIR}/upload_fail_500_once" \
    "${STATE_DIR}/upload_fail_502_clean" \
    "${STATE_DIR}/upload_fail_502_starter" \
    "${STATE_DIR}/upload_fail_500_then_publish" \
    "${STATE_DIR}/publish_before_first_upload_immutable" \
    "${STATE_DIR}/publish_before_first_upload_mutable"
  printf '[]\n' > "${STATE_DIR}/releases.json"
  : > "${STATE_DIR}/calls.log"
}

assert_no_mutation_or_asset_calls() {
  local desc="$1"
  if grep -Eq 'POST|DELETE|--clobber|release upload|delete-asset|/assets\?name=' "${STATE_DIR}/calls.log"; then
    echo "[FAIL] ${desc}: unexpected mutation/upload/delete gh call:" >&2
    cat "${STATE_DIR}/calls.log" >&2
    exit 1
  fi
}

assert_never_used_clobber_or_delete() {
  local desc="$1"
  if grep -Eq 'DELETE|--clobber|release upload|delete-asset' "${STATE_DIR}/calls.log"; then
    echo "[FAIL] ${desc}: forbidden delete or --clobber call logged:" >&2
    cat "${STATE_DIR}/calls.log" >&2
    exit 1
  fi
}

assert_output_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local actual=""
  actual="$(awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2) }' "$file" | tail -n 1)"
  if [ "$actual" != "$expected" ]; then
    echo "[FAIL] Expected ${key}='${expected}', got '${actual}'" >&2
    cat "$file" >&2
    exit 1
  fi
}

make_release_json() {
  local id="$1"
  local is_draft="$2"
  local commitish="$3"
  local assets_json="${4:-[]}"
  jq -c -n \
    --argjson id "$id" \
    --arg tag "$TAG_NAME" \
    --arg commitish "$commitish" \
    --argjson draft "$is_draft" \
    --argjson assets "$assets_json" \
    '[{id: $id, tag_name: $tag, target_commitish: $commitish, draft: $draft, upload_url: ("https://uploads.github.com/repos/owner/repo/releases/" + ($id|tostring) + "/assets{?name,label}"), assets: $assets}]'
}

echo "1. release-validate: push on matching tag -> should_release=true"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/ref.json"
OUT_FILE="$TMP_DIR/out1.txt"
: > "$OUT_FILE"
EVENT_NAME=push REF_NAME="$TAG_NAME" GITHUB_REF="refs/tags/${TAG_NAME}" \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" GITHUB_OUTPUT="$OUT_FILE" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null
assert_output_value "$OUT_FILE" "should_release" "true"
assert_output_value "$OUT_FILE" "tag_name" "$TAG_NAME"
assert_output_value "$OUT_FILE" "app_version" "$APP_VERSION"
assert_output_value "$OUT_FILE" "build_sha" "$SHA_A"

echo "2. release-validate: push on mismatched tag -> fail"
reset_state
if EVENT_NAME=push REF_NAME="v9.9.9" GITHUB_REF="refs/tags/v9.9.9" \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected mismatched push tag to fail" >&2
  exit 1
fi

echo "3. release-validate: workflow_dispatch on branch with create_release=false -> should_release=false"
reset_state
OUT_FILE="$TMP_DIR/out3.txt"
: > "$OUT_FILE"
EVENT_NAME=workflow_dispatch REF_NAME="main" GITHUB_REF="refs/heads/main" \
  INPUT_CREATE_RELEASE=false INPUT_TAG="" INPUT_ALLOW_UNSIGNED=false \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" GITHUB_OUTPUT="$OUT_FILE" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null
assert_output_value "$OUT_FILE" "should_release" "false"
assert_output_value "$OUT_FILE" "tag_name" ""

echo "4. release-validate: workflow_dispatch on tag ref with create_release=false -> should_release=false (P2)"
reset_state
OUT_FILE="$TMP_DIR/out4.txt"
: > "$OUT_FILE"
EVENT_NAME=workflow_dispatch REF_NAME="$TAG_NAME" GITHUB_REF="refs/tags/${TAG_NAME}" \
  INPUT_CREATE_RELEASE=false INPUT_TAG="" INPUT_ALLOW_UNSIGNED=false \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" GITHUB_OUTPUT="$OUT_FILE" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null
assert_output_value "$OUT_FILE" "should_release" "false"
assert_output_value "$OUT_FILE" "tag_name" ""

echo "5. release-validate: workflow_dispatch create_release=true + allow_unsigned=true -> fail"
reset_state
if EVENT_NAME=workflow_dispatch REF_NAME="main" GITHUB_REF="refs/heads/main" \
  INPUT_CREATE_RELEASE=true INPUT_TAG="" INPUT_ALLOW_UNSIGNED=true \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected create_release=true with allow_unsigned=true to fail" >&2
  exit 1
fi

echo "6. release-validate: workflow_dispatch on annotated tag with create_release=true -> should_release=true"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"%s"}}\n' "$TAG_NAME" "$TAG_OBJ_SHA" > "${STATE_DIR}/ref.json"
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$SHA_A" > "${STATE_DIR}/tag_${TAG_OBJ_SHA}.json"
OUT_FILE="$TMP_DIR/out6.txt"
: > "$OUT_FILE"
EVENT_NAME=workflow_dispatch REF_NAME="$TAG_NAME" GITHUB_REF="refs/tags/${TAG_NAME}" \
  INPUT_CREATE_RELEASE=true INPUT_TAG="" INPUT_ALLOW_UNSIGNED=false \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" GITHUB_OUTPUT="$OUT_FILE" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null
assert_output_value "$OUT_FILE" "should_release" "true"
assert_output_value "$OUT_FILE" "tag_name" "$TAG_NAME"

echo "7. release-validate: workflow_dispatch create_release=true when remote tag points to another commit -> fail"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"%s"}}\n' "$TAG_NAME" "$TAG_OBJ_SHA" > "${STATE_DIR}/ref.json"
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$SHA_B" > "${STATE_DIR}/tag_${TAG_OBJ_SHA}.json"
if EVENT_NAME=workflow_dispatch REF_NAME="main" GITHUB_REF="refs/heads/main" \
  INPUT_CREATE_RELEASE=true INPUT_TAG="" INPUT_ALLOW_UNSIGNED=false \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected tag commit mismatch in release-validate to fail" >&2
  exit 1
fi

echo "8. release-publish-draft: new draft creation and upload via Release ID upload_url (no clobber)"
reset_state
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
assert_never_used_clobber_or_delete "new draft"
if [ "$(grep -c 'POST repos/owner/repo/releases ' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected exactly 1 POST release call for new draft" >&2
  exit 1
fi
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/9001/assets?name=' "${STATE_DIR}/calls.log")" -ne 3 ]; then
  echo "[FAIL] Expected 3 pinned upload_url asset uploads for new draft" >&2
  exit 1
fi

echo "9. release-publish-draft: same-commit draft rerun with matching digests -> skips all uploads"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"%s"}}\n' "$TAG_NAME" "$TAG_OBJ_SHA" > "${STATE_DIR}/ref.json"
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$SHA_A" > "${STATE_DIR}/tag_${TAG_OBJ_SHA}.json"
MATCHING_ASSETS="$(jq -c -n \
  --arg n1 "$DMG_NAME" --arg d1 "$DMG_DIGEST" \
  --arg n2 "$ZIP_NAME" --arg d2 "$ZIP_DIGEST" \
  --arg n3 "$SUMS_NAME" --arg d3 "$SUMS_DIGEST" \
  '[{id:1,name:$n1,state:"uploaded",digest:$d1},{id:2,name:$n2,state:"uploaded",digest:$d2},{id:3,name:$n3,state:"uploaded",digest:$d3}]')"
make_release_json 55 true "$SHA_A" "$MATCHING_ASSETS" > "${STATE_DIR}/releases.json"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
assert_no_mutation_or_asset_calls "same-commit matching rerun"

echo "10. release-publish-draft: same-commit draft rerun with 1 matching + 2 missing assets -> uploads only 2 missing"
reset_state
PARTIAL_ASSETS="$(jq -c -n --arg n1 "$DMG_NAME" --arg d1 "$DMG_DIGEST" '[{id:1,name:$n1,state:"uploaded",digest:$d1}]')"
make_release_json 56 true "$SHA_A" "$PARTIAL_ASSETS" > "${STATE_DIR}/releases.json"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
assert_never_used_clobber_or_delete "partial matching rerun"
if grep -q "name=${DMG_NAME}" "${STATE_DIR}/calls.log"; then
  echo "[FAIL] Matching DMG should have been skipped" >&2
  exit 1
fi
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/56/assets?name=' "${STATE_DIR}/calls.log")" -ne 2 ]; then
  echo "[FAIL] Expected only the 2 missing assets to upload" >&2
  exit 1
fi

echo "11. release-publish-draft: same-commit draft rerun with different digest -> abort without upload/delete"
reset_state
MISMATCH_ASSETS="$(jq -c -n --arg n1 "$DMG_NAME" --arg d1 "$OTHER_DIGEST" '[{id:1,name:$n1,state:"uploaded",digest:$d1}]')"
make_release_json 57 true "$SHA_A" "$MISMATCH_ASSETS" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected digest mismatch to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "digest mismatch on draft"

echo "12. release-publish-draft: existing asset with null digest or non-uploaded state -> abort without upload/delete"
reset_state
UNVERIFIED_ASSETS="$(jq -c -n --arg n1 "$DMG_NAME" '[{id:1,name:$n1,state:"starter",digest:null}]')"
make_release_json 58 true "$SHA_A" "$UNVERIFIED_ASSETS" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected unverified/starter asset to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "unverified existing asset"

echo "13. release-publish-draft: lightweight tag pointing to different commit -> abort without upload/delete"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_B" > "${STATE_DIR}/ref.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected lightweight tag commit mismatch to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "lightweight tag mismatch"

echo "14. release-publish-draft: annotated tag pointing to different commit -> abort without upload/delete"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"%s"}}\n' "$TAG_NAME" "$TAG_OBJ_SHA" > "${STATE_DIR}/ref.json"
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$SHA_B" > "${STATE_DIR}/tag_${TAG_OBJ_SHA}.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected annotated tag commit mismatch to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "annotated tag mismatch"

echo "15. release-publish-draft: existing draft bound to different commitish or branch -> abort without upload/delete"
reset_state
make_release_json 66 true "$SHA_B" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected draft bound to SHA_B to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "draft bound to SHA_B"

reset_state
make_release_json 67 true "main" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected draft bound to branch name to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "draft bound to branch main"

echo "16. release-publish-draft: existing published release -> abort without upload/delete"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/ref.json"
make_release_json 77 false "$SHA_A" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected existing published release to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "existing published release"

echo "17. release-publish-draft: prefix tag array without exact ref -> treated as absent"
reset_state
printf '[{"ref":"refs/tags/%s-rc1","object":{"type":"commit","sha":"%s"}}]\n' "$TAG_NAME" "$SHA_B" > "${STATE_DIR}/ref.json"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
assert_never_used_clobber_or_delete "prefix tag array"
if [ "$(grep -c 'POST repos/owner/repo/releases ' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected prefix-only ref array to allow creating draft" >&2
  exit 1
fi

echo "18. release-publish-draft: P1 race (last read draft, published before first write; immutable server rejects 422 with zero asset changes)"
reset_state
make_release_json 81 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/publish_before_first_upload_immutable"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected P1 race (published before first write) to fail" >&2
  exit 1
fi
assert_never_used_clobber_or_delete "P1 immutable race"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/81/assets?name=' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected abort immediately on rejected first write without attempting remaining assets" >&2
  exit 1
fi
if [ "$(jq '.[0].assets | length' "${STATE_DIR}/releases.json")" -ne 0 ]; then
  echo "[FAIL] Expected immutable published release asset list to remain unchanged (length 0)" >&2
  exit 1
fi

echo "19. release-publish-draft: P1 race (last read draft, published before first write; mutable server) -> aborts and exits non-zero"
reset_state
make_release_json 82 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/publish_before_first_upload_mutable"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected P1 mutable race to detect published state and exit non-zero" >&2
  exit 1
fi
assert_never_used_clobber_or_delete "P1 mutable race"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/82/assets?name=' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected pre-asset verification to abort after first write before uploading remaining 2 assets" >&2
  exit 1
fi

reset_state
TWO_MATCHING_ASSETS="$(jq -c -n \
  --arg n1 "$DMG_NAME" --arg d1 "$DMG_DIGEST" \
  --arg n2 "$ZIP_NAME" --arg d2 "$ZIP_DIGEST" \
  '[{id:1,name:$n1,state:"uploaded",digest:$d1},{id:2,name:$n2,state:"uploaded",digest:$d2}]')"
make_release_json 85 true "$SHA_A" "$TWO_MATCHING_ASSETS" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/publish_before_first_upload_mutable"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected post-upload check to catch published flip before final asset write" >&2
  exit 1
fi
assert_never_used_clobber_or_delete "P1 mutable race on final asset"

echo "20. release-publish-draft: transient 500 retries once when still draft, aborts before retry if published"
reset_state
make_release_json 83 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/upload_fail_500_once"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1
assert_never_used_clobber_or_delete "transient 500 retry"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/83/assets?name=' "${STATE_DIR}/calls.log")" -ne 4 ]; then
  echo "[FAIL] Expected 4 upload POSTs (1 failed 500 + 3 succeeded)" >&2
  exit 1
fi

reset_state
make_release_json 84 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/upload_fail_500_then_publish"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected retry after 500 to abort when release became published" >&2
  exit 1
fi
assert_never_used_clobber_or_delete "500 then publish"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/84/assets?name=' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected retry not to POST again after release became published" >&2
  exit 1
fi

echo "21. release-validate: fails early when published release already exists"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/ref.json"
make_release_json 88 false "$SHA_A" > "${STATE_DIR}/releases.json"
if EVENT_NAME=push REF_NAME="$TAG_NAME" GITHUB_REF="refs/tags/${TAG_NAME}" \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected release-validate to fail when published release already exists" >&2
  exit 1
fi

echo "22. release-publish-draft: P2 conflict on later asset (.app.zip or SHA256SUMS.txt) when .dmg is missing -> zero upload requests"
reset_state
ZIP_CONFLICT_ASSETS="$(jq -c -n --arg n2 "$ZIP_NAME" --arg d2 "$OTHER_DIGEST" '[{id:2,name:$n2,state:"uploaded",digest:$d2}]')"
make_release_json 86 true "$SHA_A" "$ZIP_CONFLICT_ASSETS" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected later .app.zip digest conflict to fail before uploading .dmg" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "later .app.zip conflict with missing .dmg"

reset_state
SUMS_CONFLICT_ASSETS="$(jq -c -n \
  --arg n1 "$DMG_NAME" --arg d1 "$DMG_DIGEST" \
  --arg n3 "$SUMS_NAME" --arg d3 "$OTHER_DIGEST" \
  '[{id:1,name:$n1,state:"uploaded",digest:$d1},{id:3,name:$n3,state:"uploaded",digest:$d3}]')"
make_release_json 87 true "$SHA_A" "$SUMS_CONFLICT_ASSETS" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected later SHA256SUMS.txt digest conflict to fail before uploading .app.zip" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "later SHA256SUMS.txt conflict with missing .app.zip"

echo "23. release-publish-draft: P2 502 -> starter reports draft/asset IDs without retry POST; clean 502 retries cleanly"
reset_state
make_release_json 89 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/upload_fail_502_starter"
ERR_23A="$TMP_DIR/err23a.log"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" > /dev/null 2> "$ERR_23A"; then
  echo "[FAIL] Expected 502 leaving starter asset to fail" >&2
  exit 1
fi
assert_never_used_clobber_or_delete "502 leaving starter"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/89/assets?name=' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected retry precheck to abort on starter asset without issuing a second POST" >&2
  exit 1
fi
if ! grep -q "starter" "$ERR_23A" || ! grep -q "id=89" "$ERR_23A" || ! grep -q "asset id=701" "$ERR_23A"; then
  echo "[FAIL] Expected starter error to report starter state, release id=89, and asset id=701:" >&2
  cat "$ERR_23A" >&2
  exit 1
fi

reset_state
STARTER_ZIP_ASSETS="$(jq -c -n --arg n2 "$ZIP_NAME" '[{id:702,name:$n2,state:"starter",size:0,digest:null}]')"
make_release_json 90 true "$SHA_A" "$STARTER_ZIP_ASSETS" > "${STATE_DIR}/releases.json"
ERR_23B="$TMP_DIR/err23b.log"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" > /dev/null 2> "$ERR_23B"; then
  echo "[FAIL] Expected rerun with existing starter asset on .app.zip to fail before uploading .dmg" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "rerun with starter asset on later asset"
if ! grep -q "starter" "$ERR_23B" || ! grep -q "id=90" "$ERR_23B" || ! grep -q "asset id=702" "$ERR_23B"; then
  echo "[FAIL] Expected rerun starter error to report starter state, release id=90, and asset id=702:" >&2
  cat "$ERR_23B" >&2
  exit 1
fi

reset_state
make_release_json 91 true "$SHA_A" > "${STATE_DIR}/releases.json"
touch "${STATE_DIR}/upload_fail_502_clean"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1
assert_never_used_clobber_or_delete "clean 502 retry"
if [ "$(grep -c 'POST https://uploads.github.com/repos/owner/repo/releases/91/assets?name=' "${STATE_DIR}/calls.log")" -ne 4 ]; then
  echo "[FAIL] Expected 4 upload POSTs for clean 502 retry (1 failed 502 + 3 succeeded)" >&2
  exit 1
fi

MAC_MOCK_BIN="$TMP_DIR/macbin"
MAC_STATE="$TMP_DIR/macstate"
MAC_TARGET_DIR="$TMP_DIR/target"
MAC_TMP_DIR="$TMP_DIR/mactmp"
mkdir -p "$MAC_MOCK_BIN" "$MAC_STATE/cs" "$MAC_STATE/mounted" "$MAC_TARGET_DIR" "$MAC_TMP_DIR"

cat > "$MAC_MOCK_BIN/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'uname %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
if [ "${1:-}" = "-s" ]; then
  echo "Darwin"
  exit 0
fi
if [ -x /usr/bin/uname ]; then
  exec /usr/bin/uname "$@"
fi
exec /bin/uname "$@"
EOF

cat > "$MAC_MOCK_BIN/rustup" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'rustup %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
printf 'aarch64-apple-darwin\nx86_64-apple-darwin\n'
EOF

cat > "$MAC_MOCK_BIN/security" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MAC_STATE="${MOCK_MAC_STATE_DIR:?}"
printf 'security %s\n' "$*" >> "${MAC_STATE}/calls.log"
if [ -f "${MAC_STATE}/security_fail" ]; then
  echo "security: SecKeychainSearchCopyNext: mocked failure" >&2
  exit 1
fi
cat "${MAC_STATE}/identities.txt"
EOF

cat > "$MAC_MOCK_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MAC_STATE="${MOCK_MAC_STATE_DIR:?}"
TARGET_ROOT="${CARGO_TARGET_DIR:?}"
printf 'pnpm %s\n' "$*" >> "${MAC_STATE}/calls.log"

target=""
has_bundles_app=false
prev=""
for arg in "$@"; do
  if [ "$prev" = "--target" ]; then
    target="$arg"
  elif [ "$prev" = "--bundles" ] && [ "$arg" = "app" ]; then
    has_bundles_app=true
  fi
  prev="$arg"
done

case "$target" in
  universal-apple-darwin)
    dmg_arch="universal"
    archs="x86_64 arm64"
    ;;
  aarch64-apple-darwin)
    dmg_arch="aarch64"
    archs="arm64"
    ;;
  x86_64-apple-darwin)
    dmg_arch="x64"
    archs="x86_64"
    ;;
  *)
    echo "Mock pnpm error: unexpected --target '$target'" >&2
    exit 1
    ;;
esac

app_dir="${TARGET_ROOT}/${target}/release/bundle/macos/SynapseRead.app"
mkdir -p "${app_dir}/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "${app_dir}/Contents/MacOS/synapseread-desktop"
chmod +x "${app_dir}/Contents/MacOS/synapseread-desktop"
printf '%s\n' "$archs" > "${app_dir}/Contents/MacOS/synapseread-desktop.archs"
cat > "${app_dir}/Contents/Info.plist" <<'PLIST'
CFBundleIdentifier=app.synapseread.desktop
NSLocalNetworkUsageDescription=SynapseRead uses your local network only when you choose to share or import books with another device on the same network.
PLIST

seq_file="${MAC_STATE}/sign_seq"
seq=1
if [ -f "$seq_file" ]; then
  seq=$(( $(cat "$seq_file") + 1 ))
fi
printf '%s\n' "$seq" > "$seq_file"

first_arch="${archs%% *}"
for a in $archs; do
  if command -v shasum >/dev/null 2>&1; then
    cdh="$(printf 'linker:%s:%s' "$seq" "$a" | shasum -a 256 | awk '{print substr($1, 1, 40)}')"
  else
    cdh="$(printf 'linker:%s:%s' "$seq" "$a" | sha256sum | awk '{print substr($1, 1, 40)}')"
  fi
  cat > "${app_dir}/.mock_codesign.dv.${a}" <<STATE
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
CDHash=${cdh}
CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded
STATE
done
cp "${app_dir}/.mock_codesign.dv.${first_arch}" "${app_dir}/.mock_codesign.dv"

if [ "$has_bundles_app" = false ]; then
  dmg_dir="${TARGET_ROOT}/${target}/release/bundle/dmg"
  mkdir -p "$dmg_dir"
  tar -cf "${dmg_dir}/SynapseRead_${APP_VERSION:?}_${dmg_arch}.dmg" -C "$(dirname "$app_dir")" "$(basename "$app_dir")"
fi
EOF

cat > "$MAC_MOCK_BIN/codesign" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MAC_STATE="${MOCK_MAC_STATE_DIR:?}"
printf 'codesign %s\n' "$*" >> "${MAC_STATE}/calls.log"

hash40() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print substr($1, 1, 40)}'
  else
    printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 40)}'
  fi
}

mode=""
sign_id=""
has_runtime=false
arch=""
last_arg=""
while [ $# -gt 0 ]; do
  last_arg="$1"
  case "$1" in
    --sign|-s)
      mode="sign"
      sign_id="${2:-}"
      shift 2
      ;;
    --arch|-a)
      arch="${2:-}"
      shift 2
      ;;
    --options)
      if [ "${2:-}" = "runtime" ] || [[ ",${2:-}," == *",runtime,"* ]]; then
        has_runtime=true
      fi
      shift 2
      ;;
    --options=*)
      opt_val="${1#--options=}"
      if [ "$opt_val" = "runtime" ] || [[ ",${opt_val}," == *",runtime,"* ]]; then
        has_runtime=true
      fi
      shift
      ;;
    -dv)
      mode="dv"
      shift
      ;;
    --verify)
      mode="verify"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ -d "$last_arg" ]; then
  state_prefix="${last_arg}/.mock_codesign"
else
  mkdir -p "${MAC_STATE}/cs"
  state_prefix="${MAC_STATE}/cs/$(basename "$last_arg")"
fi

case "$mode" in
  sign)
    seq_file="${MAC_STATE}/sign_seq"
    seq=1
    if [ -f "$seq_file" ]; then
      seq=$(( $(cat "$seq_file") + 1 ))
    fi
    printf '%s\n' "$seq" > "$seq_file"

    resolved_authority="$sign_id"
    if [[ "$sign_id" =~ ^[0-9A-Fa-f]{40}$ ]] && [ -f "${MAC_STATE}/identities.txt" ]; then
      sign_upper="$(printf '%s' "$sign_id" | tr '[:lower:]' '[:upper:]')"
      found_name="$(awk -v fp="$sign_upper" '
        {
          if (match($0, /^[[:space:]]*[0-9]+\)[[:space:]]+([0-9A-Fa-f]{40})[[:space:]]+"(.+)"[[:space:]]*$/)) {
            line = $0
            sub(/^[[:space:]]*[0-9]+\)[[:space:]]+/, "", line)
            cur_fp = toupper(substr(line, 1, 40))
            if (cur_fp == fp) {
              name = substr(line, 42)
              sub(/^[[:space:]]*"/, "", name)
              sub(/"[[:space:]]*$/, "", name)
              print name
              exit
            }
          }
        }
      ' "${MAC_STATE}/identities.txt")"
      if [ -n "$found_name" ]; then
        resolved_authority="$found_name"
      fi
    fi

    if [ -d "$last_arg" ]; then
      archs="x86_64 arm64"
      if [ -f "${last_arg}/Contents/MacOS/synapseread-desktop.archs" ]; then
        archs="$(cat "${last_arg}/Contents/MacOS/synapseread-desktop.archs")"
      fi
      first_arch="${archs%% *}"
      for a in $archs; do
        cdh="$(hash40 "${seq}:${sign_id}:${a}")"
        if [ "$sign_id" = "-" ]; then
          cat > "${state_prefix}.dv.${a}" <<STATE
Signature=adhoc
Info.plist entries=20
TeamIdentifier=not set
CDHash=${cdh}
CodeDirectory v=20500 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
STATE
        else
          flags="0x0(none)"
          [ "$has_runtime" = true ] && flags="0x10000(runtime)"
          cat > "${state_prefix}.dv.${a}" <<STATE
Authority=${resolved_authority}
Signature size=1234
Info.plist entries=20
TeamIdentifier=not set
CDHash=${cdh}
CodeDirectory v=20500 size=1 flags=${flags} hashes=1+0 location=embedded
STATE
        fi
      done
      cp "${state_prefix}.dv.${first_arch}" "${state_prefix}.dv"
    else
      if [ "$sign_id" = "-" ]; then
        cat > "${state_prefix}.dv" <<'STATE'
Signature=adhoc
Info.plist entries=20
TeamIdentifier=not set
CodeDirectory v=20500 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
STATE
      else
        flags="0x0(none)"
        [ "$has_runtime" = true ] && flags="0x10000(runtime)"
        cat > "${state_prefix}.dv" <<STATE
Authority=${resolved_authority}
Signature size=1234
Info.plist entries=20
TeamIdentifier=not set
CodeDirectory v=20500 size=1 flags=${flags} hashes=1+0 location=embedded
STATE
      fi
    fi
    ;;
  dv)
    if [ -n "$arch" ]; then
      if [ -f "${state_prefix}.dv.${arch}" ]; then
        cat "${state_prefix}.dv.${arch}" >&2
        exit 0
      fi
      echo "${last_arg}: architecture ${arch} not found" >&2
      exit 1
    fi
    if [ -f "${state_prefix}.dv" ]; then
      cat "${state_prefix}.dv" >&2
      exit 0
    fi
    echo "${last_arg}: code object is not signed at all" >&2
    exit 1
    ;;
  verify)
    if [ -f "${state_prefix}.dv" ] && [ ! -f "${state_prefix}.verify_fail" ]; then
      exit 0
    fi
    exit 1
    ;;
  *)
    echo "Mock codesign error: unrecognized invocation: $*" >&2
    exit 1
    ;;
esac
EOF

cat > "$MAC_MOCK_BIN/hdiutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MAC_STATE="${MOCK_MAC_STATE_DIR:?}"
printf 'hdiutil %s\n' "$*" >> "${MAC_STATE}/calls.log"
sub="${1:-}"
shift || true
case "$sub" in
  create)
    srcfolder=""
    last_arg=""
    prev=""
    for arg in "$@"; do
      last_arg="$arg"
      if [ "$prev" = "-srcfolder" ]; then
        srcfolder="$arg"
      fi
      prev="$arg"
    done
    if [ -n "$srcfolder" ] && [ -d "$srcfolder" ]; then
      printf 'hdiutil-srcfolder: %s\n' "$(ls -1 "$srcfolder" | tr '\n' ' ')" >> "${MAC_STATE}/calls.log"
    fi
    mkdir -p "$(dirname "$last_arg")"
    tar -cf "$last_arg" -C "$srcfolder" .
    ;;
  verify)
    [ -f "${1:-}" ] && tar -tf "${1:-}" >/dev/null 2>&1
    ;;
  attach)
    if [ -f "${MAC_STATE}/attach_fail" ]; then
      echo "hdiutil: attach failed (mocked)" >&2
      exit 1
    fi
    mountpoint=""
    dmg_file=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "-mountpoint" ]; then
        mountpoint="$arg"
      fi
      case "$arg" in
        -*) ;;
        *)
          if [ "$prev" != "-mountpoint" ]; then
            dmg_file="$arg"
          fi
          ;;
      esac
      prev="$arg"
    done
    if [ -z "$mountpoint" ] || [ ! -d "$mountpoint" ] || [ ! -f "$dmg_file" ]; then
      echo "hdiutil: invalid attach args" >&2
      exit 1
    fi
    tar -xf "$dmg_file" -C "$mountpoint"
    mkdir -p "${MAC_STATE}/mounted"
    printf '%s\n' "$dmg_file" > "${MAC_STATE}/mounted/$(basename "$mountpoint")"
    ;;
  detach)
    mountpoint="${1:-}"
    shift || true
    is_force=false
    for arg in "$@"; do
      if [ "$arg" = "-force" ]; then
        is_force=true
      fi
    done
    if [ "$is_force" = false ] && [ -f "${MAC_STATE}/detach_normal_fail" ]; then
      echo "hdiutil: couldn't unmount \"${mountpoint}\" - Resource busy (mocked)" >&2
      exit 1
    fi
    if [ "$is_force" = true ] && [ -f "${MAC_STATE}/detach_force_fail" ]; then
      echo "hdiutil: force unmount failed for \"${mountpoint}\" (mocked)" >&2
      exit 1
    fi
    if [ -z "$mountpoint" ] || [ ! -d "$mountpoint" ]; then
      exit 1
    fi
    marker="${MAC_STATE}/mounted/$(basename "$mountpoint")"
    if [ ! -f "$marker" ]; then
      exit 1
    fi
    find "$mountpoint" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    rm -f "$marker"
    ;;
  *)
    echo "Mock hdiutil error: unexpected subcommand '$sub'" >&2
    exit 1
    ;;
esac
EOF

cat > "$MAC_MOCK_BIN/ditto" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ditto %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
cp -R "$1" "$2"
EOF

cat > "$MAC_MOCK_BIN/lipo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'lipo %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
last_arg=""
for arg in "$@"; do
  last_arg="$arg"
done
if [ -n "$last_arg" ] && [ -f "${last_arg}.archs" ]; then
  cat "${last_arg}.archs"
else
  echo "x86_64 arm64"
fi
EOF

cat > "$MAC_MOCK_BIN/plutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'plutil %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
case "${1:-}" in
  -lint)
    [ -f "${2:-}" ]
    ;;
  -extract)
    key="${2:-}"
    last_arg=""
    for arg in "$@"; do
      last_arg="$arg"
    done
    awk -F= -v k="$key" '$1 == k { found=1; print substr($0, length(k) + 2); exit } END { if (!found) exit 1 }' "$last_arg"
    ;;
  -p)
    cat "${2:-}"
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat > "$MAC_MOCK_BIN/shasum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'shasum %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
last_arg=""
for arg in "$@"; do
  last_arg="$arg"
done
echo "0000000000000000000000000000000000000000000000000000000000000000  $last_arg"
EOF

cat > "$MAC_MOCK_BIN/xcrun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'xcrun %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
exit 1
EOF

cat > "$MAC_MOCK_BIN/spctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'spctl %s\n' "$*" >> "${MOCK_MAC_STATE_DIR:?}/calls.log"
exit 1
EOF

chmod +x "$MAC_MOCK_BIN"/*

FP_DEFAULT="0123456789ABCDEF0123456789ABCDEF01234567"
FP_ALT="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

reset_mac_state() {
  rm -rf "${MAC_STATE}/cs" "${MAC_STATE}/mounted" "$MAC_TARGET_DIR" "$MAC_TMP_DIR"
  rm -f "${MAC_STATE}/security_fail" "${MAC_STATE}/attach_fail" "${MAC_STATE}/detach_normal_fail" "${MAC_STATE}/detach_force_fail" "${MAC_STATE}/sign_seq"
  mkdir -p "${MAC_STATE}/cs" "${MAC_STATE}/mounted" "$MAC_TARGET_DIR" "$MAC_TMP_DIR"
  : > "${MAC_STATE}/calls.log"
  cat > "${MAC_STATE}/identities.txt" <<IDS
  1) ${FP_DEFAULT} "SynapseRead Local Signing"
     1 valid identities found
IDS
}

make_fake_app() {
  local app_dir="$1"
  local archs="${2:-x86_64 arm64}"
  mkdir -p "${app_dir}/Contents/MacOS"
  printf '#!/bin/sh\nexit 0\n' > "${app_dir}/Contents/MacOS/synapseread-desktop"
  chmod +x "${app_dir}/Contents/MacOS/synapseread-desktop"
  printf '%s\n' "$archs" > "${app_dir}/Contents/MacOS/synapseread-desktop.archs"
  cat > "${app_dir}/Contents/Info.plist" <<'PLIST'
CFBundleIdentifier=app.synapseread.desktop
NSLocalNetworkUsageDescription=SynapseRead uses your local network only when you choose to share or import books with another device on the same network.
PLIST
}

set_cs_state() {
  local target="$1"
  local content="$2"
  local arch="${3:-}"
  local prefix
  if [ -d "$target" ]; then
    prefix="${target}/.mock_codesign"
  else
    mkdir -p "${MAC_STATE}/cs"
    prefix="${MAC_STATE}/cs/$(basename "$target")"
  fi
  if [ -n "$arch" ]; then
    printf '%s\n' "$content" > "${prefix}.dv.${arch}"
  else
    printf '%s\n' "$content" > "${prefix}.dv"
    if [ -d "$target" ] && [ -f "${target}/Contents/MacOS/synapseread-desktop.archs" ]; then
      for a in $(cat "${target}/Contents/MacOS/synapseread-desktop.archs"); do
        printf '%s\n' "$content" > "${prefix}.dv.${a}"
      done
    fi
  fi
}

make_fake_dmg() {
  local dmg_path="$1"
  local app_dir="$2"
  mkdir -p "$(dirname "$dmg_path")"
  tar -cf "$dmg_path" -C "$(dirname "$app_dir")" "$(basename "$app_dir")"
}

assert_no_leaked_mounts() {
  local desc="$1"
  local remaining_mounts remaining_dirs
  remaining_mounts="$(find "${MAC_STATE}/mounted" -mindepth 1 | wc -l | tr -d ' ')"
  remaining_dirs="$(find "$MAC_TMP_DIR" -maxdepth 1 -name 'synapseread-dmg-verify.*' | wc -l | tr -d ' ')"
  if [ "$remaining_mounts" -ne 0 ] || [ "$remaining_dirs" -ne 0 ]; then
    echo "[FAIL] ${desc}: mount cleanup leaked (mounts=${remaining_mounts}, dirs=${remaining_dirs})" >&2
    exit 1
  fi
}

run_with_mac_mocks() {
  PATH="${MAC_MOCK_BIN}:$PATH" \
    MOCK_MAC_STATE_DIR="$MAC_STATE" \
    CARGO_TARGET_DIR="$MAC_TARGET_DIR" \
    TMPDIR="$MAC_TMP_DIR" \
    APP_VERSION="$APP_VERSION" \
    "$@"
}

echo "24. macos-build-signed: --local-sign missing value or flag-like value -> fail without calling pnpm"
reset_mac_state
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign >/dev/null 2>&1; then
  echo "[FAIL] Expected --local-sign with missing value to fail" >&2
  exit 1
fi
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign --ci >/dev/null 2>&1; then
  echo "[FAIL] Expected --local-sign --ci to fail" >&2
  exit 1
fi
if grep -q '^pnpm ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] pnpm must not be called when --local-sign argument validation fails" >&2
  exit 1
fi

echo "25. macos-build-signed: --local-sign - -> fail and direct user to --adhoc-sign"
reset_mac_state
ERR_25="$TMP_DIR/err25.log"
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign - >/dev/null 2>"$ERR_25"; then
  echo "[FAIL] Expected --local-sign - to fail" >&2
  exit 1
fi
if ! grep -q -- '--adhoc-sign' "$ERR_25"; then
  echo "[FAIL] Expected stderr to mention --adhoc-sign:" >&2
  cat "$ERR_25" >&2
  exit 1
fi
if grep -q '^pnpm ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] pnpm must not be called for --local-sign -" >&2
  exit 1
fi

echo "26. macos-build-signed: mutually exclusive signing mode flags -> fail without calling pnpm"
for pair in \
  "--local-sign SynapseRead_Local --allow-unsigned" \
  "--adhoc-sign --allow-unsigned" \
  "--local-sign SynapseRead_Local --adhoc-sign"; do
  reset_mac_state
  # shellcheck disable=SC2086
  if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" $pair >/dev/null 2>&1; then
    echo "[FAIL] Expected mutually exclusive flags ($pair) to fail" >&2
    exit 1
  fi
  if grep -q '^pnpm ' "${MAC_STATE}/calls.log"; then
    echo "[FAIL] pnpm must not be called when mutually exclusive flags ($pair) are passed" >&2
    exit 1
  fi
done

echo "27. macos-build-signed: --local-sign rejects missing, zero-summary, security-error, partial, and ambiguous identities before pnpm"
reset_mac_state
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "Missing Identity" >/dev/null 2>&1; then
  echo "[FAIL] Expected missing Keychain identity to fail" >&2
  exit 1
fi
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "SynapseRead Local" >/dev/null 2>&1; then
  echo "[FAIL] Expected partial certificate name to fail" >&2
  exit 1
fi
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "0123456789ABCDEF" >/dev/null 2>&1; then
  echo "[FAIL] Expected partial fingerprint to fail" >&2
  exit 1
fi

printf '     0 valid identities found\n' > "${MAC_STATE}/identities.txt"
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "0 valid identities found" >/dev/null 2>&1; then
  echo "[FAIL] Expected summary line '0 valid identities found' to be rejected" >&2
  exit 1
fi
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "valid identities" >/dev/null 2>&1; then
  echo "[FAIL] Expected substring of summary line to be rejected" >&2
  exit 1
fi

reset_mac_state
touch "${MAC_STATE}/security_fail"
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "SynapseRead Local Signing" >/dev/null 2>&1; then
  echo "[FAIL] Expected security tool failure to abort before pnpm" >&2
  exit 1
fi

reset_mac_state
cat > "${MAC_STATE}/identities.txt" <<IDS
  1) ${FP_DEFAULT} "SynapseRead Local Signing"
  2) ${FP_ALT} "SynapseRead Local Signing"
     2 valid identities found
IDS
if run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "SynapseRead Local Signing" >/dev/null 2>&1; then
  echo "[FAIL] Expected duplicate certificate name ambiguity to fail" >&2
  exit 1
fi
if grep -q '^pnpm ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] pnpm must not be called on any failed identity preflight" >&2
  exit 1
fi

run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "$FP_ALT" --target aarch64-apple-darwin >/dev/null
if ! grep -Fq "codesign --force --deep --options runtime --timestamp=none --sign ${FP_ALT} " "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected explicit fingerprint $FP_ALT to disambiguate duplicate certificate names" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi

echo "28. macos-build-signed: --local-sign by name or fingerprint resolves same cert fingerprint for .app and .dmg, verifies inner DMG, skips notarization"
reset_mac_state
OUT_28="$TMP_DIR/out28.log"
run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "SynapseRead Local Signing" --ci >"$OUT_28"
if ! grep -q '^pnpm .*--bundles app' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected pnpm tauri build to receive --bundles app in local-sign mode" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
EXPECTED_APP_28="${MAC_TARGET_DIR}/universal-apple-darwin/release/bundle/macos/SynapseRead.app"
EXPECTED_DMG_28="${MAC_TARGET_DIR}/universal-apple-darwin/release/bundle/dmg/SynapseRead_${APP_VERSION}_universal.dmg"
APP_SIGN_LINE="$(grep -n "codesign --force --deep --options runtime --timestamp=none --sign ${FP_DEFAULT} ${EXPECTED_APP_28}" "${MAC_STATE}/calls.log" | head -n 1 | cut -d: -f1 || true)"
HDIUTIL_CREATE_LINE="$(grep -n '^hdiutil create ' "${MAC_STATE}/calls.log" | head -n 1 | cut -d: -f1 || true)"
if [ -z "$APP_SIGN_LINE" ] || [ -z "$HDIUTIL_CREATE_LINE" ] || [ "$APP_SIGN_LINE" -ge "$HDIUTIL_CREATE_LINE" ]; then
  echo "[FAIL] Expected app codesign with fingerprint before hdiutil create (app_sign=$APP_SIGN_LINE, hdiutil=$HDIUTIL_CREATE_LINE)" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if [ ! -f "$EXPECTED_DMG_28" ]; then
  echo "[FAIL] Expected DMG at $EXPECTED_DMG_28" >&2
  exit 1
fi
if ! grep -Fq "codesign --force --timestamp=none --sign ${FP_DEFAULT} ${EXPECTED_DMG_28}" "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected DMG to be signed with resolved fingerprint ${FP_DEFAULT}" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if ! grep -q '^hdiutil attach ' "${MAC_STATE}/calls.log" || ! grep -q '^hdiutil detach ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected verify-macos-bundle to attach and detach DMG in --local-sign mode" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
assert_no_leaked_mounts "test 28 name build"
if grep -Eq '^(xcrun|spctl) ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no xcrun or spctl calls in --local-sign mode" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if ! grep -Fq 'All requested macOS bundle checks passed.' "$OUT_28"; then
  echo "[FAIL] Expected verify-macos-bundle success output in --local-sign mode" >&2
  cat "$OUT_28" >&2
  exit 1
fi

reset_mac_state
FP_LOWER="$(printf '%s' "$FP_DEFAULT" | tr '[:upper:]' '[:lower:]')"
run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --local-sign "$FP_LOWER" --target aarch64-apple-darwin >/dev/null
EXPECTED_APP_28B="${MAC_TARGET_DIR}/aarch64-apple-darwin/release/bundle/macos/SynapseRead.app"
EXPECTED_DMG_28B="${MAC_TARGET_DIR}/aarch64-apple-darwin/release/bundle/dmg/SynapseRead_${APP_VERSION}_aarch64.dmg"
if ! grep -Fq "codesign --force --deep --options runtime --timestamp=none --sign ${FP_DEFAULT} ${EXPECTED_APP_28B}" "${MAC_STATE}/calls.log" \
  || ! grep -Fq "codesign --force --timestamp=none --sign ${FP_DEFAULT} ${EXPECTED_DMG_28B}" "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected lowercase 40-hex fingerprint to normalize to uppercase ${FP_DEFAULT} for .app and .dmg" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
assert_no_leaked_mounts "test 28 fingerprint build"

echo "29. macos-build-signed: --adhoc-sign aarch64 signs app ad hoc (bound), packages DMG, verifies inner app, skips DMG codesign and xcrun"
reset_mac_state
run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --adhoc-sign --target aarch64-apple-darwin >/dev/null
EXPECTED_APP_29="${MAC_TARGET_DIR}/aarch64-apple-darwin/release/bundle/macos/SynapseRead.app"
EXPECTED_DMG_29="${MAC_TARGET_DIR}/aarch64-apple-darwin/release/bundle/dmg/SynapseRead_${APP_VERSION}_aarch64.dmg"
if ! grep -Fq "codesign --force --deep --sign - ${EXPECTED_APP_29}" "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected ad hoc codesign --force --deep --sign - on app" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if grep -q 'codesign .*--options runtime' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no --options runtime in --adhoc-sign mode" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if grep -Fq " ${EXPECTED_DMG_29}" <(grep '^codesign .*--sign' "${MAC_STATE}/calls.log" || true); then
  echo "[FAIL] Expected no codesign --sign on DMG in --adhoc-sign mode" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
if [ ! -f "$EXPECTED_DMG_29" ]; then
  echo "[FAIL] Expected aarch64 DMG at $EXPECTED_DMG_29" >&2
  exit 1
fi
if grep -q '^xcrun ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no xcrun calls in --adhoc-sign mode" >&2
  exit 1
fi
assert_no_leaked_mounts "test 29 adhoc build"

echo "30. macos-build-signed: --allow-unsigned keeps Tauri-default build behavior"
reset_mac_state
run_with_mac_mocks "$SCRIPT_DIR/macos-build-signed.sh" --allow-unsigned >/dev/null 2>&1
if grep -q '^pnpm .*--bundles' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no --bundles flag in --allow-unsigned mode" >&2
  exit 1
fi
if grep -Eq '^codesign .*(--sign|-s) ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no codesign --sign/-s call in --allow-unsigned mode" >&2
  exit 1
fi
if grep -q '^hdiutil create ' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected no hdiutil create in --allow-unsigned mode" >&2
  exit 1
fi

echo "31. verify-macos-bundle: --require-local-signed rejects linker-signed (Info.plist=not bound) app"
reset_mac_state
APP_31="$TMP_DIR/app31/SynapseRead.app"
make_fake_app "$APP_31"
set_cs_state "$APP_31" $'Signature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nCDHash=1111111111111111111111111111111111111111\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded'
OUT_31="$TMP_DIR/out31.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_31" --require-local-signed >"$OUT_31" 2>&1; then
  echo "[FAIL] Expected --require-local-signed to reject linker-signed app" >&2
  exit 1
fi
if ! grep -Fq 'not bound' "$OUT_31"; then
  echo "[FAIL] Expected failure output to mention 'not bound':" >&2
  cat "$OUT_31" >&2
  exit 1
fi

echo "32. verify-macos-bundle: --require-adhoc-bound rejects linker-signed and local-signed apps"
reset_mac_state
APP_32="$TMP_DIR/app32/SynapseRead.app"
make_fake_app "$APP_32"
set_cs_state "$APP_32" $'Signature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nCDHash=1111111111111111111111111111111111111111\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded'
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_32" --require-adhoc-bound >/dev/null 2>&1; then
  echo "[FAIL] Expected --require-adhoc-bound to reject linker-signed app" >&2
  exit 1
fi
set_cs_state "$APP_32" $'Authority=SynapseRead Local Signing\nInfo.plist entries=20\nTeamIdentifier=not set\nCDHash=2222222222222222222222222222222222222222\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded'
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_32" --require-adhoc-bound >/dev/null 2>&1; then
  echo "[FAIL] Expected --require-adhoc-bound to reject non-adhoc local-signed app" >&2
  exit 1
fi

echo "33. verify-macos-bundle: passing more than one require flag fails"
reset_mac_state
APP_33="$TMP_DIR/app33/SynapseRead.app"
make_fake_app "$APP_33"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_33" --require-signed --require-local-signed >/dev/null 2>&1; then
  echo "[FAIL] Expected multiple --require-* flags to fail" >&2
  exit 1
fi
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_33" --require-local-signed --require-adhoc-bound >/dev/null 2>&1; then
  echo "[FAIL] Expected --require-local-signed --require-adhoc-bound to fail" >&2
  exit 1
fi

echo "34. verify-macos-bundle: --require-local-signed requires Hardened Runtime and bound Info.plist"
reset_mac_state
APP_34="$TMP_DIR/app34/SynapseRead.app"
make_fake_app "$APP_34"
set_cs_state "$APP_34" $'Authority=SynapseRead Local Signing\nInfo.plist entries=20\nTeamIdentifier=not set\nCDHash=3333333333333333333333333333333333333333\nCodeDirectory v=20500 size=1 flags=0x0(none) hashes=1+0 location=embedded'
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_34" --require-local-signed >/dev/null 2>&1; then
  echo "[FAIL] Expected --require-local-signed to fail when Hardened Runtime flag is absent" >&2
  exit 1
fi
set_cs_state "$APP_34" $'Authority=SynapseRead Local Signing\nInfo.plist entries=20\nTeamIdentifier=not set\nCDHash=3333333333333333333333333333333333333333\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded'
run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_34" --require-local-signed >/dev/null

echo "35. verify-macos-bundle: --dmg containing linker-signed inner app fails for both --require-adhoc-bound and --require-local-signed"
reset_mac_state
APP_35_OUTER="$TMP_DIR/app35_outer/SynapseRead.app"
APP_35_INNER="$TMP_DIR/app35_inner/SynapseRead.app"
DMG_35="$TMP_DIR/app35.dmg"
make_fake_app "$APP_35_OUTER" "arm64"
make_fake_app "$APP_35_INNER" "arm64"
set_cs_state "$APP_35_OUTER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
set_cs_state "$APP_35_INNER" $'Signature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nCDHash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_35" "$APP_35_INNER"
OUT_35A="$TMP_DIR/out35a.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_35_OUTER" --dmg "$DMG_35" --require-adhoc-bound >"$OUT_35A" 2>&1; then
  echo "[FAIL] Expected --require-adhoc-bound to reject DMG containing linker-signed inner app" >&2
  exit 1
fi
if ! grep -Fq 'not bound' "$OUT_35A"; then
  echo "[FAIL] Expected linker-signed DMG failure to mention 'not bound':" >&2
  cat "$OUT_35A" >&2
  exit 1
fi
assert_no_leaked_mounts "test 35 adhoc linker-signed dmg"

set_cs_state "$APP_35_OUTER" $'Authority=SynapseRead Local Signing\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=cccccccccccccccccccccccccccccccccccccccc\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded'
set_cs_state "$DMG_35" $'Authority=SynapseRead Local Signing\nSignature size=1234\nTeamIdentifier=not set\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded'
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_35_OUTER" --dmg "$DMG_35" --require-local-signed >/dev/null 2>&1; then
  echo "[FAIL] Expected --require-local-signed to reject DMG containing linker-signed inner app" >&2
  exit 1
fi
assert_no_leaked_mounts "test 35 local linker-signed dmg"

echo "36. verify-macos-bundle: rejects same-version different-build DMG (CDHash mismatch, including per-arch) and arch-mismatched DMG"
reset_mac_state
APP_36_OUTER="$TMP_DIR/app36_outer/SynapseRead.app"
APP_36_INNER="$TMP_DIR/app36_inner/SynapseRead.app"
DMG_36="$TMP_DIR/app36.dmg"
make_fake_app "$APP_36_OUTER" "x86_64 arm64"
make_fake_app "$APP_36_INNER" "x86_64 arm64"
set_cs_state "$APP_36_OUTER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=1111111111111111111111111111111111111111\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded' "arm64"
set_cs_state "$APP_36_OUTER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=2222222222222222222222222222222222222222\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded' "x86_64"
cp "${APP_36_OUTER}/.mock_codesign.dv.arm64" "${APP_36_OUTER}/.mock_codesign.dv"
set_cs_state "$APP_36_INNER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=1111111111111111111111111111111111111111\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded' "arm64"
set_cs_state "$APP_36_INNER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=9999999999999999999999999999999999999999\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded' "x86_64"
cp "${APP_36_INNER}/.mock_codesign.dv.arm64" "${APP_36_INNER}/.mock_codesign.dv"
make_fake_dmg "$DMG_36" "$APP_36_INNER"
OUT_36A="$TMP_DIR/out36a.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_36_OUTER" --dmg "$DMG_36" --require-universal --require-adhoc-bound >"$OUT_36A" 2>&1; then
  echo "[FAIL] Expected per-arch CDHash mismatch on x86_64 to fail" >&2
  exit 1
fi
if ! grep -Fq 'CDHash mismatch for architecture x86_64' "$OUT_36A"; then
  echo "[FAIL] Expected failure message for x86_64 CDHash mismatch:" >&2
  cat "$OUT_36A" >&2
  exit 1
fi
assert_no_leaked_mounts "test 36 per-arch cdhash mismatch"

APP_36_THIN="$TMP_DIR/app36_thin/SynapseRead.app"
DMG_36_THIN="$TMP_DIR/app36_thin.dmg"
make_fake_app "$APP_36_THIN" "arm64"
set_cs_state "$APP_36_THIN" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=1111111111111111111111111111111111111111\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_36_THIN" "$APP_36_THIN"
OUT_36B="$TMP_DIR/out36b.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_36_OUTER" --dmg "$DMG_36_THIN" --require-adhoc-bound >"$OUT_36B" 2>&1; then
  echo "[FAIL] Expected architecture-mismatched DMG to fail" >&2
  exit 1
fi
if ! grep -Fq 'Architecture mismatch' "$OUT_36B"; then
  echo "[FAIL] Expected architecture mismatch error:" >&2
  cat "$OUT_36B" >&2
  exit 1
fi
assert_no_leaked_mounts "test 36 arch mismatch"

echo "37. verify-macos-bundle: cleans up mount directory on attach failure, verify failure, and success"
reset_mac_state
APP_37="$TMP_DIR/app37/SynapseRead.app"
DMG_37="$TMP_DIR/app37.dmg"
make_fake_app "$APP_37" "arm64"
set_cs_state "$APP_37" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=4444444444444444444444444444444444444444\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_37" "$APP_37"
run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_37" --dmg "$DMG_37" --require-adhoc-bound >/dev/null
assert_no_leaked_mounts "test 37 success"

touch "${MAC_STATE}/attach_fail"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_37" --dmg "$DMG_37" --require-adhoc-bound >/dev/null 2>&1; then
  echo "[FAIL] Expected attach failure to fail verification" >&2
  exit 1
fi
assert_no_leaked_mounts "test 37 attach failure"

echo "38. verify-macos-bundle: normal detach fails but force detach succeeds -> passes and cleans up"
reset_mac_state
APP_38="$TMP_DIR/app38/SynapseRead.app"
DMG_38="$TMP_DIR/app38.dmg"
make_fake_app "$APP_38" "arm64"
set_cs_state "$APP_38" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=5555555555555555555555555555555555555555\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_38" "$APP_38"
touch "${MAC_STATE}/detach_normal_fail"
OUT_38="$TMP_DIR/out38.log"
run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_38" --dmg "$DMG_38" --require-adhoc-bound >"$OUT_38" 2>&1
if ! grep -Fq 'All requested macOS bundle checks passed.' "$OUT_38"; then
  echo "[FAIL] Expected success when force detach recovers cleanup:" >&2
  cat "$OUT_38" >&2
  exit 1
fi
if ! grep -q '^hdiutil detach .* -force$' "${MAC_STATE}/calls.log"; then
  echo "[FAIL] Expected fallback hdiutil detach -force call:" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi
assert_no_leaked_mounts "test 38 force detach recovery"

echo "39. verify-macos-bundle: both normal and force detach fail when main checks pass -> exits non-zero with mount point and hdiutil error"
reset_mac_state
APP_39="$TMP_DIR/app39/SynapseRead.app"
DMG_39="$TMP_DIR/app39.dmg"
make_fake_app "$APP_39" "arm64"
set_cs_state "$APP_39" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=6666666666666666666666666666666666666666\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_39" "$APP_39"
touch "${MAC_STATE}/detach_normal_fail" "${MAC_STATE}/detach_force_fail"
OUT_39="$TMP_DIR/out39.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_39" --dmg "$DMG_39" --require-adhoc-bound >"$OUT_39" 2>&1; then
  echo "[FAIL] Expected verify-macos-bundle to fail when both normal and force detach fail" >&2
  cat "$OUT_39" >&2
  exit 1
fi
if grep -Fq 'All requested macOS bundle checks passed.' "$OUT_39"; then
  echo "[FAIL] Must not print success banner when detach failed:" >&2
  cat "$OUT_39" >&2
  exit 1
fi
if ! grep -Fq 'synapseread-dmg-verify.' "$OUT_39" \
  || ! grep -Fq 'Resource busy (mocked)' "$OUT_39" \
  || ! grep -Fq 'force unmount failed' "$OUT_39"; then
  echo "[FAIL] Expected detach error output to include mount point and hdiutil error details:" >&2
  cat "$OUT_39" >&2
  exit 1
fi
if [ "$(find "${MAC_STATE}/mounted" -mindepth 1 | wc -l | tr -d ' ')" -ne 1 ]; then
  echo "[FAIL] Expected mount state to remain tracked while unmount failed" >&2
  exit 1
fi
if [ "$(grep -c '^hdiutil detach ' "${MAC_STATE}/calls.log")" -lt 4 ]; then
  echo "[FAIL] Expected EXIT trap to retry detach while DMG_MOUNTED remained true" >&2
  cat "${MAC_STATE}/calls.log" >&2
  exit 1
fi

echo "40. verify-macos-bundle: main verification failure plus detach failure preserves original error and appends cleanup failure"
reset_mac_state
APP_40_OUTER="$TMP_DIR/app40_outer/SynapseRead.app"
APP_40_INNER="$TMP_DIR/app40_inner/SynapseRead.app"
DMG_40="$TMP_DIR/app40.dmg"
make_fake_app "$APP_40_OUTER" "arm64"
make_fake_app "$APP_40_INNER" "arm64"
set_cs_state "$APP_40_OUTER" $'Signature=adhoc\nInfo.plist entries=16\nTeamIdentifier=not set\nCDHash=7777777777777777777777777777777777777777\nCodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded'
set_cs_state "$APP_40_INNER" $'Signature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nCDHash=8888888888888888888888888888888888888888\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded'
make_fake_dmg "$DMG_40" "$APP_40_INNER"
touch "${MAC_STATE}/detach_normal_fail" "${MAC_STATE}/detach_force_fail"
OUT_40="$TMP_DIR/out40.log"
if run_with_mac_mocks "$SCRIPT_DIR/verify-macos-bundle.sh" --app "$APP_40_OUTER" --dmg "$DMG_40" --require-adhoc-bound >"$OUT_40" 2>&1; then
  echo "[FAIL] Expected verify-macos-bundle to fail when both main checks and detach fail" >&2
  exit 1
fi
if ! grep -Fq 'not bound' "$OUT_40" \
  || ! grep -Fq 'synapseread-dmg-verify.' "$OUT_40" \
  || ! grep -Fq 'force unmount failed' "$OUT_40"; then
  echo "[FAIL] Expected both original validation failure and detach failure in output:" >&2
  cat "$OUT_40" >&2
  exit 1
fi
if ! grep -Eq 'Verification failed with [2-9][0-9]* error\(s\)\.' "$OUT_40"; then
  echo "[FAIL] Expected multiple errors reported (original + cleanup failure):" >&2
  cat "$OUT_40" >&2
  exit 1
fi

echo "All 40 release script regression tests passed."
