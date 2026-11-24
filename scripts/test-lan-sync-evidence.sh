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

COPY_APP_DIR="${TMP_DIR}/copy/SynapseRead.app"
mkdir -p "${COPY_APP_DIR}/Contents/MacOS"
printf '#!/bin/sh\nexit 0\n' > "${COPY_APP_DIR}/Contents/MacOS/synapseread-desktop"
chmod +x "${COPY_APP_DIR}/Contents/MacOS/synapseread-desktop"
cp "${APP_DIR}/Contents/Info.plist" "${COPY_APP_DIR}/Contents/Info.plist"

DEV_DIR="${TMP_DIR}/target/debug"
mkdir -p "$DEV_DIR"
DEV_BIN="${DEV_DIR}/synapseread-desktop"
printf '#!/bin/sh\nexit 0\n' > "$DEV_BIN"
chmod +x "$DEV_BIN"

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
if [[ "$*" == *"--verify"* ]]; then
  if [[ -f "${STATE}/codesign_verify_fail" ]]; then
    cat "${STATE}/codesign_verify_fail" >&2
    exit 1
  fi
  if [[ -f "${STATE}/codesign.dv" ]]; then
    echo "valid on disk" >&2
    exit 0
  fi
  echo "code object is not signed at all" >&2
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
if [[ -f "${STATE}/pgrep_rc" ]]; then
  rc="$(cat "${STATE}/pgrep_rc")"
  if [[ -f "${STATE}/pgrep_stderr" ]]; then
    cat "${STATE}/pgrep_stderr" >&2
  fi
  if [[ -f "${STATE}/pgrep_stdout" ]]; then
    cat "${STATE}/pgrep_stdout"
  fi
  exit "$rc"
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
    -ww) shift ;;
    -o) fmt="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "$fmt" == "pid=" ]]; then
  echo "$pid"
  exit 0
fi
if [[ "$fmt" == "comm=" ]]; then
  if [[ -f "${STATE}/exec_${pid}" ]]; then
    cat "${STATE}/exec_${pid}"
    exit 0
  elif [[ -f "${STATE}/comm_${pid}" ]]; then
    cat "${STATE}/comm_${pid}"
    exit 0
  fi
fi
if [[ ! -f "${STATE}/ppid_${pid}" ]]; then
  exit 1
fi
if [[ "$fmt" == "uid=" ]]; then
  if [[ -f "${STATE}/uid_${pid}" ]]; then
    cat "${STATE}/uid_${pid}"
  else
    id -u
  fi
elif [[ "$fmt" == "ppid=" ]]; then
  cat "${STATE}/ppid_${pid}"
elif [[ "$fmt" == "comm=" ]]; then
  echo "${MOCK_DEFAULT_EXEC:?}"
elif [[ "$fmt" == "ppid=,user=,etime=,command=" ]]; then
  ppid_val="$(cat "${STATE}/ppid_${pid}")"
  exec_val="${MOCK_DEFAULT_EXEC:?}"
  if [[ -f "${STATE}/exec_${pid}" ]]; then
    exec_val="$(cat "${STATE}/exec_${pid}")"
  fi
  printf '%5s testuser    00:12 %s\n' "$ppid_val" "$exec_val"
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
  if [[ -f "${STATE}/lsof_listen_rc" ]]; then
    rc="$(cat "${STATE}/lsof_listen_rc")"
    [[ -f "${STATE}/lsof_listen_stderr" ]] && cat "${STATE}/lsof_listen_stderr" >&2
    [[ -f "${STATE}/lsof_listen_stdout" ]] && cat "${STATE}/lsof_listen_stdout"
    exit "$rc"
  fi
  if [[ -f "${STATE}/lsof_listen" && -s "${STATE}/lsof_listen" ]]; then
    cat "${STATE}/lsof_listen"
    exit 0
  fi
  exit 1
elif [[ "$args" == *"-sTCP:ESTABLISHED"* && "$args" == *"-p "* ]]; then
  if [[ -f "${STATE}/lsof_est_rc" ]]; then
    rc="$(cat "${STATE}/lsof_est_rc")"
    [[ -f "${STATE}/lsof_est_stderr" ]] && cat "${STATE}/lsof_est_stderr" >&2
    [[ -f "${STATE}/lsof_est_stdout" ]] && cat "${STATE}/lsof_est_stdout"
    exit "$rc"
  fi
  if [[ -f "${STATE}/lsof_est" && -s "${STATE}/lsof_est" ]]; then
    cat "${STATE}/lsof_est"
    exit 0
  fi
  exit 1
elif [[ "$args" == *"49319-49328"* ]]; then
  if [[ -f "${STATE}/lsof_ports_rc" ]]; then
    rc="$(cat "${STATE}/lsof_ports_rc")"
    [[ -f "${STATE}/lsof_ports_stderr" ]] && cat "${STATE}/lsof_ports_stderr" >&2
    [[ -f "${STATE}/lsof_ports_stdout" ]] && cat "${STATE}/lsof_ports_stdout"
    exit "$rc"
  fi
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
    MOCK_DEFAULT_EXEC="${APP_DIR}/Contents/MacOS/synapseread-desktop" \
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

echo "6. happy path ad hoc bound, strict verify valid, ppid=1, single bound IP listener"
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
assert_contains "$OUT_6" "Signature integrity (\`codesign --verify --deep --strict\`): valid" "test 6 integrity valid"
assert_contains "$OUT_6" "ppid=1 (launchd child" "test 6 ppid=1 observation"
assert_contains "$OUT_6" "confirm Finder double-click manually" "test 6 Finder confirmation note"
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
assert_contains "$OUT_7" "linker-signed" "test 7 linker-signed label"
assert_contains "$OUT_7" "NOT valid for #147" "test 7 linker-signed warning"
assert_not_contains "$OUT_7" "adhoc (bound)" "test 7 not reported as adhoc bound"

echo "8. tampered Info.plist (verify fails without linker-signed flag) is NOT misclassified as linker-signed"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=80208 flags=0x2(adhoc) hashes=2500+3 location=embedded
CDHash=fb17227914613dee15b3ab8bc1225cf252410bfc
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
CS
echo "${APP_DIR}: invalid Info.plist (plist or signature have been modified)" > "${MOCK_STATE}/codesign_verify_fail"
OUT_8="$(run_collector --role mac-a --label tampered-plist --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_not_contains "$OUT_8" "linker-signed" "test 8 tampered plist must not be called linker-signed"
assert_contains "$OUT_8" "Signature integrity (\`codesign --verify --deep --strict\`): INVALID" "test 8 integrity INVALID"
assert_contains "$OUT_8" "invalid Info.plist (plist or signature have been modified)" "test 8 verify detail"
assert_contains "$OUT_8" "NOT valid for #147" "test 8 invalid for #147"

echo "9. bundle/executable process binding: dev + installed coexist, and unlaunched /tmp copy ignores running /Applications"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
printf '4242\n5150\n' > "${MOCK_STATE}/pids"
echo "1" > "${MOCK_STATE}/ppid_4242"
echo "${APP_DIR}/Contents/MacOS/synapseread-desktop" > "${MOCK_STATE}/exec_4242"
echo "900" > "${MOCK_STATE}/ppid_5150"
echo "/bin/zsh" > "${MOCK_STATE}/comm_900"
echo "${DEV_BIN}" > "${MOCK_STATE}/exec_5150"
cat > "${MOCK_STATE}/lsof_listen" <<'LSOF'
COMMAND    PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
synapsere 4242 testuser   14u  IPv4 0x1234567890abcdef      0t0  TCP 192.168.1.10:49319 (LISTEN)
LSOF

# 9a: targeting APP_DIR matches only 4242 and excludes dev 5150
OUT_9A="$(run_collector --role mac-a --label coexist-app --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_9A" 'PID `4242`' "test 9a installed pid included"
assert_not_contains "$OUT_9A" 'PID `5150`' "test 9a dev pid excluded"
assert_contains "$OUT_9A" "Excluded other-executable/other-user PIDs: 1" "test 9a excluded count"
assert_contains "$OUT_9A" "SynapseRead LISTEN sockets: 1" "test 9a listener count"

# 9b: targeting dev executable via --executable matches only 5150 and excludes installed 4242
rm -f "${MOCK_STATE}/lsof_listen"
OUT_9B="$(run_collector --role mac-b --label T-45-dev --app "$APP_DIR" --executable "$DEV_BIN" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_9B" 'PID `5150`' "test 9b dev pid included"
assert_not_contains "$OUT_9B" 'PID `4242`' "test 9b installed pid excluded"
assert_contains "$OUT_9B" "NOT valid Finder permission evidence (T-45)" "test 9b terminal parent warning"
assert_contains "$OUT_9B" "(/bin/zsh)" "test 9b parent comm"

# 9c: pointing --app at unlaunched COPY_APP_DIR reports not running and 0 listeners even while APP_DIR and DEV_BIN run
OUT_9C="$(run_collector --role mac-a --label unlaunched-copy --app "$COPY_APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_9C" "Status: not running" "test 9c copy app not running"
assert_contains "$OUT_9C" "Excluded other-executable/other-user PIDs: 2" "test 9c both running procs excluded"
assert_contains "$OUT_9C" "SynapseRead LISTEN sockets: 0" "test 9c zero listeners for unlaunched copy"
assert_not_contains "$OUT_9C" "ppid=1" "test 9c never leaks ppid=1 from other bundle"

echo "10. pgrep failure (empty rc=2 and diagnostic rc=2) must NOT emit zero listeners; confirmed rc=1 empty emits not running + 0"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
echo "2" > "${MOCK_STATE}/pgrep_rc"
OUT_10A="$(run_collector --role mac-a --label pgrep-empty-fail --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_10A" "Status: unavailable (process probe failed)" "test 10a empty rc=2 unavailable"
assert_contains "$OUT_10A" "SynapseRead LISTEN sockets: unavailable" "test 10a LISTEN unavailable"
assert_contains "$OUT_10A" "SynapseRead ESTABLISHED sockets: unavailable" "test 10a ESTABLISHED unavailable"
assert_not_contains "$OUT_10A" "not running" "test 10a must not say not running"
assert_not_contains "$OUT_10A" "0 listeners" "test 10a must not say 0 listeners"

echo "pgrep: invalid option" > "${MOCK_STATE}/pgrep_stderr"
OUT_10B="$(run_collector --role mac-a --label pgrep-diag-fail --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_10B" "Status: unavailable (process probe failed)" "test 10b diag rc=2 unavailable"
assert_contains "$OUT_10B" "SynapseRead LISTEN sockets: unavailable" "test 10b LISTEN unavailable"
assert_contains "$OUT_10B" "SynapseRead ESTABLISHED sockets: unavailable" "test 10b ESTABLISHED unavailable"
assert_not_contains "$OUT_10B" "SynapseRead LISTEN sockets: 0" "test 10b must not emit 0 LISTEN"

rm -f "${MOCK_STATE}/pgrep_rc" "${MOCK_STATE}/pgrep_stderr"
OUT_10C="$(run_collector --role mac-b --label T-10-quit --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_10C" "Status: not running" "test 10c confirmed no-match"
assert_contains "$OUT_10C" "SynapseRead LISTEN sockets: 0" "test 10c confirmed 0 LISTEN"
assert_contains "$OUT_10C" "SynapseRead ESTABLISHED sockets: 0" "test 10c confirmed 0 ESTABLISHED"

echo "11. lsof failure when process is matched must NOT emit zero sockets"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
echo "4242" > "${MOCK_STATE}/pids"
echo "1" > "${MOCK_STATE}/ppid_4242"
echo "2" > "${MOCK_STATE}/lsof_listen_rc"
echo "2" > "${MOCK_STATE}/lsof_est_rc"
echo "1" > "${MOCK_STATE}/lsof_ports_rc"
echo "lsof: port probe error" > "${MOCK_STATE}/lsof_ports_stderr"
OUT_11="$(run_collector --role mac-a --label lsof-fail --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_11" "SynapseRead LISTEN sockets: unavailable" "test 11 LISTEN unavailable"
assert_contains "$OUT_11" "SynapseRead ESTABLISHED sockets: unavailable" "test 11 ESTABLISHED unavailable"
assert_not_contains "$OUT_11" "0 listeners" "test 11 must not say 0 listeners"
assert_not_contains "$OUT_11" "SynapseRead LISTEN sockets: 0" "test 11 must not emit 0 LISTEN"

echo "12. app-data counts library and sync-staging accurately with newline filenames, empty dirs, find/du failures, without leaking filenames"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
APP_DATA_12="${TMP_DIR}/appdata12"
mkdir -p "${APP_DATA_12}/library" "${APP_DATA_12}/sync-staging"
printf 'book-nl' > "${APP_DATA_12}/library/secret-line1"$'\n'"secret-line2.epub"
printf 'part-nl' > "${APP_DATA_12}/sync-staging/staging-line1"$'\n'"staging-line2.part"
touch "${APP_DATA_12}/synapseread.sqlite3"
OUT_12A="$(run_collector --role mac-b --label appdata-newline --app "$APP_DIR" --app-data "$APP_DATA_12")"
assert_contains "$OUT_12A" '`synapseread.sqlite3`: present' "test 12a db present"
assert_contains "$OUT_12A" '`library/`: 1 file(s),' "test 12a newline library count is 1"
assert_contains "$OUT_12A" '`sync-staging/`: 1 file(s) (1 `.part`),' "test 12a newline staging count is 1"
assert_not_contains "$OUT_12A" "secret-line1" "test 12a no library filename leak"
assert_not_contains "$OUT_12A" "staging-line1" "test 12a no staging filename leak"

APP_DATA_EMPTY="${TMP_DIR}/appdata_empty"
mkdir -p "${APP_DATA_EMPTY}/library" "${APP_DATA_EMPTY}/sync-staging"
OUT_12B="$(run_collector --role mac-b --label appdata-empty --app "$APP_DIR" --app-data "$APP_DATA_EMPTY")"
assert_contains "$OUT_12B" '`library/`: 0 file(s), 0 KiB' "test 12b empty library"
assert_contains "$OUT_12B" '`sync-staging/`: 0 file(s) (0 `.part`), 0 KiB' "test 12b empty staging"

# Mock find and du failures
cat > "${MOCK_BIN}/find" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "${MOCK_BIN}/du" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "${MOCK_BIN}/find" "${MOCK_BIN}/du"
OUT_12C="$(run_collector --role mac-b --label appdata-fail --app "$APP_DIR" --app-data "$APP_DATA_12")"
assert_contains "$OUT_12C" '`library/`: unavailable, unavailable' "test 12c library find+du fail"
assert_contains "$OUT_12C" '`sync-staging/`: unavailable (unavailable), unavailable' "test 12c staging find+du fail"
assert_not_contains "$OUT_12C" "0 KiB" "test 12c du failure must not report 0 KiB"
rm -f "${MOCK_BIN}/find" "${MOCK_BIN}/du"

echo "13. --out writes timestamped file equal to stdout"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Authority=SynapseRead Local Signing
Info.plist entries=16
CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+0 location=embedded
CS
OUT_DIR_13="${TMP_DIR}/evidence_out"
STDOUT_13="$(run_collector --role mac-a --label out-check --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data" --out "$OUT_DIR_13" 2>"${TMP_DIR}/err13.log")"
FILE_COUNT_13="$(find "$OUT_DIR_13" -maxdepth 1 -type f -name '*-mac-a-out-check.md' | wc -l | tr -d '[:space:]')"
if [[ "$FILE_COUNT_13" -ne 1 ]]; then
  echo "[FAIL] expected 1 output file under $OUT_DIR_13, got $FILE_COUNT_13" >&2
  exit 1
fi
SAVED_13="$(find "$OUT_DIR_13" -maxdepth 1 -type f -name '*-mac-a-out-check.md' | head -n 1)"
if ! diff -u <(printf '%s\n' "$STDOUT_13") "$SAVED_13"; then
  echo "[FAIL] saved file content differs from stdout" >&2
  exit 1
fi
assert_contains "$STDOUT_13" "Self-Signed (SynapseRead Local Signing)" "test 13 self-signed detection"

echo "14. wildcard listener *:49319 triggers WARNING"
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
OUT_14="$(run_collector --role mac-a --label wildcard-check --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_14" "WARNING: wildcard listener" "test 14 wildcard warning"

echo "15. --pid mismatched executable is excluded cleanly (not bound)"
reset_state
cat > "${MOCK_STATE}/codesign.dv" <<'CS'
Identifier=app.synapseread.desktop
Signature=adhoc
Info.plist entries=16
CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded
CS
echo "1" > "${MOCK_STATE}/ppid_7777"
echo "${DEV_BIN}" > "${MOCK_STATE}/exec_7777"
OUT_15="$(run_collector --role mac-a --label pid-mismatch --app "$APP_DIR" --pid 7777 --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_15" "Status: not running" "test 15 mismatched pid not attached to app"
assert_contains "$OUT_15" "SynapseRead LISTEN sockets: 0" "test 15 zero listeners"

echo "16. failing probes still exit 0 and print unavailable without zero-listener false positives"
reset_state
touch "${MOCK_STATE}/fail_all"
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
OUT_16="$(run_collector --role mac-a --label fail-probes --app "$APP_DIR" --app-data "${TMP_DIR}/missing-data")"
assert_contains "$OUT_16" "OS: unavailable" "test 16 OS unavailable"
assert_contains "$OUT_16" "Architecture: \`unavailable\`" "test 16 arch unavailable"
assert_contains "$OUT_16" "CPU / Chip: unavailable" "test 16 cpu unavailable"
assert_contains "$OUT_16" "Signing type: unavailable" "test 16 codesign type unavailable"
assert_contains "$OUT_16" "Signature integrity (\`codesign --verify --deep --strict\`): unavailable" "test 16 codesign verify unavailable"
assert_contains "$OUT_16" "Status: unavailable" "test 16 process unavailable"
assert_contains "$OUT_16" "SynapseRead LISTEN sockets: unavailable" "test 16 LISTEN unavailable"
assert_contains "$OUT_16" "SynapseRead ESTABLISHED sockets: unavailable" "test 16 ESTABLISHED unavailable"
assert_contains "$OUT_16" "Global state: unavailable" "test 16 firewall unavailable"

echo "All 16 LAN evidence collector tests passed."
