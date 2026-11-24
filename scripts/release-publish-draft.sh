#!/usr/bin/env bash
set -euo pipefail

# Create or update a draft GitHub Release for a single commit SHA and tag.
# Uploads only missing assets directly to the verified Release ID's upload_url
# without --clobber or asset deletion, skips assets whose SHA-256 digest
# already matches, and fails immediately on digest mismatch or non-draft state.

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

upload_err_file="$(mktemp)"
cleanup_err_file() {
  rm -f "$upload_err_file"
}
trap cleanup_err_file EXIT

for asset in "$DMG_OUT" "$APP_ZIP_OUT" "$SUMS_OUT"; do
  asset_path="${ASSETS_DIR}/${asset}"
  local_sha256="$(compute_file_sha256 "$asset_path")"
  expected_digest="sha256:${local_sha256}"
  content_type="$(asset_content_type "$asset")"

  attempt=1
  while [ "$attempt" -le 2 ]; do
    release_json="$(fetch_verified_draft_release_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$TAG_NAME" "$BUILD_SHA")"
    upload_url="$(printf '%s' "$release_json" | jq -r '.upload_url')"
    upload_base="${upload_url%%\{*}"
    assets_json="$(list_release_assets_json "$GITHUB_REPOSITORY" "$verified_draft_id" "$release_json")"

    matching_assets="$(printf '%s' "$assets_json" | jq -c --arg name "$asset" '[.[] | select(.name == $name)]')"
    matching_count="$(printf '%s' "$matching_assets" | jq 'length')"

    if [ "$matching_count" -gt 1 ]; then
      echo "Error: Found multiple assets named '${asset}' on release id=${verified_draft_id}." >&2
      exit 1
    fi

    if [ "$matching_count" -eq 1 ]; then
      remote_state="$(printf '%s' "$matching_assets" | jq -r '.[0].state // empty')"
      remote_digest="$(printf '%s' "$matching_assets" | jq -r '.[0].digest // empty')"
      if [ "$remote_state" = "uploaded" ] && [ "$remote_digest" = "$expected_digest" ]; then
        echo "Skipping '${asset}': already uploaded on draft id=${verified_draft_id} with matching digest (${remote_digest})."
        break
      fi
      echo "Error: Asset '${asset}' already exists on release id=${verified_draft_id} with different or unverified digest (state='${remote_state}', digest='${remote_digest:-none}', expected='${expected_digest}'); refusing to delete or overwrite." >&2
      exit 1
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

    # Retry once only on transient 5xx server failures; never retry 4xx (such as
    # 422 already_exists or immutable-release rejections).
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
