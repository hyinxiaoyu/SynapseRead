#!/usr/bin/env bash
set -euo pipefail

# Read-only checkpoint snapshot tool for two-Mac LAN Book Sync validation (#147).
# Collects host, bundle, signature metadata + strict verification, bundle-bound
# process context, TCP listeners, non-SSID IPv4 network, macOS Firewall, and
# aggregate app-data counts without making network calls or listing filenames.

usage() {
  cat <<'EOF'
Usage: scripts/lan-sync-collect-evidence.sh --role <mac-a|mac-b> --label <text> [options]

Options:
  --role <mac-a|mac-b>   Device role for this checkpoint (required)
  --label <text>         Checkpoint label, e.g. T-10-launch; chars [A-Za-z0-9._-] (required)
  --app <path>           Path to SynapseRead.app (default: /Applications/SynapseRead.app)
  --executable <path>    Override target executable path when matching processes
                         (e.g. target/debug/synapseread-desktop for T-45)
  --pid <pid>            Restrict process/listener inspection to one PID (must match
                         current user and target executable)
  --app-data <dir>       Path to app data dir
                         (default: $HOME/Library/Application Support/app.synapseread.desktop)
  --build-sha <hex>      Source commit SHA, 7-40 hex chars (optional)
  --out <dir>            Also write <YYYYmmddTHHMMSS>-<role>-<label>.md under <dir>
  -h, --help             Show this help message

Environment overrides (for tests):
  SYNAPSEREAD_SOCKETFILTERFW  Override /usr/libexec/ApplicationFirewall/socketfilterfw
  SYNAPSEREAD_WEBKIT_PLIST    Override /System/Library/Frameworks/WebKit.framework/Resources/Info.plist
EOF
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: lan-sync-collect-evidence.sh must run on macOS (Darwin)." >&2
  exit 1
fi

ROLE=""
LABEL=""
APP_PATH="/Applications/SynapseRead.app"
APP_EXPLICIT="false"
EXPLICIT_EXECUTABLE=""
EXEC_EXPLICIT="false"
TARGET_PID=""
APP_DATA_DIR="${HOME}/Library/Application Support/app.synapseread.desktop"
BUILD_SHA=""
OUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --role requires mac-a or mac-b." >&2
        usage >&2
        exit 1
      fi
      ROLE="$2"
      shift 2
      ;;
    --label)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --label requires a checkpoint label." >&2
        usage >&2
        exit 1
      fi
      LABEL="$2"
      shift 2
      ;;
    --app)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --app requires a bundle path." >&2
        usage >&2
        exit 1
      fi
      APP_PATH="$2"
      APP_EXPLICIT="true"
      shift 2
      ;;
    --executable)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --executable requires a binary path." >&2
        usage >&2
        exit 1
      fi
      EXPLICIT_EXECUTABLE="$2"
      EXEC_EXPLICIT="true"
      shift 2
      ;;
    --pid)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --pid requires a numeric process ID." >&2
        usage >&2
        exit 1
      fi
      TARGET_PID="$2"
      shift 2
      ;;
    --app-data)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --app-data requires a directory path." >&2
        usage >&2
        exit 1
      fi
      APP_DATA_DIR="$2"
      shift 2
      ;;
    --build-sha)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --build-sha requires a hex commit SHA." >&2
        usage >&2
        exit 1
      fi
      BUILD_SHA="$2"
      shift 2
      ;;
    --out)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --out requires an output directory path." >&2
        usage >&2
        exit 1
      fi
      OUT_DIR="$2"
      shift 2
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

if [[ -z "$ROLE" ]]; then
  echo "Error: --role is required." >&2
  usage >&2
  exit 1
fi

if [[ "$ROLE" != "mac-a" && "$ROLE" != "mac-b" ]]; then
  echo "Error: --role must be 'mac-a' or 'mac-b' (got '$ROLE')." >&2
  usage >&2
  exit 1
fi

if [[ -z "$LABEL" ]]; then
  echo "Error: --label is required." >&2
  usage >&2
  exit 1
fi

if ! [[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Error: --label may only contain [A-Za-z0-9._-] (got '$LABEL')." >&2
  usage >&2
  exit 1
fi

if [[ "$EXEC_EXPLICIT" == "true" ]]; then
  if [[ ! -f "$EXPLICIT_EXECUTABLE" ]]; then
    echo "Error: --executable file not found: $EXPLICIT_EXECUTABLE" >&2
    exit 1
  fi
fi

HAS_APP_BUNDLE="true"
if [[ "$EXEC_EXPLICIT" == "true" && "$APP_EXPLICIT" == "false" ]]; then
  HAS_APP_BUNDLE="false"
else
  APP_PATH="${APP_PATH%/}"
  [[ -z "$APP_PATH" ]] && APP_PATH="/"
  if [[ ! -d "$APP_PATH" || "$APP_PATH" != *.app ]]; then
    echo "Error: App bundle directory not found or does not end in .app: $APP_PATH" >&2
    exit 1
  fi
fi

if [[ -n "$TARGET_PID" ]] && ! [[ "$TARGET_PID" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --pid must be a positive integer (got '$TARGET_PID')." >&2
  exit 1
fi

if [[ "$APP_DATA_DIR" != "/" ]]; then
  APP_DATA_DIR="${APP_DATA_DIR%/}"
fi

if [[ -n "$BUILD_SHA" ]] && ! [[ "$BUILD_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  echo "Error: --build-sha must be 7-40 hex characters (got '$BUILD_SHA')." >&2
  exit 1
fi

SOCKETFILTERFW="${SYNAPSEREAD_SOCKETFILTERFW:-/usr/libexec/ApplicationFirewall/socketfilterfw}"
WEBKIT_PLIST="${SYNAPSEREAD_WEBKIT_PLIST:-/System/Library/Frameworks/WebKit.framework/Resources/Info.plist}"

canonicalize_path() {
  local p="$1"
  local dir="" base=""
  dir="$(dirname "$p")"
  base="$(basename "$p")"
  if [[ -d "$dir" ]]; then
    local real_dir=""
    if real_dir="$(cd "$dir" 2>/dev/null && pwd -P)"; then
      if [[ "$real_dir" == "/" ]]; then
        printf '/%s' "$base"
      else
        printf '%s/%s' "$real_dir" "$base"
      fi
      return 0
    fi
  fi
  printf '%s' "$p"
}

TARGET_EXEC="${EXPLICIT_EXECUTABLE:-${APP_PATH}/Contents/MacOS/synapseread-desktop}"
TARGET_EXEC_REAL="$(canonicalize_path "$TARGET_EXEC")"
TARGET_PROC_NAME="$(basename "$TARGET_EXEC")"

probe_value() {
  local out=""
  if out="$("$@" 2>/dev/null)" && [[ -n "$out" ]]; then
    printf '%s' "$out"
  else
    printf 'unavailable'
  fi
}

probe_firewall_arg() {
  local out=""
  if out="$("$SOCKETFILTERFW" "$@" 2>/dev/null)" && [[ -n "$out" ]]; then
    printf '%s' "$out"
  else
    printf 'unavailable'
  fi
}

# Parse `lsof` output while separating confirmed 0-match (`rc=1` with empty output,
# or `rc=0` with header-only) from probe failures (`rc>=2`, `rc=1` with error text,
# or unexpected non-socket output).
# Sets global variables: LSOF_PARSED_STATUS ("ok"|"failed"), LSOF_PARSED_COUNT,
# LSOF_PARSED_TEXT, LSOF_PARSED_HAS_WILDCARD.
LSOF_PARSED_STATUS="failed"
LSOF_PARSED_COUNT="unavailable"
LSOF_PARSED_TEXT="unavailable"
LSOF_PARSED_HAS_WILDCARD="false"

parse_lsof_tcp() {
  local out="$1"
  local rc="$2"
  local state_tag="$3"
  local empty_label="$4"

  LSOF_PARSED_STATUS="failed"
  LSOF_PARSED_COUNT="unavailable"
  LSOF_PARSED_TEXT="unavailable"
  LSOF_PARSED_HAS_WILDCARD="false"

  if [[ "$rc" -eq 1 && -z "$out" ]]; then
    LSOF_PARSED_STATUS="ok"
    LSOF_PARSED_COUNT="0"
    LSOF_PARSED_TEXT="$empty_label"
    return 0
  fi

  if [[ "$rc" -ne 0 ]]; then
    return 0
  fi

  if [[ -z "$out" ]]; then
    LSOF_PARSED_STATUS="ok"
    LSOF_PARSED_COUNT="0"
    LSOF_PARSED_TEXT="$empty_label"
    return 0
  fi

  local sock_lines="" unexpected_lines="" line="" saw_header="false"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$saw_header" == "false" ]] && [[ "$line" == COMMAND* ]]; then
      saw_header="true"
      continue
    fi
    if printf '%s' "$line" | grep -Fq "(${state_tag})"; then
      if [[ -n "$sock_lines" ]]; then
        sock_lines="${sock_lines}"$'\n'"${line}"
      else
        sock_lines="$line"
      fi
    else
      unexpected_lines="true"
    fi
  done <<< "$out"

  if [[ "$unexpected_lines" == "true" ]]; then
    return 0
  fi

  if [[ -n "$sock_lines" ]]; then
    local cnt=0
    cnt="$(printf '%s\n' "$sock_lines" | wc -l | tr -d '[:space:]')"
    LSOF_PARSED_STATUS="ok"
    LSOF_PARSED_COUNT="$cnt"
    LSOF_PARSED_TEXT="$out"
    if printf '%s\n' "$sock_lines" | grep -Eq '(\*:|0\.0\.0\.0:)'; then
      LSOF_PARSED_HAS_WILDCARD="true"
    fi
  elif [[ "$saw_header" == "true" ]]; then
    LSOF_PARSED_STATUS="ok"
    LSOF_PARSED_COUNT="0"
    LSOF_PARSED_TEXT="$empty_label"
  fi
}

# Count regular files safely even when filenames contain newlines, without ever
# leaking filenames. Emits one 'x' byte per matched file via -exec printf x \;.
count_dir_files() {
  local dir="$1"
  local pattern="${2:-}"
  local marks=""
  if [[ -n "$pattern" ]]; then
    marks="$(find "$dir" -type f -name "$pattern" -exec printf x \; 2>/dev/null)" || return 1
  else
    marks="$(find "$dir" -type f -exec printf x \; 2>/dev/null)" || return 1
  fi
  printf '%s' "${#marks}"
}

measure_dir_kib() {
  local dir="$1"
  local du_out="" kib=""
  du_out="$(du -sk "$dir" 2>/dev/null)" || return 1
  kib="$(printf '%s\n' "$du_out" | awk 'NR == 1 && $1 ~ /^[0-9]+$/ { print $1 }')"
  if [[ -z "$kib" ]]; then
    return 1
  fi
  printf '%s' "$kib"
}

collect_report() {
  local timestamp build_sha_display
  timestamp="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  build_sha_display="${BUILD_SHA:-not provided}"

  printf '# SynapseRead LAN evidence: %s %s\n\n' "$ROLE" "$LABEL"
  printf -- '- Timestamp: `%s`\n' "$timestamp"
  printf -- '- Role: `%s`\n' "$ROLE"
  printf -- '- Label: `%s`\n' "$LABEL"
  printf -- '- Build SHA: `%s`\n\n' "$build_sha_display"

  # ## Host
  local os_ver os_build os_display arch cpu_brand mem_bytes mem_display webkit_ver
  os_ver="$(probe_value sw_vers -productVersion)"
  os_build="$(probe_value sw_vers -buildVersion)"
  if [[ "$os_ver" != "unavailable" && "$os_build" != "unavailable" ]]; then
    os_display="macOS ${os_ver} (${os_build})"
  elif [[ "$os_ver" != "unavailable" ]]; then
    os_display="macOS ${os_ver}"
  else
    os_display="unavailable"
  fi
  arch="$(probe_value uname -m)"
  cpu_brand="$(probe_value sysctl -n machdep.cpu.brand_string)"
  mem_bytes="$(probe_value sysctl -n hw.memsize)"
  if [[ "$mem_bytes" =~ ^[0-9]+$ ]]; then
    mem_display="$(awk -v b="$mem_bytes" 'BEGIN { printf "%.1f GiB (%s bytes)", b / 1073741824, b }')"
  else
    mem_display="unavailable"
  fi
  if [[ -f "$WEBKIT_PLIST" ]]; then
    webkit_ver="$(probe_value plutil -extract CFBundleVersion raw -o - "$WEBKIT_PLIST")"
  else
    webkit_ver="unavailable"
  fi

  printf '## Host\n\n'
  printf -- '- OS: %s\n' "$os_display"
  printf -- '- Architecture: `%s`\n' "$arch"
  printf -- '- CPU / Chip: %s\n' "$cpu_brand"
  printf -- '- Memory: %s\n' "$mem_display"
  printf -- '- WebKit `CFBundleVersion`: `%s`\n\n' "$webkit_ver"

  # ## App bundle
  printf '## App bundle\n\n'
  if [[ "$HAS_APP_BUNDLE" == "false" ]]; then
    local dev_archs="unavailable" dev_sha="unavailable"
    dev_archs="$(probe_value lipo -archs "$TARGET_EXEC_REAL")"
    local shasum_out=""
    if shasum_out="$(shasum -a 256 "$TARGET_EXEC_REAL" 2>/dev/null)" && [[ -n "$shasum_out" ]]; then
      dev_sha="$(printf '%s' "$shasum_out" | awk '{print $1}')"
    fi
    printf -- '- Mode: standalone executable (`--executable` without `--app`)\n'
    printf -- '- Bundle path: N/A (not applicable; `--app` not provided)\n'
    printf -- '- Target executable: `%s`\n' "$TARGET_EXEC_REAL"
    printf -- '- `CFBundleShortVersionString`: N/A (standalone executable)\n'
    printf -- '- `CFBundleVersion`: N/A (standalone executable)\n'
    printf -- '- `NSLocalNetworkUsageDescription`: N/A (standalone executable)\n'
    printf -- '- `NSBonjourServices`: N/A (standalone executable)\n'
    printf -- '- Executable architectures (`lipo -archs`): `%s`\n' "$dev_archs"
    printf -- '- Executable SHA-256: `%s`\n' "$dev_sha"
    printf -- '- Quarantine (`com.apple.quarantine`): N/A (standalone executable)\n\n'
  else
    local plist_path bin_path short_ver bundle_ver plist_readable="false"
    local local_net_desc bonjour_status bin_archs bin_sha quarantine_status
    plist_path="${APP_PATH}/Contents/Info.plist"
    bin_path="${APP_PATH}/Contents/MacOS/synapseread-desktop"

    if [[ -f "$plist_path" ]]; then
      if plutil -extract CFBundleIdentifier raw -o - "$plist_path" >/dev/null 2>&1; then
        plist_readable="true"
      fi
      short_ver="$(probe_value plutil -extract CFBundleShortVersionString raw -o - "$plist_path")"
      bundle_ver="$(probe_value plutil -extract CFBundleVersion raw -o - "$plist_path")"

      local raw_desc=""
      if raw_desc="$(plutil -extract NSLocalNetworkUsageDescription raw -o - "$plist_path" 2>/dev/null)" && [[ -n "$raw_desc" ]]; then
        local_net_desc="$raw_desc"
      elif [[ "$plist_readable" == "true" ]]; then
        local_net_desc="MISSING"
      else
        local_net_desc="unavailable"
      fi

      local raw_p=""
      if plutil -extract NSBonjourServices raw -o - "$plist_path" >/dev/null 2>&1; then
        bonjour_status="PRESENT"
      elif raw_p="$(plutil -p "$plist_path" 2>/dev/null)" && printf '%s\n' "$raw_p" | grep -q "NSBonjourServices"; then
        bonjour_status="PRESENT"
      elif [[ "$plist_readable" == "true" ]]; then
        bonjour_status="absent"
      else
        bonjour_status="unavailable"
      fi
    else
      short_ver="unavailable"
      bundle_ver="unavailable"
      local_net_desc="MISSING"
      bonjour_status="unavailable"
    fi

    if [[ -e "$bin_path" ]]; then
      bin_archs="$(probe_value lipo -archs "$bin_path")"
      local shasum_out=""
      if shasum_out="$(shasum -a 256 "$bin_path" 2>/dev/null)" && [[ -n "$shasum_out" ]]; then
        bin_sha="$(printf '%s' "$shasum_out" | awk '{print $1}')"
      else
        bin_sha="unavailable"
      fi
    else
      bin_archs="unavailable"
      bin_sha="unavailable"
    fi

    local xattr_out="" xattr_rc=0
    xattr_out="$(xattr -p com.apple.quarantine "$APP_PATH" 2>&1)" || xattr_rc=$?
    if [[ "$xattr_rc" -eq 0 ]]; then
      quarantine_status="present"
    elif printf '%s\n' "$xattr_out" | grep -qi "No such xattr"; then
      quarantine_status="absent"
    elif xattr "$APP_PATH" >/dev/null 2>&1; then
      quarantine_status="absent"
    else
      quarantine_status="unavailable"
    fi

    if [[ "$EXEC_EXPLICIT" == "true" ]]; then
      printf -- '- Mode: dual target (`--app` bundle + explicit `--executable` process filter)\n'
      printf -- '- Inspected bundle (`--app`): `%s`\n' "$APP_PATH"
      printf -- '- Inspected process executable (`--executable`): `%s`\n' "$TARGET_EXEC_REAL"
      printf -- '- Bundle executable (`lipo`/SHA-256): `%s`\n' "$bin_path"
    else
      printf -- '- Path: `%s`\n' "$APP_PATH"
      printf -- '- Target executable: `%s`\n' "$TARGET_EXEC_REAL"
    fi
    printf -- '- `CFBundleShortVersionString`: `%s`\n' "$short_ver"
    printf -- '- `CFBundleVersion`: `%s`\n' "$bundle_ver"
    printf -- '- `NSLocalNetworkUsageDescription`: %s\n' "$local_net_desc"
    printf -- '- `NSBonjourServices`: %s\n' "$bonjour_status"
    printf -- '- Executable architectures (`lipo -archs`): `%s`\n' "$bin_archs"
    printf -- '- Executable SHA-256: `%s`\n' "$bin_sha"
    printf -- '- Quarantine (`com.apple.quarantine`): %s\n\n' "$quarantine_status"
  fi

  # ## Code signature
  printf '## Code signature\n\n'
  if [[ "$HAS_APP_BUNDLE" == "false" ]]; then
    printf -- '- Signing type: N/A (standalone `--executable` mode; no `--app` bundle)\n'
    printf -- '- Signature integrity (`codesign --verify --deep --strict`): N/A (standalone `--executable` mode; no `--app` bundle)\n\n'
  else
    local cs_out="" cs_rc=0 cs_verify_out="" cs_verify_rc=0
    local signing_type="unavailable" integrity_status="unavailable"
    cs_out="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)" || cs_rc=$?
    cs_verify_out="$(codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1)" || cs_verify_rc=$?

    local cs_has_meta="false" cs_unsigned="false"
    if [[ "$cs_rc" -eq 0 ]] || printf '%s\n' "$cs_out" | grep -Eq '^(Identifier=|Signature=|CodeDirectory )'; then
      cs_has_meta="true"
    elif printf '%s\n' "$cs_out" | grep -qi 'not signed at all'; then
      cs_unsigned="true"
    fi

    if [[ "$cs_has_meta" == "true" ]]; then
      if [[ "$cs_verify_rc" -eq 0 ]]; then
        integrity_status="valid (passed codesign --verify --deep --strict)"
      elif [[ -n "$cs_verify_out" ]] && ! printf '%s\n' "$cs_verify_out" | grep -qi 'mocked failure'; then
        local verify_summary=""
        verify_summary="$(printf '%s\n' "$cs_verify_out" | head -n 1 | tr '\r\n' ' ' | sed 's/[[:space:]]*$//')"
        integrity_status="INVALID (${verify_summary}) — NOT valid for #147"
      else
        integrity_status="INVALID (codesign --verify --deep --strict exited ${cs_verify_rc}) — NOT valid for #147"
      fi
    elif [[ "$cs_unsigned" == "true" ]]; then
      signing_type="unsigned"
      integrity_status="INVALID (unsigned) — NOT valid for #147"
    fi

    if [[ "$cs_has_meta" == "true" ]]; then
      local filtered_cs="" first_auth="" cs_core=""
      cs_core="$(printf '%s\n' "$cs_out" | grep -E '^(Identifier=|Format=|CDHash=|Signature=|TeamIdentifier=|Info\.plist|Runtime Version=|CodeDirectory )' || true)"
      first_auth="$(printf '%s\n' "$cs_out" | grep -E '^Authority=' | head -n 1 || true)"

      if [[ -n "$cs_core" ]]; then
        filtered_cs="$cs_core"
      fi
      if [[ -n "$first_auth" ]]; then
        if [[ -n "$filtered_cs" ]]; then
          filtered_cs="${filtered_cs}"$'\n'"${first_auth}"
        else
          filtered_cs="$first_auth"
        fi
      fi

      local cd_line="" auth_val="" sig_val="" plist_not_bound="false"
      cd_line="$(printf '%s\n' "$cs_out" | grep -E '^CodeDirectory ' | head -n 1 || true)"
      sig_val="$(printf '%s\n' "$cs_out" | awk -F= '$1 == "Signature" { print $2; exit }' || true)"
      auth_val="${first_auth#Authority=}"
      if printf '%s\n' "$cs_out" | grep -Eq '^Info\.plist=not bound$'; then
        plist_not_bound="true"
      fi

      # Keep codesign -dv metadata separate from codesign --verify integrity: a
      # tampered Info.plist causes codesign -dv to report Info.plist=not bound
      # without setting the linker-signed CodeDirectory flag.
      if [[ "$cd_line" == *"linker-signed"* ]]; then
        signing_type="linker-signed (Info.plist not bound) — NOT valid for #147"
      elif [[ "$sig_val" == "adhoc" ]]; then
        if [[ "$plist_not_bound" == "true" ]]; then
          signing_type="adhoc (Info.plist=not bound; see integrity status) — NOT valid for #147"
        elif [[ "$cs_verify_rc" -eq 0 ]]; then
          signing_type="adhoc (bound)"
        else
          signing_type="adhoc (bound metadata; integrity failed) — NOT valid for #147"
        fi
      elif [[ -n "$auth_val" ]]; then
        if [[ "$auth_val" == "Developer ID Application"* ]]; then
          signing_type="Developer ID"
        else
          signing_type="Self-Signed (${auth_val})"
        fi
        if [[ "$plist_not_bound" == "true" || "$cs_verify_rc" -ne 0 ]]; then
          signing_type="${signing_type} — NOT valid for #147"
        fi
      else
        signing_type="unsigned/unknown"
      fi

      if [[ "$EXEC_EXPLICIT" == "true" ]]; then
        printf -- '- Inspected bundle: `%s`\n' "$APP_PATH"
      fi
      printf -- '- Signing type: %s\n' "$signing_type"
      printf -- '- Signature integrity (`codesign --verify --deep --strict`): %s\n\n' "$integrity_status"
      printf '```text\n%s\n```\n\n' "${filtered_cs:-unavailable}"
    else
      if [[ "$EXEC_EXPLICIT" == "true" ]]; then
        printf -- '- Inspected bundle: `%s`\n' "$APP_PATH"
      fi
      printf -- '- Signing type: %s\n' "$signing_type"
      printf -- '- Signature integrity (`codesign --verify --deep --strict`): %s\n' "$integrity_status"
      printf -- '- `codesign -dv`: unavailable\n\n'
    fi
  fi

  # ## Process (strictly scoped to current user and target executable path)
  local current_uid="" process_status="failed" excluded_other_count=0
  local -a pids=()
  current_uid="$(id -u 2>/dev/null || true)"

  if [[ -z "$current_uid" || ! "$current_uid" =~ ^[0-9]+$ ]]; then
    process_status="failed"
  elif [[ -n "$TARGET_PID" ]]; then
    local pid_uid_out="" pid_uid_rc=0 pid_comm_out="" pid_comm_rc=0
    pid_uid_out="$(ps -ww -o uid= -p "$TARGET_PID" 2>&1)" || pid_uid_rc=$?
    if [[ "$pid_uid_rc" -ne 0 ]]; then
      if ps -o pid= -p "$$" >/dev/null 2>&1 && [[ -z "$pid_uid_out" ]]; then
        process_status="none"
      else
        process_status="failed"
      fi
    else
      local trimmed_uid=""
      trimmed_uid="$(printf '%s' "$pid_uid_out" | tr -d '[:space:]')"
      pid_comm_out="$(ps -ww -o comm= -p "$TARGET_PID" 2>&1)" || pid_comm_rc=$?
      if [[ "$pid_comm_rc" -ne 0 || -z "$pid_comm_out" ]]; then
        process_status="failed"
      elif [[ "$trimmed_uid" != "$current_uid" ]]; then
        process_status="none"
        excluded_other_count=1
      else
        local trimmed_comm="" real_comm=""
        trimmed_comm="$(printf '%s' "$pid_comm_out" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        real_comm="$(canonicalize_path "$trimmed_comm")"
        if [[ "$real_comm" == "$TARGET_EXEC_REAL" || "$trimmed_comm" == "$TARGET_EXEC" ]]; then
          pids+=("$TARGET_PID")
          process_status="matched"
        else
          process_status="none"
          excluded_other_count=1
        fi
      fi
    fi
  else
    local pgrep_out="" pgrep_rc=0
    pgrep_out="$(pgrep -u "$current_uid" -x "$TARGET_PROC_NAME" 2>&1)" || pgrep_rc=$?
    if [[ "$pgrep_rc" -eq 1 && -z "$pgrep_out" ]]; then
      process_status="none"
    elif [[ "$pgrep_rc" -eq 0 ]]; then
      if [[ -z "$pgrep_out" ]]; then
        process_status="failed"
      else
        local -a candidate_pids=()
        local line="" malformed="false"
        while IFS= read -r line; do
          line="$(printf '%s' "$line" | tr -d '[:space:]')"
          [[ -z "$line" ]] && continue
          if [[ "$line" =~ ^[0-9]+$ ]]; then
            candidate_pids+=("$line")
          else
            malformed="true"
            break
          fi
        done <<< "$pgrep_out"

        if [[ "$malformed" == "true" || ${#candidate_pids[@]} -eq 0 ]]; then
          process_status="failed"
        else
          local cand=""
          process_status="matched"
          for cand in "${candidate_pids[@]}"; do
            local cand_comm_out="" cand_comm_rc=0
            cand_comm_out="$(ps -ww -o comm= -p "$cand" 2>&1)" || cand_comm_rc=$?
            if [[ "$cand_comm_rc" -ne 0 || -z "$cand_comm_out" ]]; then
              process_status="failed"
              pids=()
              break
            fi
            local cand_comm_trimmed="" cand_comm_real=""
            cand_comm_trimmed="$(printf '%s' "$cand_comm_out" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
            cand_comm_real="$(canonicalize_path "$cand_comm_trimmed")"
            if [[ "$cand_comm_real" == "$TARGET_EXEC_REAL" || "$cand_comm_trimmed" == "$TARGET_EXEC" ]]; then
              pids+=("$cand")
            else
              excluded_other_count=$((excluded_other_count + 1))
            fi
          done
          if [[ "$process_status" == "matched" && ${#pids[@]} -eq 0 ]]; then
            process_status="none"
          fi
        fi
      fi
    else
      # Exit codes >= 2 (empty or diagnostic) or exit 1 with diagnostic output
      # are probe failures, never "not running".
      process_status="failed"
    fi
  fi

  printf '## Process\n\n'
  if [[ "$process_status" == "matched" ]]; then
    local pid=""
    for pid in "${pids[@]}"; do
      local ps_info="" ppid_val="" launch_ctx=""
      ps_info="$(probe_value ps -ww -o ppid=,user=,etime=,command= -p "$pid")"
      ppid_val="$(ps -ww -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "$ppid_val" == "1" ]]; then
        launch_ctx="ppid=1 (launchd child — consistent with Finder/Dock/open; confirm Finder double-click manually)"
      elif [[ "$ppid_val" =~ ^[0-9]+$ ]]; then
        local pcomm=""
        pcomm="$(ps -ww -o comm= -p "$ppid_val" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
        if [[ -z "$pcomm" ]]; then
          pcomm="unknown"
        fi
        launch_ctx="parent ${ppid_val} (${pcomm}) — non-launchd launch, NOT valid Finder permission evidence (T-45)"
      else
        launch_ctx="unavailable"
      fi
      printf -- '- PID `%s`: `%s`\n' "$pid" "$ps_info"
      printf -- '  - Launch context: %s\n' "$launch_ctx"
    done
    if [[ "$excluded_other_count" -gt 0 ]]; then
      printf -- '- Excluded other-executable/other-user PIDs: %s\n' "$excluded_other_count"
    fi
    printf '\n'
  elif [[ "$process_status" == "none" ]]; then
    printf -- '- Status: not running (for target executable `%s`)\n' "$TARGET_EXEC_REAL"
    if [[ "$excluded_other_count" -gt 0 ]]; then
      printf -- '- Excluded other-executable/other-user PIDs: %s\n' "$excluded_other_count"
    fi
    printf '\n'
  else
    printf -- '- Status: unavailable (process probe failed)\n\n'
  fi

  # ## Listeners
  local listen_count="unavailable" est_count="unavailable" has_wildcard="false"
  local listen_display="unavailable" port_range_display="unavailable"

  if [[ "$process_status" == "none" ]]; then
    listen_count="0"
    est_count="0"
    listen_display="0 listeners"
  elif [[ "$process_status" == "matched" ]]; then
    local pids_csv=""
    pids_csv="$(IFS=,; echo "${pids[*]}")"

    local lsof_listen_out="" lsof_listen_rc=0
    lsof_listen_out="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:LISTEN 2>&1)" || lsof_listen_rc=$?
    parse_lsof_tcp "$lsof_listen_out" "$lsof_listen_rc" "LISTEN" "0 listeners"
    listen_count="$LSOF_PARSED_COUNT"
    listen_display="$LSOF_PARSED_TEXT"
    has_wildcard="$LSOF_PARSED_HAS_WILDCARD"

    local lsof_est_out="" lsof_est_rc=0
    lsof_est_out="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:ESTABLISHED 2>&1)" || lsof_est_rc=$?
    parse_lsof_tcp "$lsof_est_out" "$lsof_est_rc" "ESTABLISHED" "0 established"
    est_count="$LSOF_PARSED_COUNT"
  fi

  local lsof_port_out="" lsof_port_rc=0
  lsof_port_out="$(lsof -nP -iTCP:49319-49328 -sTCP:LISTEN 2>&1)" || lsof_port_rc=$?
  parse_lsof_tcp "$lsof_port_out" "$lsof_port_rc" "LISTEN" "none"
  port_range_display="$LSOF_PARSED_TEXT"

  printf '## Listeners\n\n'
  printf -- '- SynapseRead LISTEN sockets: %s\n' "$listen_count"
  printf -- '- SynapseRead ESTABLISHED sockets: %s\n' "$est_count"
  if [[ "$has_wildcard" == "true" ]]; then
    printf -- '- WARNING: wildcard listener detected (`*:` or `0.0.0.0:`)\n'
  fi
  printf '\nSynapseRead `LISTEN` sockets:\n\n```text\n%s\n```\n\n' "$listen_display"
  printf 'Host `TCP:49319-49328` `LISTEN` sockets (all processes):\n\n```text\n%s\n```\n\n' "$port_range_display"

  # ## Network
  local ifconfig_out="" ifconfig_rc=0 net_lines="" default_iface="unavailable"
  ifconfig_out="$(ifconfig 2>/dev/null)" || ifconfig_rc=$?
  if [[ "$ifconfig_rc" -eq 0 && -n "$ifconfig_out" ]]; then
    net_lines="$(printf '%s\n' "$ifconfig_out" | awk '
      /^[A-Za-z0-9._-]+:/ {
        iface = $1
        sub(/:$/, "", iface)
        next
      }
      /^[[:space:]]+inet[[:space:]]+/ {
        ip = $2
        if (iface == "lo0" || ip ~ /^127\./) next
        netmask = "unknown"
        for (i = 3; i <= NF; i++) {
          if ($i == "netmask" && (i + 1) <= NF) {
            netmask = $(i + 1)
            break
          }
        }
        tag = (iface ~ /^utun/) ? " [VPN]" : ""
        printf "- `%s`%s: `%s` netmask `%s`\n", iface, tag, ip, netmask
      }
    ')"
    if [[ -z "$net_lines" ]]; then
      net_lines="- none"
    fi
  else
    net_lines="- unavailable"
  fi

  local route_out="" route_rc=0
  route_out="$(route -n get default 2>/dev/null)" || route_rc=$?
  if [[ "$route_rc" -eq 0 && -n "$route_out" ]]; then
    local parsed_iface=""
    parsed_iface="$(printf '%s\n' "$route_out" | awk '$1 == "interface:" { print $2; exit }')"
    if [[ -n "$parsed_iface" ]]; then
      default_iface="$parsed_iface"
    fi
  fi

  printf '## Network\n\n'
  printf -- '- Default route interface: `%s`\n' "$default_iface"
  printf '%s\n\n' "$net_lines"

  # ## Firewall
  printf '## Firewall\n\n'
  if [[ "$HAS_APP_BUNDLE" == "false" ]]; then
    printf -- '- Global state: N/A (standalone `--executable` mode; no `--app` bundle)\n'
    printf -- '- Block all incoming: N/A (standalone `--executable` mode; no `--app` bundle)\n'
    printf -- '- Stealth mode: N/A (standalone `--executable` mode; no `--app` bundle)\n'
    printf -- '- App blocked: N/A (standalone `--executable` mode; no `--app` bundle)\n\n'
  else
    local fw_global fw_blockall fw_stealth fw_app
    fw_global="$(probe_firewall_arg --getglobalstate)"
    fw_blockall="$(probe_firewall_arg --getblockall)"
    fw_stealth="$(probe_firewall_arg --getstealthmode)"
    fw_app="$(probe_firewall_arg --getappblocked "$APP_PATH")"

    printf -- '- Global state: %s\n' "$fw_global"
    printf -- '- Block all incoming: %s\n' "$fw_blockall"
    printf -- '- Stealth mode: %s\n' "$fw_stealth"
    printf -- '- App blocked (`%s`): %s\n\n' "$APP_PATH" "$fw_app"
  fi

  # ## App data
  printf '## App data\n\n'
  if [[ ! -d "$APP_DATA_DIR" ]]; then
    printf -- '- App data directory: not present\n'
    printf -- '- `synapseread.sqlite3`: not present\n'
    printf -- '- `library/`: not present\n'
    printf -- '- `sync-staging/`: not present\n\n'
  else
    printf -- '- App data directory: present\n'
    if [[ -f "${APP_DATA_DIR}/synapseread.sqlite3" ]]; then
      printf -- '- `synapseread.sqlite3`: present\n'
    else
      printf -- '- `synapseread.sqlite3`: not present\n'
    fi

    if [[ -d "${APP_DATA_DIR}/library" ]]; then
      local lib_count="unavailable" lib_kib="unavailable" lib_size_disp="unavailable"
      if lib_count="$(count_dir_files "${APP_DATA_DIR}/library")"; then
        lib_count="${lib_count} file(s)"
      else
        lib_count="unavailable"
      fi
      if lib_kib="$(measure_dir_kib "${APP_DATA_DIR}/library")"; then
        lib_size_disp="${lib_kib} KiB"
      else
        lib_size_disp="unavailable"
      fi
      printf -- '- `library/`: %s, %s\n' "$lib_count" "$lib_size_disp"
    else
      printf -- '- `library/`: not present\n'
    fi

    if [[ -d "${APP_DATA_DIR}/sync-staging" ]]; then
      local stg_count="unavailable" part_count="unavailable" stg_kib="unavailable" stg_size_disp="unavailable"
      local stg_files_disp="unavailable" stg_parts_disp="unavailable"
      if stg_count="$(count_dir_files "${APP_DATA_DIR}/sync-staging")"; then
        stg_files_disp="${stg_count} file(s)"
      fi
      if part_count="$(count_dir_files "${APP_DATA_DIR}/sync-staging" "*.part")"; then
        stg_parts_disp="${part_count} \`.part\`"
      fi
      if stg_kib="$(measure_dir_kib "${APP_DATA_DIR}/sync-staging")"; then
        stg_size_disp="${stg_kib} KiB"
      else
        stg_size_disp="unavailable"
      fi
      printf -- '- `sync-staging/`: %s (%s), %s\n\n' "$stg_files_disp" "$stg_parts_disp" "$stg_size_disp"
    else
      printf -- '- `sync-staging/`: not present\n\n'
    fi
  fi

  # ## Not observable from CLI
  printf '## Not observable from CLI\n\n'
  printf 'macOS provides no public CLI to inspect per-app Local Network privacy state. Record the **System Settings → Privacy & Security → Local Network** toggle for **SynapseRead** and any system alert text manually (with a screenshot).\n'
}

write_unique_report() {
  local out_dir="$1"
  local stamp="$2"
  local role="$3"
  local label="$4"
  local content="$5"

  if [[ ! -d "$out_dir" ]]; then
    mkdir -p "$out_dir"
  fi
  if [[ ! -w "$out_dir" ]]; then
    echo "Error: Output directory is not writable: $out_dir" >&2
    return 1
  fi

  local base="${out_dir%/}/${stamp}-${role}-${label}"
  local candidate="${base}.md"
  local seq=0

  # Use shell noclobber (O_CREAT|O_EXCL) so concurrent same-second runs never
  # overwrite an existing report file.
  while true; do
    if (
      set -C
      printf '%s\n' "$content" > "$candidate"
    ) 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
    if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
      echo "Error: Failed to write evidence report to '$candidate'." >&2
      return 1
    fi
    seq=$((seq + 1))
    if [[ "$seq" -gt 10000 ]]; then
      echo "Error: Too many filename collisions under '$out_dir' for '${stamp}-${role}-${label}'." >&2
      return 1
    fi
    candidate="${base}-${seq}.md"
  done
}

REPORT="$(collect_report)"
printf '%s\n' "$REPORT"

if [[ -n "$OUT_DIR" ]]; then
  STAMP="$(date '+%Y%m%dT%H%M%S')"
  OUT_FILE="$(write_unique_report "$OUT_DIR" "$STAMP" "$ROLE" "$LABEL" "$REPORT")"
  echo "Saved LAN evidence report to: $OUT_FILE" >&2
fi
