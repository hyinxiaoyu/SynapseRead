#!/usr/bin/env bash
set -euo pipefail

# Create or update a draft GitHub Release for a single commit SHA and tag,
# verifying tag target, draft target_commitish, non-published status, and
# asset checksums immediately before upload.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/release-state.sh
. "$SCRIPT_DIR/lib/release-state.sh"

require_non_empty() {
  local name="$1"
  local value="${2:-}"
  if [ -z "$value" ]; then
    echo "Error: Missing required environment variable ${name}." >&2
    exit 1
  fi
}

require_non_empty "GITHUB_REPOSITORY" "${GITHUB_REPOSITORY:-}"
require_non_empty "TAG_NAME" "${TAG_NAME:-}"
require_non_empty "BUILD_SHA" "${BUILD_SHA:-}"
require_non_empty "ASSETS_DIR" "${ASSETS_DIR:-}"
require_non_empty "APP_VERSION" "${APP_VERSION:-}"

if ! printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "Error: Expected 40-character commit SHA for BUILD_SHA, got '${BUILD_SHA}'." >&2
  exit 1
fi

case "$TAG_NAME" in
  *[[:space:]]*|*/*)
    echo "Error: Release tag '${TAG_NAME}' contains invalid characters." >&2
    exit 1
    ;;
  v*) ;;
  *)
    echo "Error: Release tag '${TAG_NAME}' must start with 'v'." >&2
    exit 1
    ;;
esac

if [ "${TAG_NAME#v}" != "$APP_VERSION" ]; then
  echo "Error: Tag '${TAG_NAME}' does not match APP_VERSION '${APP_VERSION}'." >&2
  exit 1
fi

DMG_OUT="SynapseRead_${APP_VERSION}_universal.dmg"
APP_ZIP_OUT="SynapseRead_${APP_VERSION}_universal.app.zip"
SUMS_OUT="SHA256SUMS.txt"

for asset in "$DMG_OUT" "$APP_ZIP_OUT" "$SUMS_OUT"; do
  if [ ! -f "${ASSETS_DIR}/${asset}" ]; then
    echo "Error: Expected release asset not found: ${ASSETS_DIR}/${asset}" >&2
    exit 1
  fi
done

(
  cd "$ASSETS_DIR"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$SUMS_OUT"
  else
    sha256sum -c "$SUMS_OUT"
  fi
)

existing_draft_id="$(check_release_target_state "$GITHUB_REPOSITORY" "$TAG_NAME" "$BUILD_SHA")"

if [ -z "$existing_draft_id" ]; then
  echo "Creating draft release ${TAG_NAME} for commit ${BUILD_SHA}..."
  created_json="$(gh api --method POST "repos/${GITHUB_REPOSITORY}/releases" \
    -f tag_name="$TAG_NAME" \
    -f target_commitish="$BUILD_SHA" \
    -f name="SynapseRead ${TAG_NAME}" \
    -F draft=true \
    -F prerelease=false \
    -F generate_release_notes=true)"

  created_id="$(printf '%s' "$created_json" | jq -r '.id // empty')"
  created_draft="$(printf '%s' "$created_json" | jq -r 'if .draft == true then "true" else "false" end')"
  created_commitish="$(printf '%s' "$created_json" | jq -r '.target_commitish // empty')"
  if [ -z "$created_id" ] || [ "$created_draft" != "true" ] || [ "$created_commitish" != "$BUILD_SHA" ]; then
    echo "Error: Newly created release did not match expected draft/commit state (id=${created_id}, draft=${created_draft}, target_commitish=${created_commitish})." >&2
    exit 1
  fi
else
  echo "Reusing existing draft release id=${existing_draft_id} for ${TAG_NAME} at commit ${BUILD_SHA}..."
fi

upload_err_file="$(mktemp)"
cleanup_err_file() {
  rm -f "$upload_err_file"
}
trap cleanup_err_file EXIT

for attempt in 1 2 3; do
  # Re-verify remote tag and release state immediately before every upload/clobber.
  verified_draft_id="$(check_release_target_state "$GITHUB_REPOSITORY" "$TAG_NAME" "$BUILD_SHA")"
  if [ -z "$verified_draft_id" ]; then
    echo "Error: Draft release for '${TAG_NAME}' was not found during pre-upload verification." >&2
    exit 1
  fi

  set +e
  gh release upload "$TAG_NAME" \
    "${ASSETS_DIR}/${DMG_OUT}" \
    "${ASSETS_DIR}/${APP_ZIP_OUT}" \
    "${ASSETS_DIR}/${SUMS_OUT}" \
    --clobber 2>"$upload_err_file"
  upload_rc=$?
  set -e

  if [ "$upload_rc" -eq 0 ]; then
    echo "Uploaded assets to draft release id=${verified_draft_id} (${TAG_NAME})."
    exit 0
  fi

  upload_err="$(cat "$upload_err_file")"
  printf '%s\n' "$upload_err" >&2

  # Retry briefly only when GitHub's GraphQL draft index lags immediately after creation.
  if [ "$attempt" -lt 3 ] && printf '%s' "$upload_err" | grep -qi "release not found"; then
    sleep "${RELEASE_UPLOAD_RETRY_DELAY:-3}"
    continue
  fi

  echo "Error: Failed to upload assets to release '${TAG_NAME}'." >&2
  exit 1
done
