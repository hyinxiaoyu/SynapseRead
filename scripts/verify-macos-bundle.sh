#!/usr/bin/env bash
set -euo pipefail

# Verify macOS .app and optional .dmg bundles for architecture, Info.plist
# invariants (T-44 / UA-6), DMG integrity, Developer ID signing, local
# self-signed / ad hoc bound signatures, Hardened Runtime, Gatekeeper, and
# stapled notarization tickets.

usage() {
  cat <<'EOF'
Usage: scripts/verify-macos-bundle.sh --app <path-to-SynapseRead.app> [options]

Options:
  --app <path>            Path to SynapseRead.app bundle (required)
  --dmg <path>            Path to SynapseRead_*.dmg image (optional)
  --require-universal     Assert main executable contains both arm64 and x86_64 slices
  --require-signed        Assert Apple Developer ID signing, Hardened Runtime, spctl, and stapler
  --require-local-signed  Assert local Keychain certificate signature, bound Info.plist, and Hardened Runtime
  --require-adhoc-bound   Assert ad hoc signature with bound Info.plist (not linker-signed)
  -h, --help              Show this help message
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: verify-macos-bundle.sh must run on macOS (Darwin)." >&2
  exit 1
fi

APP_PATH=""
DMG_PATH=""
REQUIRE_UNIVERSAL=false
VERIFY_SIGN_MODE="none"

set_verify_sign_mode() {
  local mode="$1"
  if [[ "$VERIFY_SIGN_MODE" != "none" ]]; then
    echo "Error: --require-signed, --require-local-signed, and --require-adhoc-bound are mutually exclusive." >&2
    exit 1
  fi
  VERIFY_SIGN_MODE="$mode"
}

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
      set_verify_sign_mode "signed"
      shift
      ;;
    --require-local-signed)
      set_verify_sign_mode "local-signed"
      shift
      ;;
    --require-adhoc-bound)
      set_verify_sign_mode "adhoc-bound"
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
DMG_MOUNT_POINT=""
DMG_MOUNTED=false
CLEANUP_DETACH_REPORTED=false
CLEANUP_RMDIR_REPORTED=false
LAST_DETECTED_ARCHS=""

cleanup_dmg_mount() {
  local cleanup_err=0
  if [[ "${DMG_MOUNTED:-false}" == "true" && -n "${DMG_MOUNT_POINT:-}" ]]; then
    local detach_err="" force_err=""
    if detach_err="$(hdiutil detach "$DMG_MOUNT_POINT" 2>&1)"; then
      DMG_MOUNTED=false
    elif force_err="$(hdiutil detach "$DMG_MOUNT_POINT" -force 2>&1)"; then
      DMG_MOUNTED=false
    else
      cleanup_err=1
      if [[ "${CLEANUP_DETACH_REPORTED:-false}" != "true" ]]; then
        CLEANUP_DETACH_REPORTED=true
        local detach_msg force_msg
        detach_msg="$(printf '%s' "$detach_err" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
        force_msg="$(printf '%s' "$force_err" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
        fail "Failed to detach DMG mount point '${DMG_MOUNT_POINT}': normal detach (${detach_msg:-failed}); force detach (${force_msg:-failed})"
      fi
    fi
  fi

  if [[ "${DMG_MOUNTED:-false}" == "false" && -n "${DMG_MOUNT_POINT:-}" ]]; then
    if [[ -d "$DMG_MOUNT_POINT" ]]; then
      local rmdir_err=""
      if rmdir_err="$(rmdir "$DMG_MOUNT_POINT" 2>&1)"; then
        DMG_MOUNT_POINT=""
      else
        cleanup_err=1
        if [[ "${CLEANUP_RMDIR_REPORTED:-false}" != "true" ]]; then
          CLEANUP_RMDIR_REPORTED=true
          local rmdir_msg
          rmdir_msg="$(printf '%s' "$rmdir_err" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
          fail "Failed to remove DMG mount directory '${DMG_MOUNT_POINT}': ${rmdir_msg:-rmdir failed}"
        fi
      fi
    else
      DMG_MOUNT_POINT=""
    fi
  fi

  return "$cleanup_err"
}

on_exit() {
  local exit_status=$?
  if ! cleanup_dmg_mount; then
    if [[ "$exit_status" -eq 0 ]]; then
      exit_status=1
    fi
  fi
  exit "$exit_status"
}
trap on_exit EXIT

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

verify_app_structure() {
  local app_path="$1"
  local label="$2"
  LAST_DETECTED_ARCHS=""

  local bin_path="$app_path/Contents/MacOS/synapseread-desktop"
  if [[ -x "$bin_path" ]]; then
    pass "${label} executable exists: $bin_path"
    LAST_DETECTED_ARCHS="$(lipo -archs "$bin_path" 2>/dev/null || true)"
    echo "[INFO] ${label} architectures: ${LAST_DETECTED_ARCHS:-unknown}"
    if [[ "$REQUIRE_UNIVERSAL" == "true" ]]; then
      local norm_archs=" $(printf '%s' "$LAST_DETECTED_ARCHS" | tr -s '[:space:]' ' ') "
      if [[ "$norm_archs" == *" arm64 "* && "$norm_archs" == *" x86_64 "* ]]; then
        pass "${label} universal binary contains arm64 and x86_64 slices"
      else
        fail "${label} expected universal binary with arm64 and x86_64 slices, got: ${LAST_DETECTED_ARCHS:-none}"
      fi
    fi
  else
    fail "${label} executable missing or not executable: $bin_path"
  fi

  local plist_path="$app_path/Contents/Info.plist"
  if [[ ! -f "$plist_path" ]]; then
    fail "${label} Info.plist missing: $plist_path"
  else
    if plutil -lint "$plist_path" >/dev/null 2>&1; then
      pass "${label} Info.plist syntax valid"
    else
      fail "${label} Info.plist failed plutil -lint"
    fi

    local bundle_id
    bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$plist_path" 2>/dev/null || true)"
    if [[ "$bundle_id" == "app.synapseread.desktop" ]]; then
      pass "${label} CFBundleIdentifier is app.synapseread.desktop"
    else
      fail "${label} unexpected CFBundleIdentifier: ${bundle_id:-missing} (expected app.synapseread.desktop)"
    fi

    local local_net_desc
    local_net_desc="$(plutil -extract NSLocalNetworkUsageDescription raw -o - "$plist_path" 2>/dev/null || true)"
    if [[ -n "$local_net_desc" ]]; then
      pass "${label} Info.plist declares NSLocalNetworkUsageDescription (T-44 / UA-6)"
    else
      fail "${label} Info.plist missing or empty NSLocalNetworkUsageDescription"
    fi

    if plutil -p "$plist_path" 2>/dev/null | grep -q "NSBonjourServices" \
      || plutil -extract NSBonjourServices raw -o - "$plist_path" >/dev/null 2>&1; then
      fail "${label} Info.plist must not declare NSBonjourServices"
    else
      pass "${label} Info.plist omits NSBonjourServices"
    fi
  fi
}

verify_app_structure "$APP_PATH" "App bundle"
OUTER_RAW_ARCHS="$LAST_DETECTED_ARCHS"

if [[ -n "$DMG_PATH" ]]; then
  if hdiutil verify "$DMG_PATH" >/dev/null 2>&1; then
    pass "DMG image verified with hdiutil verify"
  else
    fail "hdiutil verify failed for $DMG_PATH"
  fi
fi

check_info_plist_bound() {
  local cs_output="$1"
  local label="${2:-App bundle}"
  if printf '%s\n' "$cs_output" | grep -Eq '^Info\.plist entries=[0-9]+$'; then
    pass "${label} Info.plist is bound to the code signature"
  elif printf '%s\n' "$cs_output" | grep -Eq '^Info\.plist=not bound$'; then
    fail "${label} Info.plist is not bound (linker-signed); re-sign with codesign --force --deep"
  else
    fail "${label} could not confirm bound Info.plist in codesign metadata"
  fi
}

verify_app_signature() {
  local app_path="$1"
  local cs_output="$2"
  local mode="$3"
  local label="$4"

  if codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1; then
    pass "${label} passed codesign --verify --deep --strict"
  else
    fail "${label} failed codesign --verify --deep --strict"
  fi

  case "$mode" in
    local-signed)
      if printf '%s\n' "$cs_output" | grep -Eq '^Signature=adhoc$'; then
        fail "${label} is ad-hoc signed; local certificate signature required"
      else
        pass "${label} is not ad-hoc signed"
      fi

      local first_auth
      first_auth="$(printf '%s\n' "$cs_output" | grep -E '^Authority=' | head -n 1 || true)"
      if [[ -n "$first_auth" ]]; then
        pass "${label} has signing authority (${first_auth#Authority=})"
      else
        fail "${label} missing Authority= in codesign metadata"
      fi

      check_info_plist_bound "$cs_output" "$label"

      if printf '%s\n' "$cs_output" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-fA-F]+\([^)]*runtime[^)]*\)'; then
        pass "${label} has Hardened Runtime enabled"
      else
        fail "${label} missing Hardened Runtime flag"
      fi

      local team_line
      team_line="$(printf '%s\n' "$cs_output" | grep -E '^TeamIdentifier=' | head -n 1 || true)"
      echo "[INFO] ${label} ${team_line:-TeamIdentifier=unknown}"
      ;;
    adhoc-bound)
      if printf '%s\n' "$cs_output" | grep -Eq '^Signature=adhoc$'; then
        pass "${label} is ad-hoc signed"
      else
        fail "${label} is not ad-hoc signed (expected ad hoc signature)"
      fi

      check_info_plist_bound "$cs_output" "$label"
      ;;
    *)
      echo "Internal error: unsupported mode '$mode' in verify_app_signature" >&2
      exit 1
      ;;
  esac
}

normalize_archs() {
  printf '%s\n' "$1" | tr -s '[:space:]' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

extract_cdhash_for_arch() {
  local app_path="$1"
  local arch="$2"
  local cs_out
  if ! cs_out="$(codesign -dv --verbose=4 --arch "$arch" "$app_path" 2>&1)"; then
    return 1
  fi
  local cdhash
  cdhash="$(printf '%s\n' "$cs_out" | awk -F= '$1 == "CDHash" { print $2; exit }')"
  if [[ -z "$cdhash" ]]; then
    return 1
  fi
  printf '%s' "$cdhash"
}

verify_dmg_inner_app() {
  local outer_app="$1"
  local outer_raw_archs="$2"
  local dmg_path="$3"
  local mode="$4"

  DMG_MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/synapseread-dmg-verify.XXXXXX")"
  if ! hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$DMG_MOUNT_POINT" "$dmg_path" </dev/null >/dev/null 2>&1; then
    fail "Failed to attach DMG read-only for inner app inspection: $dmg_path"
    cleanup_dmg_mount || true
    return
  fi
  DMG_MOUNTED=true

  local dmg_app_path="${DMG_MOUNT_POINT}/SynapseRead.app"
  if [[ ! -d "$dmg_app_path" || -L "$dmg_app_path" ]]; then
    fail "Mounted DMG does not contain SynapseRead.app: $dmg_path"
    cleanup_dmg_mount || true
    return
  fi

  verify_app_structure "$dmg_app_path" "DMG app bundle"
  local inner_raw_archs="$LAST_DETECTED_ARCHS"
  local dmg_app_cs
  dmg_app_cs="$(codesign -dv --verbose=4 "$dmg_app_path" 2>&1 || true)"
  verify_app_signature "$dmg_app_path" "$dmg_app_cs" "$mode" "DMG app bundle"

  local outer_archs inner_archs
  outer_archs="$(normalize_archs "$outer_raw_archs")"
  inner_archs="$(normalize_archs "$inner_raw_archs")"
  if [[ -z "$outer_archs" || -z "$inner_archs" ]]; then
    fail "Could not determine architectures for outer app (${outer_archs:-none}) or DMG app (${inner_archs:-none})"
  elif [[ "$outer_archs" != "$inner_archs" ]]; then
    fail "Architecture mismatch between outer app (${outer_archs}) and DMG app (${inner_archs})"
  else
    pass "DMG app architectures match outer app (${outer_archs})"
    local arch outer_cdhash inner_cdhash
    for arch in $outer_archs; do
      outer_cdhash="$(extract_cdhash_for_arch "$outer_app" "$arch" || true)"
      inner_cdhash="$(extract_cdhash_for_arch "$dmg_app_path" "$arch" || true)"
      if [[ -z "$outer_cdhash" || -z "$inner_cdhash" ]]; then
        fail "Missing CDHash for architecture ${arch} (outer=${outer_cdhash:-missing}, dmg=${inner_cdhash:-missing})"
      elif [[ "$outer_cdhash" != "$inner_cdhash" ]]; then
        fail "CDHash mismatch for architecture ${arch}: outer=${outer_cdhash}, dmg=${inner_cdhash}"
      else
        pass "DMG app CDHash matches outer app for ${arch} (${outer_cdhash})"
      fi
    done
  fi

  cleanup_dmg_mount || true
}

APP_CS="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"

case "$VERIFY_SIGN_MODE" in
  signed)
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
    ;;
  local-signed)
    verify_app_signature "$APP_PATH" "$APP_CS" "local-signed" "App bundle"
    skip "Gatekeeper (spctl) and stapler checks (local self-signed builds are not notarized; see docs/MACOS_SIGNING.md)"

    if [[ -n "$DMG_PATH" ]]; then
      if codesign --verify --verbose=2 "$DMG_PATH" >/dev/null 2>&1; then
        pass "DMG passed codesign --verify"
      else
        fail "DMG failed codesign --verify"
      fi

      DMG_CS="$(codesign -dv --verbose=4 "$DMG_PATH" 2>&1 || true)"
      if printf '%s\n' "$DMG_CS" | grep -Eq '^Signature=adhoc$'; then
        fail "DMG is ad-hoc signed; local certificate signature required"
      else
        pass "DMG is not ad-hoc signed"
      fi

      DMG_AUTH="$(printf '%s\n' "$DMG_CS" | grep -E '^Authority=' | head -n 1 || true)"
      if [[ -n "$DMG_AUTH" ]]; then
        pass "DMG has signing authority (${DMG_AUTH#Authority=})"
      else
        fail "DMG missing Authority= in codesign metadata"
      fi

      verify_dmg_inner_app "$APP_PATH" "$OUTER_RAW_ARCHS" "$DMG_PATH" "local-signed"
    fi
    ;;
  adhoc-bound)
    verify_app_signature "$APP_PATH" "$APP_CS" "adhoc-bound" "App bundle"
    skip "Developer ID, Gatekeeper (spctl), and stapler checks (ad hoc bound build; see docs/MACOS_SIGNING.md)"

    if [[ -n "$DMG_PATH" ]]; then
      verify_dmg_inner_app "$APP_PATH" "$OUTER_RAW_ARCHS" "$DMG_PATH" "adhoc-bound"
    fi
    ;;
  none)
    CS_SUMMARY="$(printf '%s\n' "$APP_CS" | grep -E '^(Signature=|Authority=|TeamIdentifier=|CodeDirectory |Info\.plist)' || true)"
    if [[ -n "$CS_SUMMARY" ]]; then
      echo "[INFO] App codesign summary:"
      printf '%s\n' "$CS_SUMMARY" | sed 's/^/       /'
    else
      echo "[INFO] App bundle appears unsigned."
    fi
    skip "Developer ID signature, Gatekeeper (spctl), and stapler checks (--require-signed not set)"
    ;;
esac

if [[ "$FAILURES" -gt 0 ]]; then
  echo "Verification failed with $FAILURES error(s)." >&2
  exit 1
fi

echo "All requested macOS bundle checks passed."
