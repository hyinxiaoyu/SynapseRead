#!/usr/bin/env bash
set -euo pipefail

# Regression tests for scripts/lan-sync-collect-evidence.sh.
# Uses stateful mocked CLIs in a temporary directory; makes zero network calls.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COLLECTOR="${SCRIPT_DIR}/lan-sync-collect-evidence.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synapseread-lan-evidence-tests.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

MOCK_BIN="${TMP_DIR}/bin"
MOCK_STATE="${TMP_DIR}/state"
mkdir -p "$MOCK_BIN" "$MOCK_STATE"

APP_DIR="${TMP_DIR}/SynapseRead.app"
mkdir -p "${APP_DIR}/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "${APP_DIR}/Contents/MacOS/synapseread-desktop"
chmod +x "${APP_DIR}/Contents/MacOS/synapseread-desktop"
cat > "${APP_DIR}/Contents/Info.plist" <<'PLIST'
CFBundleIdentifier=app.synapseread.desktop
CFBundleShortVersionString=0.1.0
CFBundleVersion=0.1.0
NSLocalNetworkUsageDescription=SynapseRead uses your local network only when you choose to share or import books with another device on the same network.
PLIST

WEBKIT_PLIST="${TMP_DIR}/WebKit-Info.plist"
cat > "$WEBKIT_PLIST" <<'PLIST'
CFBundleVersion=20621.3.11.11.3
PLIST

FAKE_FW="${MOCK_BIN}/socketfilterfw"

cat > "${MOCK_BIN}/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
if [[ "${1:-}" == "-s" ]]; then
  if [[ -f "${STATE}/uname_s" ]]; then
    cat "${STATE}/uname_s"
  else
    echo "Darwin"
  fi
  exit 0
fi
if [[ "${1:-}" == "-m" ]]; then
  echo "arm64"
  exit 0
fi
/usr/bin/uname "$@"
EOF

cat > "${MOCK_BIN}/sw_vers" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
case "${1:-}" in
  -productVersion) echo "15.6.1" ;;
  -buildVersion) echo "24G90" ;;
  *) exit 1 ;;
esac
EOF

cat > "${MOCK_BIN}/sysctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
case "${2:-}" in
  machdep.cpu.brand_string) echo "Apple M4" ;;
  hw.memsize) echo "25769803776" ;;
  *) exit 1 ;;
esac
EOF

cat > "${MOCK_BIN}/plutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
if [[ "${1:-}" == "-extract" && "${3:-}" == "raw" && "${4:-}" == "-o" && "${5:-}" == "-" ]]; then
  key="$2"
  file="$6"
  val="$(awk -F= -v k="$key" '$1 == k { print substr($0, index($0, "=") + 1); found=1; exit } END { if (!found) exit 1 }' "$file" 2>/dev/null)" || exit 1
  printf '%s\n' "$val"
  exit 0
fi
if [[ "${1:-}" == "-p" ]]; then
  cat "$2"
  exit 0
fi
exit 1
EOF

cat > "${MOCK_BIN}/lipo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
if [[ "${1:-}" == "-archs" ]]; then
  echo "arm64"
  exit 0
fi
exit 1
EOF

cat > "${MOCK_BIN}/codesign" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  echo "codesign: mocked failure" >&2
  exit 1
fi
if [[ -f "${STATE}/codesign.dv" ]]; then
  cat "${STATE}/codesign.dv" >&2
  exit 0
fi
echo "code object is not signed at all" >&2
exit 1
EOF

cat > "${MOCK_BIN}/xattr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  echo "xattr: mocked failure" >&2
  exit 1
fi
if [[ "${1:-}" == "-p" ]]; then
  if [[ -f "${STATE}/quarantine_present" ]]; then
    echo "0181;67410000;Safari;12345"
    exit 0
  fi
  echo "xattr: ${3:-}: No such xattr: ${2:-}" >&2
  exit 1
fi
exit 0
EOF

cat > "${MOCK_BIN}/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  echo "pgrep: mocked failure" >&2
  exit 2
fi
if [[ -f "${STATE}/pids" && -s "${STATE}/pids" ]]; then
  cat "${STATE}/pids"
  exit 0
fi
exit 1
EOF

cat > "${MOCK_BIN}/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
fmt=""
pid=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) fmt="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$fmt" == "ppid=" ]]; then
  cat "${STATE}/ppid_${pid}"
elif [[ "$fmt" == "comm=" ]]; then
  cat "${STATE}/comm_${pid}"
elif [[ "$fmt" == "ppid=,user=,etime=,command=" ]]; then
  ppid_val="$(cat "${STATE}/ppid_${pid}")"
  printf '%5s testuser    00:12 /Applications/SynapseRead.app/Contents/MacOS/synapseread-desktop\n' "$ppid_val"
else
  exit 1
fi
EOF

cat > "${MOCK_BIN}/lsof" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  echo "lsof: mocked failure" >&2
  exit 1
fi
args="$*"
if [[ "$args" == *"-sTCP:LISTEN"* && "$args" == *"-p "* ]]; then
  if [[ -f "${STATE}/lsof_listen" && -s "${STATE}/lsof_listen" ]]; then
    cat "${STATE}/lsof_listen"
    exit 0
  fi
  exit 1
elif [[ "$args" == *"-sTCP:ESTABLISHED"* && "$args" == *"-p "* ]]; then
  if [[ -f "${STATE}/lsof_est" && -s "${STATE}/lsof_est" ]]; then
    cat "${STATE}/lsof_est"
    exit 0
  fi
  exit 1
elif [[ "$args" == *"49319-49328"* ]]; then
  if [[ -f "${STATE}/lsof_ports" && -s "${STATE}/lsof_ports" ]]; then
    cat "${STATE}/lsof_ports"
    exit 0
  fi
  exit 1
fi
exit 1
EOF

cat > "${MOCK_BIN}/ifconfig" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
cat <<'IFACE'
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 192.168.1.10 netmask 0xffffff00 broadcast 192.168.1.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
	inet 100.114.162.67 --> 100.114.162.67 netmask 0xffffffff
IFACE
EOF

cat > "${MOCK_BIN}/route" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
cat <<'ROUTE'
   route to: default
destination: default
    gateway: 192.168.1.1
  interface: en1
ROUTE
EOF

cat > "$FAKE_FW" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_STATE:?}"
if [[ -f "${STATE}/fail_all" ]]; then
  exit 1
fi
case "${1:-}" in
  --getglobalstate) echo "Firewall is disabled. (State = 0)" ;;
  --getblockall) echo "Firewall has block all state set to disabled." ;;
  --getstealthmode) echo "Firewall stealth mode is off" ;;
  --getappblocked) echo "Incoming connection to ${2:-} is permitted." ;;
  *) exit 1 ;;
esac
EOF

chmod +x "$MOCK_BIN"/*

reset_state() {
  rm -rf "${MOCK_STATE:?}"/*
}

run_collector() {
  PATH="${MOCK_BIN}:/usr/bin:/bin" \
    MOCK_STATE="$MOCK_STATE" \
    SYNAPSEREAD_SOCKETFILTERFW="$FAKE_FW" \
    SYNAPSEREAD_WEBKIT_PLIST="$WEBKIT_PLIST" \
    /bin/bash "$COLLECTOR" "$@"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local desc="$3"
  if ! printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    echo "[FAIL] ${desc}: expected output to contain '${needle}'" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local desc="$3"
  if printf '%s\n' "$haystack" | grep -Fq -- "$needle"; then
    echo "[FAIL] ${desc}: expected output NOT to contain '${needle}'" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

echo "1. missing --role exits non-zero and prints usage"
reset_state
ERR_1="$(run_collector --label T-10-launch --app "$APP_DIR" 2>&1 || true)"
if run_collector --label T-10-launch --app "$APP_DIR" >/dev/null 2>&1; then
  echo "[FAIL] expected missing --role to exit non-zero" >&2
  exit 1
fi
assert_contains "$ERR_1" "Usage:" "missing --role usage"

echo "2. invalid --role mac-c is rejected"
reset_state
if run_collector --role mac-c --label T-10-launch --app "$APP_DIR" >/dev/null 2>&1; then
  echo "[FAIL] expected invalid --role mac-c to fail" >&2
  exit 1
fi

echo "3. invalid --label characters are rejected"
reset_state
if run_collector --role mac-a --label "bad/label" --app "$APP_DIR" >/dev/null 2>&1; then
  echo "[FAIL] expected invalid --label to fail" >&2
  exit 1
fi

echo "4. missing --app path is rejected"
reset_state
if run_collector --role mac-a --label T-10-launch --app "${TMP_DIR}/Missing.app" >/dev/null 2>&1; then
  echo "[FAIL] expected missing --app to fail" >&2
  exit 1
fi

echo "5. non-Darwin host is rejected"
reset_state
echo "Linux" > "${MOCK_STATE}/uname_s"
if run_collector --role mac-a --label T-10-launch --app "$APP_DIR" >/dev/null 2>&1; then
  echo "[FAIL] expected non-Darwin host to fail" >&2
  exit 1
fi

echo "6. happy path ad hoc bound, ppid=1, single bound IP listener"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=80208 flags=0x2(adhoc) hashes=2500+3 location=embedded
CDHash=fb17227914613dee15b3ab8bc1225cf252410bfc
Signature=adhoc
Info.plist entries=16
TeamIdentifier=not set
CS
echo "4242" > "${MOCK_STATE}/pids"
echo "1" > "${MOCK_STATE}/ppid_4242"
cat > "${MOCK_STATE}/lsof_listen" <<'LSOF'
COMMAND    PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
synapsere 4242 testuser   14u  IPv4 0x1234567890abcdef      0t0  TCP 192.168.1.10:49319 (LISTEN)
LSOF
cat > "${MOCK_STATE}/lsof_ports" <<'LSOF'
COMMAND    PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
synapsere 4242 testuser   14u  IPv4 0x1234567890abcdef      0t0  TCP 192.168.1.10:49319 (LISTEN)
LSOF
OUT_6="$(run_collector --role mac-a --label T-10-share --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data" --build-sha c05a3c6)"
for heading in \
  "# SynapseRead LAN evidence: mac-a T-10-share" \
  "## Host" \
  "## App bundle" \
  "## Code signature" \
  "## Process" \
  "## Listeners" \
  "## Network" \
  "## Firewall" \
  "## App data" \
  "## Not observable from CLI"; do
  assert_contains "$OUT_6" "$heading" "test 6 heading"
done
assert_contains "$OUT_6" "Signing type: adhoc (bound)" "test 6 signing type"
assert_contains "$OUT_6" "valid launch context" "test 6 launch context"
assert_contains "$OUT_6" "SynapseRead LISTEN sockets: 1" "test 6 listener count"
assert_contains "$OUT_6" "SynapseRead uses your local network only when you choose to share or import books with another device on the same network." "test 6 local network desc"
assert_contains "$OUT_6" "utun4\` [VPN]" "test 6 VPN mark"
assert_not_contains "$OUT_6" "WARNING: wildcard" "test 6 no wildcard warning"

echo "7. linker-signed bundle is flagged NOT valid for #147"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded
CDHash=1111111111111111111111111111111111111111
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
CS
OUT_7="$(run_collector --role mac-a --label linker-check --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_7" "NOT valid for #147" "test 7 linker-signed warning"
assert_not_contains "$OUT_7" "adhoc (bound)" "test 7 not reported as adhoc bound"

echo "8. non-launchd parent process is flagged T-45; not running shows 0 listeners"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
echo "5150" > "${MOCK_STATE}/pids"
echo "900" > "${MOCK_STATE}/ppid_5150"
echo "/bin/zsh" > "${MOCK_STATE}/comm_900"
OUT_8A="$(run_collector --role mac-b --label T-45-terminal --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_8A" "NOT valid permission evidence (T-45)" "test 8a terminal parent warning"
assert_contains "$OUT_8A" "(/bin/zsh)" "test 8a parent comm"

rm -f "${MOCK_STATE}/pids"
OUT_8B="$(run_collector --role mac-b --label T-10-quit --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_8B" "not running" "test 8b not running"
assert_contains "$OUT_8B" "SynapseRead LISTEN sockets: 0" "test 8b zero listeners"

echo "9. app-data counts library and sync-staging without leaking filenames"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
APP_DATA_9="${TMP_DIR}/appdata9"
mkdir -p "${APP_DATA_9}/library" "${APP_DATA_9}/sync-staging"
printf 'secret-book-1' > "${APP_DATA_9}/library/secret-private-title-one.epub"
printf 'secret-book-2' > "${APP_DATA_9}/library/secret-private-title-two.pdf"
printf 'partial' > "${APP_DATA_9}/sync-staging/secret-staging-item.part"
touch "${APP_DATA_9}/synapseread.sqlite3"
OUT_9="$(run_collector --role mac-b --label appdata-check --app "$APP_DIR" --app-data "$APP_DATA_9")"
assert_contains "$OUT_9" '`synapseread.sqlite3`: present' "test 9 db present"
assert_contains "$OUT_9" '`library/`: 2 file(s)' "test 9 library count"
assert_contains "$OUT_9" '`sync-staging/`: 1 file(s) (1 `.part`)' "test 9 staging count"
assert_not_contains "$OUT_9" "secret-private-title-one" "test 9 no library filename leak"
assert_not_contains "$OUT_9" "secret-staging-item" "test 9 no staging filename leak"

echo "10. --out writes timestamped file equal to stdout"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Authority=SynapseRead Local Signing
Info.plist entries=16
CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded
CS
OUT_DIR_10="${TMP_DIR}/evidence_out"
STDOUT_10="$(run_collector --role mac-a --label out-check --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data" --out "$OUT_DIR_10" 2>"${TMP_DIR}/err10.log")"
FILE_COUNT_10="$(find "$OUT_DIR_10" -maxdepth 1 -type f -name '*-mac-a-out-check.md' | wc -l | tr -d '[:space:]')"
if [[ "$FILE_COUNT_10" -ne 1 ]]; then
  echo "[FAIL] expected 1 output file under $OUT_DIR_10, got $FILE_COUNT_10" >&2
  exit 1
fi
SAVED_10="$(find "$OUT_DIR_10" -maxdepth 1 -type f -name '*-mac-a-out-check.md' | head -n 1)"
if ! diff -u <(printf '%s\n' "$STDOUT_10") "$SAVED_10"; then
  echo "[FAIL] saved file content differs from stdout" >&2
  exit 1
fi
assert_contains "$STDOUT_10" "Self-Signed (SynapseRead Local Signing)" "test 10 self-signed detection"

echo "11. wildcard listener *:49319 triggers WARNING"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
echo "6001" > "${MOCK_STATE}/pids"
echo "1" > "${MOCK_STATE}/ppid_6001"
cat > "${MOCK_STATE}/lsof_listen" <<'LSOF'
COMMAND    PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
synapsere 6001 testuser   14u  IPv4 0x1234567890abcdef      0t0  TCP *:49319 (LISTEN)
LSOF
OUT_11="$(run_collector --role mac-a --label wildcard-check --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_11" "WARNING: wildcard listener" "test 11 wildcard warning"

echo "12. failing probes still exit 0 and print unavailable"
reset_state
touch "${MOCK_STATE}/fail_all"
# Override uname only to still pass the Darwin OS gate while failing -m
cat > "${MOCK_BIN}/uname" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-s" ]]; then
  echo "Darwin"
  exit 0
fi
exit 1
EOF
chmod +x "${MOCK_BIN}/uname"
OUT_12="$(run_collector --role mac-a --label fail-probes --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_12" "OS: unavailable" "test 12 OS unavailable"
assert_contains "$OUT_12" "Architecture: \`unavailable\`" "test 12 arch unavailable"
assert_contains "$OUT_12" "CPU / Chip: unavailable" "test 12 cpu unavailable"
assert_contains "$OUT_12" "codesign -dv\`: unavailable" "test 12 codesign unavailable"
assert_contains "$OUT_12" "Status: unavailable" "test 12 process unavailable"
assert_contains "$OUT_12" "Global state: unavailable" "test 12 firewall unavailable"

echo "All 12 LAN evidence collector tests passed."
