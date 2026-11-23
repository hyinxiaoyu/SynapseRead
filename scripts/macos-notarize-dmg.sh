#!/usr/bin/env bash
set -euo pipefail

# Notarize, staple, and validate a signed macOS .dmg bundle.
# Tauri v2 notarizes and staples the .app bundle and signs the .dmg,
# so the .dmg itself must be submitted and stapled separately.

usage() {
  cat <<'EOF'
Usage: scripts/macos-notarize-dmg.sh <path-to-dmg>

Requires either:
  Option A (App Store Connect API Key):
    APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_PATH
    (or AuthKey_<APPLE_API_KEY>.p8 in ./private_keys, ~/private_keys,
    ~/.private_keys, or ~/.appstoreconnect/private_keys)
  Option B (Apple ID):
    APPLE_ID, APPLE_PASSWORD (app-specific password), and APPLE_TEAM_ID

See docs/MACOS_SIGNING.md for credential setup details.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: macos-notarize-dmg.sh must run on macOS (Darwin)." >&2
  exit 1
fi

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  usage >&2
  exit 1
fi

DMG_PATH="$1"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Error: DMG file not found: $DMG_PATH" >&2
  exit 1
fi

if [[ "$DMG_PATH" != *.dmg ]]; then
  echo "Error: Expected a .dmg file path, got: $DMG_PATH" >&2
  exit 1
fi

resolve_api_key_path() {
  local key_id="$1"
  local file_name="AuthKey_${key_id}.p8"
  local candidate=""

  if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
    printf '%s' "$APPLE_API_KEY_PATH"
    return 0
  fi

  local search_dirs=(
    "./private_keys"
    "$HOME/private_keys"
    "$HOME/.private_keys"
    "$HOME/.appstoreconnect/private_keys"
  )

  local dir
  for dir in "${search_dirs[@]}"; do
    candidate="${dir}/${file_name}"
    if [[ -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  return 1
}

parse_json_field() {
  local json_input="$1"
  local field="$2"

  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json_input" | jq -r --arg k "$field" '.[$k] // empty' 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json_input" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(sys.argv[1], '') or '')" "$field" 2>/dev/null || true
  else
    plutil -extract "$field" raw -o - - <<< "$json_input" 2>/dev/null || true
  fi
}

AUTH_ARGS=()
HAS_API_ANY=false
if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
  HAS_API_ANY=true
fi

HAS_APPLE_ID_ANY=false
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
  HAS_APPLE_ID_ANY=true
fi

if [[ "$HAS_API_ANY" == "true" ]]; then
  if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
    echo "Error: Partial App Store Connect API credentials. Set both APPLE_API_KEY and APPLE_API_ISSUER (see docs/MACOS_SIGNING.md)." >&2
    exit 1
  fi
  KEY_PATH=""
  if ! KEY_PATH="$(resolve_api_key_path "$APPLE_API_KEY")"; then
    echo "Error: Could not locate AuthKey_${APPLE_API_KEY}.p8. Set APPLE_API_KEY_PATH or place it in ~/.appstoreconnect/private_keys/ (see docs/MACOS_SIGNING.md)." >&2
    exit 1
  fi
  if [[ ! -f "$KEY_PATH" || ! -r "$KEY_PATH" ]]; then
    echo "Error: Notarization API key file is missing or unreadable: $KEY_PATH" >&2
    exit 1
  fi
  AUTH_ARGS=(--key "$KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [[ "$HAS_APPLE_ID_ANY" == "true" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "Error: Partial Apple ID notarization credentials. Set APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID (see docs/MACOS_SIGNING.md)." >&2
    exit 1
  fi
  AUTH_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  echo "Error: Missing Apple notarization credentials. Configure App Store Connect API key or Apple ID credentials per docs/MACOS_SIGNING.md." >&2
  exit 1
fi

echo "Submitting DMG to Apple notary service: $DMG_PATH"
set +e
SUBMIT_JSON="$(xcrun notarytool submit "$DMG_PATH" "${AUTH_ARGS[@]}" --wait --output-format json)"
SUBMIT_EXIT=$?
set -e

if [[ -z "$SUBMIT_JSON" ]]; then
  echo "Error: xcrun notarytool submit returned empty output (exit code: $SUBMIT_EXIT)." >&2
  exit 1
fi

STATUS="$(parse_json_field "$SUBMIT_JSON" "status")"
SUBMISSION_ID="$(parse_json_field "$SUBMIT_JSON" "id")"

if [[ "$SUBMIT_EXIT" -ne 0 || "$STATUS" != "Accepted" ]]; then
  echo "Error: DMG notarization failed (exit=$SUBMIT_EXIT, status=${STATUS:-unknown}, id=${SUBMISSION_ID:-unknown})." >&2
  if [[ -n "$SUBMISSION_ID" ]]; then
    echo "Fetching notarization log for submission $SUBMISSION_ID..." >&2
    xcrun notarytool log "$SUBMISSION_ID" "${AUTH_ARGS[@]}" >&2 || true
  fi
  exit 1
fi

echo "Notarization accepted (submission id: ${SUBMISSION_ID:-unknown}). Stapling DMG..."
xcrun stapler staple -v "$DMG_PATH"
xcrun stapler validate -v "$DMG_PATH"
echo "DMG notarized and stapled successfully: $DMG_PATH"
