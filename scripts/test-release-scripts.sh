#!/usr/bin/env bash
set -euo pipefail

# Regression tests for scripts/release-validate.sh and scripts/release-publish-draft.sh.
# Uses a mocked `gh` CLI and temporary assets directory; makes zero network calls.

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
SHA_A="1111111111111111111111111111111111111111"
SHA_B="2222222222222222222222222222222222222222"
TAG_OBJ_SHA="3333333333333333333333333333333333333333"

printf 'fake-dmg-bytes\n' > "${ASSETS_DIR}/SynapseRead_${APP_VERSION}_universal.dmg"
printf 'fake-app-zip-bytes\n' > "${ASSETS_DIR}/SynapseRead_${APP_VERSION}_universal.app.zip"
(
  cd "$ASSETS_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "SynapseRead_${APP_VERSION}_universal.dmg" "SynapseRead_${APP_VERSION}_universal.app.zip" > SHA256SUMS.txt
  else
    sha256sum "SynapseRead_${APP_VERSION}_universal.dmg" "SynapseRead_${APP_VERSION}_universal.app.zip" > SHA256SUMS.txt
  fi
)

cat > "$MOCK_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${MOCK_GH_STATE_DIR:?}"
LOG_FILE="${STATE_DIR}/calls.log"
printf '%s\n' "$*" >> "$LOG_FILE"

subcmd="${1:-}"
shift || true

case "$subcmd" in
  api)
    method="GET"
    endpoint=""
    tag_name=""
    target_commitish=""
    draft=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --method)
          method="$2"
          shift 2
          ;;
        --paginate)
          shift
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
      POST:repos/*/releases)
        new_id=9001
        draft_bool=false
        [ "$draft" = "true" ] && draft_bool=true
        created_obj="$(jq -c -n \
          --argjson id "$new_id" \
          --arg tag "$tag_name" \
          --arg commitish "$target_commitish" \
          --argjson is_draft "$draft_bool" \
          '{id: $id, tag_name: $tag, target_commitish: $commitish, draft: $is_draft}')"
        jq -c --argjson obj "$created_obj" '. + [$obj]' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
        mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
        printf '%s\n' "$created_obj"
        exit 0
        ;;
      *)
        echo "Unexpected gh api call: ${method} ${endpoint}" >&2
        exit 1
        ;;
    esac
    ;;
  release)
    action="${1:-}"
    shift || true
    if [ "$action" = "upload" ]; then
      if [ -f "${STATE_DIR}/upload_fail_then_publish" ]; then
        rm -f "${STATE_DIR}/upload_fail_then_publish"
        jq -c 'map(.draft = false)' "${STATE_DIR}/releases.json" > "${STATE_DIR}/releases.tmp"
        mv "${STATE_DIR}/releases.tmp" "${STATE_DIR}/releases.json"
        echo "release not found" >&2
        exit 1
      fi
      if [ -f "${STATE_DIR}/upload_fail_once" ]; then
        rm -f "${STATE_DIR}/upload_fail_once"
        echo "release not found" >&2
        exit 1
      fi
      exit 0
    fi
    echo "Unexpected gh release call: ${action} $*" >&2
    exit 1
    ;;
  *)
    echo "Unexpected gh subcommand: ${subcmd}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$MOCK_BIN/gh"

export PATH="${MOCK_BIN}:$PATH"
export MOCK_GH_STATE_DIR="$STATE_DIR"
export RELEASE_UPLOAD_RETRY_DELAY=0

reset_state() {
  rm -f "${STATE_DIR}"/ref.json "${STATE_DIR}"/tag_*.json "${STATE_DIR}/upload_fail_once" "${STATE_DIR}/upload_fail_then_publish"
  printf '[]\n' > "${STATE_DIR}/releases.json"
  : > "${STATE_DIR}/calls.log"
}

assert_no_mutation_or_asset_calls() {
  local desc="$1"
  if grep -Eq 'POST|DELETE|release upload|delete-asset|/assets' "${STATE_DIR}/calls.log"; then
    echo "[FAIL] ${desc}: unexpected mutation/upload/delete gh call:" >&2
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

echo "8. release-publish-draft: new draft creation and upload"
reset_state
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
if [ "$(grep -c 'POST repos/owner/repo/releases' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected exactly 1 POST release call for new draft" >&2
  exit 1
fi
if [ "$(grep -c "^release upload ${TAG_NAME} .*--clobber" "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected exactly 1 gh release upload --clobber call for new draft" >&2
  exit 1
fi

echo "9. release-publish-draft: new draft tolerates single GraphQL draft index lag"
reset_state
touch "${STATE_DIR}/upload_fail_once"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1
if [ "$(grep -c 'POST repos/owner/repo/releases' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected exactly 1 POST release call despite upload retry" >&2
  exit 1
fi
if [ "$(grep -c "^release upload ${TAG_NAME} .*--clobber" "${STATE_DIR}/calls.log")" -ne 2 ]; then
  echo "[FAIL] Expected 2 upload attempts when first failed with release not found" >&2
  exit 1
fi

echo "10. release-publish-draft: same-commit draft rerun (with matching annotated tag)"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"tag","sha":"%s"}}\n' "$TAG_NAME" "$TAG_OBJ_SHA" > "${STATE_DIR}/ref.json"
printf '{"object":{"type":"commit","sha":"%s"}}\n' "$SHA_A" > "${STATE_DIR}/tag_${TAG_OBJ_SHA}.json"
printf '[{"id":55,"tag_name":"%s","target_commitish":"%s","draft":true}]\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/releases.json"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
if grep -q 'POST repos/owner/repo/releases' "${STATE_DIR}/calls.log"; then
  echo "[FAIL] Same-commit draft rerun must not POST a new release" >&2
  exit 1
fi
if [ "$(grep -c "^release upload ${TAG_NAME} .*--clobber" "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected 1 gh release upload --clobber call on same-commit draft rerun" >&2
  exit 1
fi

echo "11. release-publish-draft: lightweight tag pointing to different commit -> abort without upload/delete"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_B" > "${STATE_DIR}/ref.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected lightweight tag commit mismatch to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "lightweight tag mismatch"

echo "12. release-publish-draft: annotated tag pointing to different commit -> abort without upload/delete"
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

echo "13. release-publish-draft: existing draft bound to different commitish -> abort without upload/delete"
reset_state
printf '[{"id":66,"tag_name":"%s","target_commitish":"%s","draft":true}]\n' "$TAG_NAME" "$SHA_B" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected draft bound to another commit to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "draft bound to another commit"

echo "14. release-publish-draft: existing published release -> abort without upload/delete"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/ref.json"
printf '[{"id":77,"tag_name":"%s","target_commitish":"%s","draft":false}]\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected existing published release to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "existing published release"

echo "15. release-publish-draft: prefix tag array without exact ref -> treated as absent"
reset_state
printf '[{"ref":"refs/tags/%s-rc1","object":{"type":"commit","sha":"%s"}}]\n' "$TAG_NAME" "$SHA_B" > "${STATE_DIR}/ref.json"
GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null
if [ "$(grep -c 'POST repos/owner/repo/releases' "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected prefix-only ref array to allow creating draft" >&2
  exit 1
fi

echo "16. release-publish-draft: release published before upload retry -> retry aborts"
reset_state
touch "${STATE_DIR}/upload_fail_then_publish"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected retry to abort when release became published" >&2
  exit 1
fi
if [ "$(grep -c "^release upload ${TAG_NAME} .*--clobber" "${STATE_DIR}/calls.log")" -ne 1 ]; then
  echo "[FAIL] Expected retry not to invoke upload a second time after release became published" >&2
  exit 1
fi

echo "17. release-validate: fails early when published release already exists"
reset_state
printf '{"ref":"refs/tags/%s","object":{"type":"commit","sha":"%s"}}\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/ref.json"
printf '[{"id":88,"tag_name":"%s","target_commitish":"%s","draft":false}]\n' "$TAG_NAME" "$SHA_A" > "${STATE_DIR}/releases.json"
if EVENT_NAME=push REF_NAME="$TAG_NAME" GITHUB_REF="refs/tags/${TAG_NAME}" \
  GITHUB_REPOSITORY="owner/repo" BUILD_SHA="$SHA_A" \
  "$SCRIPT_DIR/release-validate.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected release-validate to fail when published release already exists" >&2
  exit 1
fi

echo "18. release-publish-draft: draft bound to branch name (main) -> abort without upload/delete"
reset_state
printf '[{"id":99,"tag_name":"%s","target_commitish":"main","draft":true}]\n' "$TAG_NAME" > "${STATE_DIR}/releases.json"
if GITHUB_REPOSITORY="owner/repo" TAG_NAME="$TAG_NAME" BUILD_SHA="$SHA_A" \
  ASSETS_DIR="$ASSETS_DIR" APP_VERSION="$APP_VERSION" \
  "$SCRIPT_DIR/release-publish-draft.sh" >/dev/null 2>&1; then
  echo "[FAIL] Expected draft bound to branch name to fail" >&2
  exit 1
fi
assert_no_mutation_or_asset_calls "draft bound to branch name"

echo "All 18 release script regression tests passed."
