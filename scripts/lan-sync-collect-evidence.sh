#!/usr/bin/env bash
set -euo pipefail

# Read-only checkpoint snapshot tool for two-Mac LAN Book Sync validation (#147).
# Collects host, bundle, signature, process launch context, TCP listener,
# non-SSID IPv4 network, macOS Firewall, and aggregate app-data counts without
# making network calls or listing user book filenames.

usage() {
  cat <<'EOF'
Usage: scripts/lan-sync-collect-evidence.sh --role <mac-a|mac-b> --label <text> [options]

Options:
  --role <mac-a|mac-b>   Device role for this checkpoint (required)
  --label <text>         Checkpoint label, e.g. T-10-launch; chars [A-Za-z0-9._-] (required)
  --app <path>           Path to SynapseRead.app (default: /Applications/SynapseRead.app)
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

APP_PATH="${APP_PATH%/}"
[[ -z "$APP_PATH" ]] && APP_PATH="/"
if [[ ! -d "$APP_PATH" || "$APP_PATH" != *.app ]]; then
  echo "Error: App bundle directory not found or does not end in .app: $APP_PATH" >&2
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

  printf '## App bundle\n\n'
  printf -- '- Path: `%s`\n' "$APP_PATH"
  printf -- '- `CFBundleShortVersionString`: `%s`\n' "$short_ver"
  printf -- '- `CFBundleVersion`: `%s`\n' "$bundle_ver"
  printf -- '- `NSLocalNetworkUsageDescription`: %s\n' "$local_net_desc"
  printf -- '- `NSBonjourServices`: %s\n' "$bonjour_status"
  printf -- '- Executable architectures (`lipo -archs`): `%s`\n' "$bin_archs"
  printf -- '- Executable SHA-256: `%s`\n' "$bin_sha"
  printf -- '- Quarantine (`com.apple.quarantine`): %s\n\n' "$quarantine_status"

  # ## Code signature
  local cs_out="" cs_rc=0 signing_type="unsigned/unknown"
  cs_out="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1)" || cs_rc=$?

  printf '## Code signature\n\n'
  if [[ "$cs_rc" -eq 0 ]] || printf '%s\n' "$cs_out" | grep -Eq '^(Identifier=|Signature=|CodeDirectory )'; then
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

    local cd_line="" auth_val="" sig_val=""
    cd_line="$(printf '%s\n' "$cs_out" | grep -E '^CodeDirectory ' | head -n 1 || true)"
    sig_val="$(printf '%s\n' "$cs_out" | awk -F= '$1 == "Signature" { print $2; exit }' || true)"
    auth_val="${first_auth#Authority=}"

    if [[ "$cd_line" == *"linker-signed"* ]] || printf '%s\n' "$cs_out" | grep -Eq '^Info\.plist=not bound$'; then
      signing_type="linker-signed (Info.plist not bound) — NOT valid for #147"
    elif [[ "$sig_val" == "adhoc" ]]; then
      signing_type="adhoc (bound)"
    elif [[ -n "$auth_val" ]]; then
      if [[ "$auth_val" == "Developer ID Application"* ]]; then
        signing_type="Developer ID"
      else
        signing_type="Self-Signed (${auth_val})"
      fi
    else
      signing_type="unsigned/unknown"
    fi

    printf -- '- Signing type: %s\n\n' "$signing_type"
    printf '```text\n%s\n```\n\n' "${filtered_cs:-unavailable}"
  else
    printf -- '- Signing type: unsigned/unknown\n'
    printf -- '- `codesign -dv`: unavailable\n\n'
  fi

  # ## Process
  local pgrep_out="" pgrep_rc=0
  local -a pids=()
  pgrep_out="$(pgrep -x synapseread-desktop 2>&1)" || pgrep_rc=$?

  printf '## Process\n\n'
  if [[ "$pgrep_rc" -eq 0 && -n "$pgrep_out" ]]; then
    local line=""
    while IFS= read -r line; do
      line="$(printf '%s' "$line" | tr -d '[:space:]')"
      if [[ "$line" =~ ^[0-9]+$ ]]; then
        pids+=("$line")
      fi
    done <<< "$pgrep_out"
  fi

  if [[ ${#pids[@]} -gt 0 ]]; then
    local pid=""
    for pid in "${pids[@]}"; do
      local ps_info="" ppid_val="" launch_ctx=""
      ps_info="$(probe_value ps -o ppid=,user=,etime=,command= -p "$pid")"
      ppid_val="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ "$ppid_val" == "1" ]]; then
        launch_ctx="launchd (Finder/Dock/open) — valid launch context"
      elif [[ "$ppid_val" =~ ^[0-9]+$ ]]; then
        local pcomm=""
        pcomm="$(ps -o comm= -p "$ppid_val" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
        if [[ -z "$pcomm" ]]; then
          pcomm="unknown"
        fi
        launch_ctx="parent ${ppid_val} (${pcomm}) — Terminal/other launch, NOT valid permission evidence (T-45)"
      else
        launch_ctx="unavailable"
      fi
      printf -- '- PID `%s`: `%s`\n' "$pid" "$ps_info"
      printf -- '  - Launch context: %s\n' "$launch_ctx"
    done
    printf '\n'
  elif [[ "$pgrep_rc" -ne 0 && -n "$pgrep_out" ]]; then
    printf -- '- Status: unavailable\n\n'
  else
    printf -- '- Status: not running\n\n'
  fi

  # ## Listeners
  local listen_count="0" est_count="0" has_wildcard="false"
  local listen_display="0 listeners" port_range_display="none"

  if [[ ${#pids[@]} -gt 0 ]]; then
    local pids_csv=""
    pids_csv="$(IFS=,; echo "${pids[*]}")"

    local lsof_listen_out="" lsof_listen_rc=0
    lsof_listen_out="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:LISTEN 2>&1)" || lsof_listen_rc=$?
    if [[ "$lsof_listen_rc" -eq 0 && -n "$lsof_listen_out" ]] || printf '%s\n' "$lsof_listen_out" | grep -Eq '^(COMMAND|.*\(LISTEN\))'; then
      local data_lines=""
      data_lines="$(printf '%s\n' "$lsof_listen_out" | awk 'NR == 1 && $1 == "COMMAND" { next } NF > 0 { print }')"
      if [[ -n "$data_lines" ]]; then
        listen_count="$(printf '%s\n' "$data_lines" | wc -l | tr -d '[:space:]')"
        listen_display="$lsof_listen_out"
        if printf '%s\n' "$data_lines" | grep -Eq '(\*:|0\.0\.0\.0:)'; then
          has_wildcard="true"
        fi
      else
        listen_count="0"
        listen_display="0 listeners"
      fi
    elif [[ "$lsof_listen_rc" -ne 0 && -n "$lsof_listen_out" ]]; then
      listen_count="unavailable"
      listen_display="unavailable"
    fi

    local lsof_est_out="" lsof_est_rc=0
    lsof_est_out="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:ESTABLISHED 2>&1)" || lsof_est_rc=$?
    if [[ "$lsof_est_rc" -eq 0 && -n "$lsof_est_out" ]] || printf '%s\n' "$lsof_est_out" | grep -Eq '^(COMMAND|.*\(ESTABLISHED\))'; then
      local est_lines=""
      est_lines="$(printf '%s\n' "$lsof_est_out" | awk 'NR == 1 && $1 == "COMMAND" { next } NF > 0 { print }')"
      if [[ -n "$est_lines" ]]; then
        est_count="$(printf '%s\n' "$est_lines" | wc -l | tr -d '[:space:]')"
      else
        est_count="0"
      fi
    elif [[ "$lsof_est_rc" -ne 0 && -n "$lsof_est_out" ]]; then
      est_count="unavailable"
    fi
  fi

  local lsof_port_out="" lsof_port_rc=0
  lsof_port_out="$(lsof -nP -iTCP:49319-49328 -sTCP:LISTEN 2>&1)" || lsof_port_rc=$?
  if [[ "$lsof_port_rc" -eq 0 && -n "$lsof_port_out" ]] || printf '%s\n' "$lsof_port_out" | grep -Eq '^(COMMAND|.*\(LISTEN\))'; then
    local port_data=""
    port_data="$(printf '%s\n' "$lsof_port_out" | awk 'NR == 1 && $1 == "COMMAND" { next } NF > 0 { print }')"
    if [[ -n "$port_data" ]]; then
      port_range_display="$lsof_port_out"
    else
      port_range_display="none"
    fi
  elif [[ "$lsof_port_rc" -ne 0 && -n "$lsof_port_out" ]]; then
    port_range_display="unavailable"
  fi

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
  local fw_global fw_blockall fw_stealth fw_app
  fw_global="$(probe_firewall_arg --getglobalstate)"
  fw_blockall="$(probe_firewall_arg --getblockall)"
  fw_stealth="$(probe_firewall_arg --getstealthmode)"
  fw_app="$(probe_firewall_arg --getappblocked "$APP_PATH")"

  printf '## Firewall\n\n'
  printf -- '- Global state: %s\n' "$fw_global"
  printf -- '- Block all incoming: %s\n' "$fw_blockall"
  printf -- '- Stealth mode: %s\n' "$fw_stealth"
  printf -- '- App blocked (`%s`): %s\n\n' "$APP_PATH" "$fw_app"

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
      local lib_count="" lib_kib=""
      lib_count="$(find "${APP_DATA_DIR}/library" -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
      lib_kib="$(du -sk "${APP_DATA_DIR}/library" 2>/dev/null | awk '{print $1}')"
      printf -- '- `library/`: %s file(s), %s KiB\n' "${lib_count:-0}" "${lib_kib:-0}"
    else
      printf -- '- `library/`: not present\n'
    fi

    if [[ -d "${APP_DATA_DIR}/sync-staging" ]]; then
      local stg_count="" part_count="" stg_kib=""
      stg_count="$(find "${APP_DATA_DIR}/sync-staging" -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
      part_count="$(find "${APP_DATA_DIR}/sync-staging" -type f -name '*.part' 2>/dev/null | wc -l | tr -d '[:space:]')"
      stg_kib="$(du -sk "${APP_DATA_DIR}/sync-staging" 2>/dev/null | awk '{print $1}')"
      printf -- '- `sync-staging/`: %s file(s) (%s `.part`), %s KiB\n\n' "${stg_count:-0}" "${part_count:-0}" "${stg_kib:-0}"
    else
      printf -- '- `sync-staging/`: not present\n\n'
    fi
  fi

  # ## Not observable from CLI
  printf '## Not observable from CLI\n\n'
  printf 'macOS provides no public CLI to inspect per-app Local Network privacy state. Record the **System Settings → Privacy & Security → Local Network** toggle for **SynapseRead** and any system alert text manually (with a screenshot).\n'
}

REPORT="$(collect_report)"
printf '%s\n' "$REPORT"

if [[ -n "$OUT_DIR" ]]; then
  mkdir -p "$OUT_DIR"
  STAMP="$(date '+%Y%m%dT%H%M%S')"
  OUT_FILE="${OUT_DIR%/}/${STAMP}-${ROLE}-${LABEL}.md"
  printf '%s\n' "$REPORT" > "$OUT_FILE"
  echo "Saved LAN evidence report to: $OUT_FILE" >&2
fi
