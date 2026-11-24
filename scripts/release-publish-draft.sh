#!/usr/bin/env bash
set -euo pipefail

# Create or update a draft GitHub Release for a single commit SHA and tag.
# Validates all expected assets before any write, uploads only missing assets
# directly to the verified Release ID's upload_url without --clobber or asset
# deletion, skips assets whose SHA-256 digest already matches, and reports
# actionable diagnostics on digest mismatch, incomplete 'starter' assets, or
# non-draft state.

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

asset_content_type() {
  case "$1" in
    *.dmg) printf 'application/x-apple-diskimage' ;;
    *.zip) printf 'application/zip' ;;
    *.txt) printf 'text/plain; charset=utf-8' ;;
    *) printf 'application/octet-stream' ;;
  esac
}

list_release_assets_json() {
  local repo="$1"
  local release_id="$2"
  local release_json="$3"

  local embedded_count=0
  embedded_count="$(printf '%s' "$release_json" | jq '(.assets // []) | length')"
  if [ "$embedded_count" -lt 30 ]; then
    printf '%s' "$release_json" | jq -c '.assets // []'
    return 0
  fi

  gh api --paginate "repos/${repo}/releases/${release_id}/assets" \
    | jq -c -n '[inputs | .[]?]'
}

# Inspect remote asset state for a single expected asset name and digest.
# Prints "skip" or "upload" on stdout; exits non-zero with clear diagnostics
# on duplicate assets, 'starter' placeholders, incomplete states, or digest mismatch.
classify_remote_asset() {
  local repo="$1"
  local release_id="$2"
  local assets_json="$3"
  local asset_name="$4"
  local expected_digest="$5"

  local matching_assets=""
  local matching_count=0
  matching_assets="$(printf '%s' "$assets_json" | jq -c --arg name "$asset_name" '[.[] | select(.name == $name)]')"
  matching_count="$(printf '%s' "$matching_assets" | jq 'length')"

  if [ "$matching_count" -gt 1 ]; then
    echo "Error: Found multiple assets named '${asset_name}' on draft release id=${release_id}." >&2
    return 1
  fi

  if [ "$matching_count" -eq 0 ]; then
    printf 'upload'
    return 0
  fi

  local asset_id=""
  local remote_state=""
  local remote_digest=""
  local remote_size=""
  asset_id="$(printf '%s' "$matching_assets" | jq -r '.[0].id // empty')"
  remote_state="$(printf '%s' "$matching_assets" | jq -r '.[0].state // empty')"
  remote_digest="$(printf '%s' "$matching_assets" | jq -r '.[0].digest // empty')"
  remote_size="$(printf '%s' "$matching_assets" | jq -r '.[0].size // "unknown"')"

  if [ "$remote_state" = "starter" ]; then
    echo "Error: Asset '${asset_name}' on draft release id=${release_id} is stuck in incomplete 'starter' state (asset id=${asset_id:-unknown}, size=${remote_size}), typically left after a failed upload (such as HTTP 502). Refusing to auto-delete; confirm the release is still a draft, manually remove asset id=${asset_id:-unknown} (for example: gh api --method DELETE repos/${repo}/releases/assets/${asset_id:-<asset-id>}), and rerun with the original build artifacts (see docs/MACOS_SIGNING.md)." >&2
    return 1
  fi

  if [ "$remote_state" != "uploaded" ]; then
    echo "Error: Asset '${asset_name}' on draft release id=${release_id} (asset id=${asset_id:-unknown}) is in unexpected state '${remote_state}'; refusing to delete or overwrite." >&2
    return 1
  fi

  if [ "$remote_digest" = "$expected_digest" ]; then
    printf 'skip'
    return 0
  fi

  echo "Error: Asset '${asset_name}' already exists on draft release id=${release_id} (asset id=${asset_id:-unknown}) with different or unverified digest (digest='${remote_digest:-none}', expected='${expected_digest}'); refusing to delete or overwrite." >&2
  return 1
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
  if ! printf '%s' "$asset" | grep -Eq '^[A-Za-z0-9._-]+$'; then
    echo "Error: Unsafe release asset name '${asset}'." >&2
    exit 1
  fi
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

DMG_DIGEST="sha256:$(compute_file_sha256 "${ASSETS_DIR}/${DMG_OUT}")"
APP_ZIP_DIGEST="sha256:$(compute_file_sha256 "${ASSETS_DIR}/${APP_ZIP_OUT}")"
SUMS_DIGEST="sha256:$(compute_file_sha256 "${ASSETS_DIR}/${SUMS_OUT}")"

expected_digest_for_asset() {
  case "$1" in
    "$DMG_OUT") printf '%s' "$DMG_DIGEST" ;;
    "$APP_ZIP_OUT") printf '%s' "$APP_ZIP_DIGEST" ;;
    "$SUMS_OUT") printf '%s' "$SUMS_DIGEST" ;;
    *)
      echo "Error: Unexpected asset '$1'." >&2
      return 1
      ;;
  esac
}

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
  verified_draft_id="$created_id"
else
  echo "Reusing existing draft release id=${existing_draft_id} for ${TAG_NAME} at commit ${BUILD_SHA}..."
  verified_draft_id="$existing_draft_id"
fi

# Preflight all three expected assets before writing any asset so a conflict on a
# later asset (.app.zip or SHA256SUMS.txt) aborts with zero upload writes.
preflight_release_json="$(fetch_verified_draft_release_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$TAG_NAME" "$BUILD_SHA")"
preflight_assets_json="$(list_release_assets_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$preflight_release_json")"
for asset in "$DMG_OUT" "$APP_ZIP_OUT" "$SUMS_OUT"; do
  expected_digest="$(expected_digest_for_asset "$asset")"
  classify_remote_asset "$GITHUB_REPOSITORY" "$verified_draft_id" "$preflight_assets_json" "$asset" "$expected_digest" >/dev/null
done

upload_err_file="$(mktemp)"
cleanup_err_file() {
  rm -f "$upload_err_file"
}
trap cleanup_err_file EXIT

for asset in "$DMG_OUT" "$APP_ZIP_OUT" "$SUMS_OUT"; do
  asset_path="${ASSETS_DIR}/${asset}"
  expected_digest="$(expected_digest_for_asset "$asset")"
  content_type="$(asset_content_type "$asset")"

  attempt=1
  while [ "$attempt" -le 2 ]; do
    release_json="$(fetch_verified_draft_release_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$TAG_NAME" "$BUILD_SHA")"
    upload_url="$(printf '%s' "$release_json" | jq -r '.upload_url')"
    upload_base="${upload_url%%\{*}"
    assets_json="$(list_release_assets_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$release_json")"

    action="$(classify_remote_asset "$GITHUB_REPOSITORY" "$verified_draft_id" "$assets_json" "$asset" "$expected_digest")"
    if [ "$action" = "skip" ]; then
      echo "Skipping '${asset}': already uploaded on draft id=${verified_draft_id} with matching digest (${expected_digest})."
      break
    fi

    echo "Uploading '${asset}' to draft release id=${verified_draft_id}..."
    set +e
    upload_resp="$(gh api --method POST "${upload_base}?name=${asset}" \
      -H "Content-Type: ${content_type}" \
      --input "$asset_path" 2>"$upload_err_file")"
    upload_rc=$?
    set -e

    if [ "$upload_rc" -eq 0 ]; then
      uploaded_digest="$(printf '%s' "$upload_resp" | jq -r '.digest // empty' 2>/dev/null || true)"
      if [ -n "$uploaded_digest" ] && [ "$uploaded_digest" != "$expected_digest" ]; then
        echo "Error: Uploaded asset '${asset}' returned unexpected digest '${uploaded_digest}', expected '${expected_digest}'." >&2
        exit 1
      fi
      break
    fi

    upload_err="$(cat "$upload_err_file")"
    printf '%s\n' "$upload_err" >&2

    # Retry once only on transient 5xx server failures; the next loop iteration
    # re-checks draft state and rejects any leftover 'starter' placeholder asset
    # instead of blind-retrying into 422 already_exists.
    if [ "$attempt" -eq 1 ] && printf '%s' "$upload_err" | grep -Eq 'HTTP 5[0-9]{2}'; then
      attempt=$((attempt + 1))
      sleep "${RELEASE_UPLOAD_RETRY_DELAY:-3}"
      continue
    fi

    echo "Error: Failed to upload asset '${asset}' to release id=${verified_draft_id}." >&2
    exit 1
  done
done

# Post-upload verification ensures the release stayed a draft bound to BUILD_SHA
# throughout the upload sequence (even on repositories without Release immutability).
fetch_verified_draft_release_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$TAG_NAME" "$BUILD_SHA" >/dev/null
echo "Draft release id=${verified_draft_id} (${TAG_NAME}) verified with all assets."
