#!/usr/bin/env bash
set -euo pipefail

# Build, sign, notarize (.app + .dmg), staple, and verify macOS bundles locally.
# Defaults to universal-apple-darwin and enforces Apple Developer ID signing
# and notarization unless --allow-unsigned is explicitly passed.

usage() {
  cat <<'EOF'
Usage: scripts/macos-build-signed.sh [options]

Options:
  --target <triple>   universal-apple-darwin (default), aarch64-apple-darwin, or x86_64-apple-darwin
  --allow-unsigned    Build without Apple signing/notarization (NOT valid for #147 Finder acceptance)
  --ci                Pass --ci and CI=true to skip bundle_dmg.sh Finder Automation
  -h, --help          Show this help message

Signing environment (required unless --allow-unsigned):
  Option 1: APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD (+ optional APPLE_SIGNING_IDENTITY)
  Option 2: APPLE_SIGNING_IDENTITY installed in macOS Keychain

Notarization environment (required unless --allow-unsigned):
  Option A: APPLE_API_KEY + APPLE_API_ISSUER (+ APPLE_API_KEY_PATH or AuthKey_<ID>.p8 in standard dir)
  Option B: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID

See docs/MACOS_SIGNING.md for full setup instructions.
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: macos-build-signed.sh must run on macOS (Darwin)." >&2
  exit 1
fi

TARGET="universal-apple-darwin"
ALLOW_UNSIGNED=false
CI_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --target requires a target triple." >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    --allow-unsigned)
      ALLOW_UNSIGNED=true
      shift
      ;;
    --ci)
      CI_MODE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  universal-apple-darwin)
    DMG_ARCH="universal"
    REQUIRED_RUST_TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin")
    ;;
  aarch64-apple-darwin)
    DMG_ARCH="aarch64"
    REQUIRED_RUST_TARGETS=("aarch64-apple-darwin")
    ;;
  x86_64-apple-darwin)
    DMG_ARCH="x64"
    REQUIRED_RUST_TARGETS=("x86_64-apple-darwin")
    ;;
  *)
    echo "Error: Unsupported --target '$TARGET'. Use universal-apple-darwin, aarch64-apple-darwin, or x86_64-apple-darwin." >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

INSTALLED_TARGETS="$(rustup target list --installed)"
MISSING_TARGETS=()
for rt in "${REQUIRED_RUST_TARGETS[@]}"; do
  if ! printf '%s\n' "$INSTALLED_TARGETS" | grep -Fxq "$rt"; then
    MISSING_TARGETS+=("$rt")
  fi
done

if [[ ${#MISSING_TARGETS[@]} -gt 0 ]]; then
  echo "Error: Missing required Rust target(s): ${MISSING_TARGETS[*]}" >&2
  echo "Install them with: rustup target add ${MISSING_TARGETS[*]}" >&2
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

validate_signing_and_notary_env() {
  local has_cert=false
  local has_cert_pass=false
  [[ -n "${APPLE_CERTIFICATE:-}" ]] && has_cert=true
  [[ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]] && has_cert_pass=true

  if [[ "$has_cert" != "$has_cert_pass" ]]; then
    echo "Error: Partial certificate signing env. Both APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD must be set together." >&2
    exit 1
  fi

  if [[ "$has_cert" == "false" ]]; then
    if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
      echo "Error: Missing signing identity. Set APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD or APPLE_SIGNING_IDENTITY (see docs/MACOS_SIGNING.md)." >&2
      exit 1
    fi
    if ! security find-identity -v -p codesigning | grep -Fq -- "$APPLE_SIGNING_IDENTITY"; then
      echo "Error: Signing identity '$APPLE_SIGNING_IDENTITY' not found in macOS Keychain." >&2
      security find-identity -v -p codesigning >&2 || true
      exit 1
    fi
  fi

  local has_api_any=false
  if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
    has_api_any=true
  fi

  local has_apple_id_any=false
  if [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
    has_apple_id_any=true
  fi

  if [[ "$has_api_any" == "true" ]]; then
    if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
      echo "Error: Partial App Store Connect API credentials. Both APPLE_API_KEY and APPLE_API_ISSUER are required." >&2
      exit 1
    fi
    local key_path=""
    if ! key_path="$(resolve_api_key_path "$APPLE_API_KEY")"; then
      echo "Error: Could not find AuthKey_${APPLE_API_KEY}.p8. Set APPLE_API_KEY_PATH or place it in ~/.appstoreconnect/private_keys/." >&2
      exit 1
    fi
    if [[ ! -f "$key_path" || ! -r "$key_path" ]]; then
      echo "Error: APPLE_API_KEY_PATH does not exist or is not readable: $key_path" >&2
      exit 1
    fi
  fi

  if [[ "$has_apple_id_any" == "true" ]]; then
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
      echo "Error: Partial Apple ID notarization credentials. APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID are all required." >&2
      exit 1
    fi
  fi

  if [[ "$has_api_any" == "false" && "$has_apple_id_any" == "false" ]]; then
    echo "Error: Missing Apple notarization credentials. Configure App Store Connect API key or Apple ID credentials (see docs/MACOS_SIGNING.md)." >&2
    exit 1
  fi
}

if [[ "$ALLOW_UNSIGNED" == "true" ]]; then
  echo "Warning: Building unsigned/ad-hoc bundle (--allow-unsigned). This artifact is NOT valid for #147 signed Finder acceptance." >&2
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
else
  validate_signing_and_notary_env
fi

read_app_version() {
  local conf_path="apps/desktop/src-tauri/tauri.conf.json"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.version' "$conf_path"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$conf_path"
  else
    plutil -extract version raw -o - "$conf_path"
  fi
}

APP_VERSION="$(read_app_version)"
if [[ -z "$APP_VERSION" ]]; then
  echo "Error: Could not determine app version from apps/desktop/src-tauri/tauri.conf.json." >&2
  exit 1
fi

BUILD_ARGS=(build --target "$TARGET")
if [[ "$CI_MODE" == "true" ]]; then
  export CI=true
  BUILD_ARGS+=(--ci)
fi

echo "Building SynapseRead v${APP_VERSION} for ${TARGET}..."
pnpm --filter @synapseread/desktop tauri "${BUILD_ARGS[@]}"

APP_PATH="target/${TARGET}/release/bundle/macos/SynapseRead.app"
DMG_PATH="target/${TARGET}/release/bundle/dmg/SynapseRead_${APP_VERSION}_${DMG_ARCH}.dmg"

if [[ "$ALLOW_UNSIGNED" == "false" ]]; then
  "$SCRIPT_DIR/macos-notarize-dmg.sh" "$DMG_PATH"
fi

VERIFY_ARGS=(--app "$APP_PATH" --dmg "$DMG_PATH")
if [[ "$TARGET" == "universal-apple-darwin" ]]; then
  VERIFY_ARGS+=(--require-universal)
fi
if [[ "$ALLOW_UNSIGNED" == "false" ]]; then
  VERIFY_ARGS+=(--require-signed)
fi

"$SCRIPT_DIR/verify-macos-bundle.sh" "${VERIFY_ARGS[@]}"

echo ""
echo "Build artifacts ready:"
echo "  App: $APP_PATH"
echo "  DMG: $DMG_PATH"
echo "  SHA-256:"
shasum -a 256 "$DMG_PATH"
