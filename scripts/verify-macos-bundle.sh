#!/usr/bin/env bash
set -euo pipefail

# Verify macOS .app and optional .dmg bundles for architecture, Info.plist
# invariants (T-44 / UA-6), DMG integrity, Developer ID signing, Hardened
# Runtime, Gatekeeper acceptance, and stapled notarization tickets.

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-bundle.sh --app <path-to-SynapseRead.app> [options]

Options:
  --app <path>          Path to SynapseRead.app bundle (required)
  --dmg <path>          Path to SynapseRead_*.dmg image (optional)
  --require-universal   Assert main executable contains both arm64 and x86_64 slices
  --require-signed      Assert Apple Developer ID signing, Hardened Runtime, spctl, and stapler
  -h, --help            Show this help message
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: verify-macos-bundle.sh must run on macOS (Darwin)." >&2
  exit 1
fi

APP_PATH=""
DMG_PATH=""
REQUIRE_UNIVERSAL=false
REQUIRE_SIGNED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --app requires a path argument." >&2
        exit 1
      fi
      APP_PATH="$2"
      shift 2
      ;;
    --dmg)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --dmg requires a path argument." >&2
        exit 1
      fi
      DMG_PATH="$2"
      shift 2
      ;;
    --require-universal)
      REQUIRE_UNIVERSAL=true
      shift
      ;;
    --require-signed)
      REQUIRE_SIGNED=true
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

if [[ -z "$APP_PATH" ]]; then
  echo "Error: --app is required." >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" || "$APP_PATH" != *.app ]]; then
  echo "Error: App bundle directory not found or does not end in .app: $APP_PATH" >&2
  exit 1
fi

if [[ -n "$DMG_PATH" && ! -f "$DMG_PATH" ]]; then
  echo "Error: DMG file not found: $DMG_PATH" >&2
  exit 1
fi

FAILURES=0

pass() {
  echo "[PASS] $1"
}

fail() {
  echo "[FAIL] $1" >&2
  FAILURES=$((FAILURES + 1))
}

skip() {
  echo "[SKIP] $1"
}

BIN_PATH="$APP_PATH/Contents/MacOS/synapseread-desktop"
if [[ -x "$BIN_PATH" ]]; then
  pass "Executable exists: $BIN_PATH"
else
  fail "Executable missing or not executable: $BIN_PATH"
fi

if [[ -x "$BIN_PATH" ]]; then
  RAW_ARCHS="$(lipo -archs "$BIN_PATH" 2>/dev/null || true)"
  echo "[INFO] Detected architectures: ${RAW_ARCHS:-unknown}"
  if [[ "$REQUIRE_UNIVERSAL" == "true" ]]; then
    NORM_ARCHS=" $(printf '%s' "$RAW_ARCHS" | tr -s '[:space:]' ' ') "
    if [[ "$NORM_ARCHS" == *" arm64 "* && "$NORM_ARCHS" == *" x86_64 "* ]]; then
      pass "Universal binary contains arm64 and x86_64 slices"
    else
      fail "Expected universal binary with arm64 and x86_64 slices, got: ${RAW_ARCHS:-none}"
    fi
  fi
fi

PLIST_PATH="$APP_PATH/Contents/Info.plist"
if [[ ! -f "$PLIST_PATH" ]]; then
  fail "Info.plist missing: $PLIST_PATH"
else
  if plutil -lint "$PLIST_PATH" >/dev/null 2>&1; then
    pass "Info.plist syntax valid"
  else
    fail "Info.plist failed plutil -lint"
  fi

  BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$PLIST_PATH" 2>/dev/null || true)"
  if [[ "$BUNDLE_ID" == "app.synapseread.desktop" ]]; then
    pass "CFBundleIdentifier is app.synapseread.desktop"
  else
    fail "Unexpected CFBundleIdentifier: ${BUNDLE_ID:-missing} (expected app.synapseread.desktop)"
  fi

  LOCAL_NET_DESC="$(plutil -extract NSLocalNetworkUsageDescription raw -o - "$PLIST_PATH" 2>/dev/null || true)"
  if [[ -n "$LOCAL_NET_DESC" ]]; then
    pass "Info.plist declares NSLocalNetworkUsageDescription (T-44 / UA-6)"
  else
    fail "Info.plist missing or empty NSLocalNetworkUsageDescription"
  fi

  if plutil -p "$PLIST_PATH" 2>/dev/null | grep -q "NSBonjourServices" \
    || plutil -extract NSBonjourServices raw -o - "$PLIST_PATH" >/dev/null 2>&1; then
    fail "Info.plist must not declare NSBonjourServices"
  else
    pass "Info.plist omits NSBonjourServices"
  fi
fi

if [[ -n "$DMG_PATH" ]]; then
  if hdiutil verify "$DMG_PATH" >/dev/null 2>&1; then
    pass "DMG image verified with hdiutil verify"
  else
    fail "hdiutil verify failed for $DMG_PATH"
  fi
fi

APP_CS="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"

if [[ "$REQUIRE_SIGNED" == "true" ]]; then
  if codesign --verify --deep --strict --verbose=2 "$APP_PATH" >/dev/null 2>&1; then
    pass "App bundle passed codesign --verify --deep --strict"
  else
    fail "App bundle failed codesign --verify --deep --strict"
  fi

  if printf '%s\n' "$APP_CS" | grep -Eq '^Signature=adhoc$'; then
    fail "App bundle is ad-hoc signed; Apple Developer ID signature required"
  else
    pass "App bundle is not ad-hoc signed"
  fi

  if printf '%s\n' "$APP_CS" | grep -Eq '^Authority=Developer ID Application:'; then
    pass "App bundle has Developer ID Application authority"
  else
    fail "App bundle missing Developer ID Application authority"
  fi

  if printf '%s\n' "$APP_CS" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-fA-F]+\([^)]*runtime[^)]*\)'; then
    pass "App bundle has Hardened Runtime enabled"
  else
    fail "App bundle missing Hardened Runtime flag"
  fi

  if printf '%s\n' "$APP_CS" | grep -Eq '^TeamIdentifier=not set$'; then
    fail "App bundle TeamIdentifier is not set"
  elif printf '%s\n' "$APP_CS" | grep -Eq '^TeamIdentifier=[A-Z0-9]{10}$'; then
    pass "App bundle has valid 10-character TeamIdentifier"
  else
    fail "App bundle missing valid 10-character TeamIdentifier"
  fi

  if spctl --assess --type execute --verbose=4 "$APP_PATH" >/dev/null 2>&1; then
    pass "App bundle accepted by Gatekeeper (spctl --assess --type execute)"
  else
    fail "App bundle rejected by Gatekeeper (spctl --assess --type execute)"
  fi

  if xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
    pass "App bundle has valid stapled notarization ticket"
  else
    fail "App bundle missing valid stapled notarization ticket"
  fi

  if [[ -n "$DMG_PATH" ]]; then
    if codesign --verify --verbose=2 "$DMG_PATH" >/dev/null 2>&1; then
      pass "DMG passed codesign --verify"
    else
      fail "DMG failed codesign --verify"
    fi

    DMG_CS="$(codesign -dv --verbose=4 "$DMG_PATH" 2>&1 || true)"
    if printf '%s\n' "$DMG_CS" | grep -Eq '^Signature=adhoc$'; then
      fail "DMG is ad-hoc signed; Apple Developer ID signature required"
    elif printf '%s\n' "$DMG_CS" | grep -Eq '^Authority=Developer ID Application:'; then
      pass "DMG has Developer ID Application authority"
    else
      fail "DMG missing Developer ID Application authority"
    fi

    if spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH" >/dev/null 2>&1; then
      pass "DMG accepted by Gatekeeper (spctl --assess --type open)"
    else
      fail "DMG rejected by Gatekeeper (spctl --assess --type open)"
    fi

    if xcrun stapler validate "$DMG_PATH" >/dev/null 2>&1; then
      pass "DMG has valid stapled notarization ticket"
    else
      fail "DMG missing valid stapled notarization ticket"
    fi
  fi
else
  CS_SUMMARY="$(printf '%s\n' "$APP_CS" | grep -E '^(Signature=|Authority=|TeamIdentifier=|CodeDirectory )' || true)"
  if [[ -n "$CS_SUMMARY" ]]; then
    echo "[INFO] App codesign summary:"
    printf '%s\n' "$CS_SUMMARY" | sed 's/^/       /'
  else
    echo "[INFO] App bundle appears unsigned."
  fi
  skip "Developer ID signature, Gatekeeper (spctl), and stapler checks (--require-signed not set)"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "Verification failed with $FAILURES error(s)." >&2
  exit 1
fi

echo "All requested macOS bundle checks passed."
