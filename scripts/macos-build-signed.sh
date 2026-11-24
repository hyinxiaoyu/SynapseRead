#!/usr/bin/env bash
set -euo pipefail

# Build, sign, optionally notarize (.app + .dmg), and verify macOS bundles locally.
# Defaults to universal-apple-darwin and enforces Apple Developer ID signing
# and notarization unless --local-sign, --adhoc-sign, or --allow-unsigned is passed.

usage() {
  cat <<'EOF'
Usage: scripts/macos-build-signed.sh [options]

Options:
  --target <triple>      universal-apple-darwin (default), aarch64-apple-darwin, or x86_64-apple-darwin
  --local-sign <id>      Sign with a local Keychain Code Signing certificate (no notarization; valid for #147)
  --adhoc-sign           Ad hoc sign (-) binding Info.plist (no certificate/notarization; valid for #147)
  --allow-unsigned       Build Tauri-default linker-signed bundle without binding Info.plist (NOT valid for #147)
  --ci                   Pass --ci and CI=true to skip bundle_dmg.sh Finder Automation
  -h, --help             Show this help message

Signing environment (required for default Developer ID mode):
  Option 1: APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD (+ optional APPLE_SIGNING_IDENTITY)
  Option 2: APPLE_SIGNING_IDENTITY installed in macOS Keychain

Notarization environment (required for default Developer ID mode):
  Option A: APPLE_API_KEY + APPLE_API_ISSUER (+ APPLE_API_KEY_PATH or AuthKey_<ID>.p8 in standard dir)
  Option B: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID

See docs/MACOS_SIGNING.md for full setup instructions (including self-use --local-sign / --adhoc-sign).
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: macos-build-signed.sh must run on macOS (Darwin)." >&2
  exit 1
fi

TARGET="universal-apple-darwin"
SIGN_MODE="developer-id"
LOCAL_SIGN_IDENTITY=""
CI_MODE=false

set_sign_mode() {
  local mode="$1"
  if [[ "$SIGN_MODE" != "developer-id" ]]; then
    echo "Error: --allow-unsigned, --local-sign, and --adhoc-sign are mutually exclusive." >&2
    exit 1
  fi
  SIGN_MODE="$mode"
}

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
    --local-sign)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "Error: --local-sign requires a non-empty Keychain signing identity." >&2
        exit 1
      fi
      if [[ "$2" == "-" ]]; then
        echo "Error: '--local-sign -' is not valid; use --adhoc-sign for an ad hoc build." >&2
        exit 1
      fi
      set_sign_mode "local"
      LOCAL_SIGN_IDENTITY="$2"
      shift 2
      ;;
    --adhoc-sign)
      set_sign_mode "adhoc"
      shift
      ;;
    --allow-unsigned)
      set_sign_mode "unsigned"
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

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
DMG_STAGING_DIR=""

cleanup_dmg_staging() {
  if [[ -n "${DMG_STAGING_DIR:-}" && -d "$DMG_STAGING_DIR" ]]; then
    rm -rf "$DMG_STAGING_DIR"
  fi
}
trap cleanup_dmg_staging EXIT

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

unset_apple_env() {
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
}

case "$SIGN_MODE" in
  developer-id)
    validate_signing_and_notary_env
    ;;
  unsigned)
    echo "Warning: Building Tauri-default linker-signed bundle (--allow-unsigned; Info.plist not bound). Not valid for #147 Finder acceptance — use --local-sign <identity> or --adhoc-sign (ADR 0008 OD-2 Rev 2)." >&2
    unset_apple_env
    ;;
  local)
    unset_apple_env
    IDENTITIES_OUTPUT="$(security find-identity -v -p codesigning 2>&1 || true)"
    if ! printf '%s\n' "$IDENTITIES_OUTPUT" | grep -Fq -- "$LOCAL_SIGN_IDENTITY"; then
      echo "Error: Signing identity '$LOCAL_SIGN_IDENTITY' not found in macOS Keychain." >&2
      printf '%s\n' "$IDENTITIES_OUTPUT" >&2
      echo "Hint: create/trust a Code Signing certificate (Keychain Access → Certificate Assistant → Create a Certificate…; set Trust → Code Signing: Always Trust) — see docs/MACOS_SIGNING.md." >&2
      exit 1
    fi
    echo "Local self-signed build (no notarization) using identity: ${LOCAL_SIGN_IDENTITY}"
    ;;
  adhoc)
    unset_apple_env
    echo "Ad hoc bound build (no certificate or notarization; Info.plist will be bound)."
    ;;
esac

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

create_dmg_from_app() {
  local app_path="$1"
  local dmg_path="$2"

  DMG_STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synapseread-dmg.XXXXXX")"
  ditto "$app_path" "$DMG_STAGING_DIR/SynapseRead.app"
  ln -s /Applications "$DMG_STAGING_DIR/Applications"

  mkdir -p "$(dirname "$dmg_path")"
  rm -f "$dmg_path"
  hdiutil create -volname "SynapseRead" -srcfolder "$DMG_STAGING_DIR" -fs HFS+ -format UDZO -ov "$dmg_path"

  rm -rf "$DMG_STAGING_DIR"
  DMG_STAGING_DIR=""
}

APP_VERSION="$(read_app_version)"
if [[ -z "$APP_VERSION" ]]; then
  echo "Error: Could not determine app version from apps/desktop/src-tauri/tauri.conf.json." >&2
  exit 1
fi

BUILD_ARGS=(build --target "$TARGET")
if [[ "$SIGN_MODE" == "local" || "$SIGN_MODE" == "adhoc" ]]; then
  # Build only .app in Tauri so we can sign SynapseRead.app before packaging the DMG.
  BUILD_ARGS+=(--bundles app)
fi
if [[ "$CI_MODE" == "true" ]]; then
  export CI=true
  BUILD_ARGS+=(--ci)
fi

echo "Building SynapseRead v${APP_VERSION} for ${TARGET}..."
pnpm --filter @synapseread/desktop tauri "${BUILD_ARGS[@]}"

APP_PATH="${TARGET_DIR}/${TARGET}/release/bundle/macos/SynapseRead.app"
DMG_PATH="${TARGET_DIR}/${TARGET}/release/bundle/dmg/SynapseRead_${APP_VERSION}_${DMG_ARCH}.dmg"

case "$SIGN_MODE" in
  developer-id)
    "$SCRIPT_DIR/macos-notarize-dmg.sh" "$DMG_PATH"
    ;;
  local)
    # --timestamp=none keeps local builds offline and deterministic, because the Apple timestamp service is meant for Developer ID.
    codesign --force --deep --options runtime --timestamp=none --sign "$LOCAL_SIGN_IDENTITY" "$APP_PATH"
    create_dmg_from_app "$APP_PATH" "$DMG_PATH"
    codesign --force --timestamp=none --sign "$LOCAL_SIGN_IDENTITY" "$DMG_PATH"
    ;;
  adhoc)
    codesign --force --deep --sign - "$APP_PATH"
    create_dmg_from_app "$APP_PATH" "$DMG_PATH"
    ;;
  unsigned)
    ;;
esac

VERIFY_ARGS=(--app "$APP_PATH" --dmg "$DMG_PATH")
if [[ "$TARGET" == "universal-apple-darwin" ]]; then
  VERIFY_ARGS+=(--require-universal)
fi
case "$SIGN_MODE" in
  developer-id)
    VERIFY_ARGS+=(--require-signed)
    ;;
  local)
    VERIFY_ARGS+=(--require-local-signed)
    ;;
  adhoc)
    VERIFY_ARGS+=(--require-adhoc-bound)
    ;;
  unsigned)
    ;;
esac

"$SCRIPT_DIR/verify-macos-bundle.sh" "${VERIFY_ARGS[@]}"

echo ""
echo "Build artifacts ready:"
echo "  App: $APP_PATH"
echo "  DMG: $DMG_PATH"
echo "  SHA-256:"
shasum -a 256 "$DMG_PATH"
