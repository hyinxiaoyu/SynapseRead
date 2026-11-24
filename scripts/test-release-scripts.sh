#!/usr/bin/env bash
set -euo pipefail

# Regression tests for scripts/release-validate.sh and scripts/release-publish-draft.sh.
# Uses a stateful mocked `gh` CLI and temporary assets directory; makes zero network calls.

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

echo "18. release-publish-draft: P1 race (last read draft, published before first write; immutable server rejects 422)"
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

echo "All 21 release script regression tests passed."
