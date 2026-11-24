# Two-Mac LAN Book Sync Validation Runbook (`#147` / `LS-20`)

> Step-by-step manual validation protocol and evidence templates for closing V1 LAN Book Sync (`#147`, `#132`) under [ADR 0008](adr/0008-lan-book-sync.md) (`OD-2 Rev 2`).

## 1. Purpose and Scope

This runbook translates the pending native two-Mac acceptance matrix in [ADR 0008](adr/0008-lan-book-sync.md#pending-two-mac-finder-acceptance-147-od-2-rev-2) (`#147` / `LS-20`) into an executable checklist across two physical `macOS 15+` Macs (`Mac A` and `Mac B`).

Under **`OD-2 Rev 2`** (self-used open-source policy):

- Paid Apple Developer ID signing and notarization ([`docs/MACOS_SIGNING.md`](MACOS_SIGNING.md)) remain supported for public distribution, not a V1 gate.
- `#147` accepts packaged `.app` builds from **one single `main` commit SHA**, signed with either `--local-sign "<identity>"` (recommended) or `--adhoc-sign`, installed in `/Applications/SynapseRead.app`, and launched from **Finder** (never `pnpm dev` or Terminal).
- Do not close `#147` or `#132` until both `M-perm` and `M-pack` pass (or every deviation has a filed `fix/*` PR / owner-accepted exception) and **Track C** records the evidence in `docs/adr/0008-lan-book-sync.md`, `docs/ROADMAP.md`, and `README.md`.

---

## 2. Prerequisites

1. **Two Macs on `macOS 15+`**: Designate `Mac A` (initial source) and `Mac B` (initial receiver), plus a fresh macOS user account or VM snapshot for first-prompt `M-perm` checks (`UA-12`).
2. **Single Source Commit SHA**: Build on one clean `main` commit SHA (record `git rev-parse HEAD`). Never mix two builds from different commits.
3. **Build and Verify the Packaged App** (choose one valid `#147` mode per [MACOS_SIGNING.md](MACOS_SIGNING.md#self-use--open-source-macos-builds-no-apple-developer-account)):

   ```sh
   # Option A (recommended): local Keychain Code Signing certificate
   scripts/macos-build-signed.sh --target aarch64-apple-darwin --local-sign "SynapseRead Local Signing"
   scripts/verify-macos-bundle.sh \
     --app target/aarch64-apple-darwin/release/bundle/macos/SynapseRead.app \
     --dmg target/aarch64-apple-darwin/release/bundle/dmg/SynapseRead_0.1.0_aarch64.dmg \
     --require-local-signed

   # Option B (zero certificate): ad hoc signature with bound Info.plist
   scripts/macos-build-signed.sh --target aarch64-apple-darwin --adhoc-sign
   scripts/verify-macos-bundle.sh \
     --app target/aarch64-apple-darwin/release/bundle/macos/SynapseRead.app \
     --dmg target/aarch64-apple-darwin/release/bundle/dmg/SynapseRead_0.1.0_aarch64.dmg \
     --require-adhoc-bound
   ```

   > **Invalid for `#147`:** Do **not** use `--allow-unsigned` (linker-signed `Info.plist=not bound`) or `pnpm dev` / Terminal launches (per Apple TN3179, Terminal bypasses app-level Local Network prompts).

4. **Install on Both Macs**:
   - Mount the verified `.dmg` and drag `SynapseRead.app` into `/Applications/` on both `Mac A` and `Mac B`.
   - If copied over AirDrop or local transfer, clear quarantine once:

     ```sh
     xattr -dr com.apple.quarantine /Applications/SynapseRead.app
     ```

   - Run the evidence collector on both Macs before starting and confirm both show the **same `CDHash`**, **Signing type** (`Self-Signed (...)` or `adhoc (bound)`), and **`Signature integrity` = `valid`**.
5. **Launch Method**: Always double-click `/Applications/SynapseRead.app` from **Finder** (only `T-45` intentionally launches a dev build from Terminal).
6. **Test Fixtures & Privacy**:
   - Use non-sensitive synthetic or public-domain test files (`PDF`, `EPUB`, `TXT`, `.md`, plus a `>= 1 GB` test fixture for `T-18`, `T-27`, `T-48`).
   - **Never** commit personal documents, SQLite databases, screenshots with private data, or raw evidence logs into the repository.

---

## 3. Evidence Collection

Use the read-only checkpoint collector [`scripts/lan-sync-collect-evidence.sh`](../scripts/lan-sync-collect-evidence.sh) on the active Mac(s) at each checkpoint. It makes **no network calls**, **never modifies app data**, **never prints user book filenames**, and binds process/listener inspection strictly to the current user and `--app` (or `--executable`) path.

```sh
# Store all evidence outside the SynapseRead repository:
EVIDENCE_DIR="$HOME/SynapseRead-LAN-evidence"
BUILD_SHA="$(git -C /path/to/SynapseRead rev-parse HEAD)"

# Example checkpoint on Mac A at launch:
scripts/lan-sync-collect-evidence.sh \
  --role mac-a \
  --label T-10-launch \
  --build-sha "$BUILD_SHA" \
  --out "$EVIDENCE_DIR"
```

- **Report filenames**: automatically saved as `<YYYYmmddTHHMMSS>-<role>-<label>.md` inside `--out`.
- **Screenshot naming**: save screenshots alongside the reports as `<role>-<T-id>-<step>.png` (for example, `mac-b-T-41-local-network-prompt.png`).
- **Manual observations**: macOS provides no public CLI for per-app Local Network privacy toggles, so record **System Settings → Privacy & Security → Local Network** state, system alert text, and explicit confirmation of Finder double-click launches manually with screenshots.

---

## 4. Run 1: `M-perm` — Fresh macOS User Account / VM Snapshot

Run each step in a **fresh macOS user account or VM snapshot** on `Mac B` (and `Mac A` where specified) so prior permission state never masks first-run prompts.

### `T-45` — Control: Terminal / Dev Launch Non-Prompt Check

1. From Terminal on `Mac B`, launch a dev build (`pnpm dev` or `target/debug/synapseread-desktop`) or execute the binary directly from Terminal.
2. Open `File ▸ Import from Another Device…`, enter `Mac A`'s address and code, and click **Connect**.
3. Run the collector targeting the dev binary or exact PID (`--executable` avoids mixing with an installed `/Applications/SynapseRead.app` instance):

   ```sh
   scripts/lan-sync-collect-evidence.sh \
     --role mac-b \
     --label T-45-terminal \
     --executable target/debug/synapseread-desktop \
     --build-sha "$BUILD_SHA" \
     --out "$EVIDENCE_DIR"
   ```

4. **Expected**:
   - Terminal-launched processes do **not** trigger a per-app macOS Local Network privacy alert (inheriting Terminal's network access per TN3179).
   - Collector `## Process` reports `parent <ppid> (<shell>) — non-launchd launch, NOT valid Finder permission evidence (T-45)`.
   - Quit the dev/Terminal launch before continuing.

### `T-41` & `T-44` (`UA-1`, `UA-6`) — First-Run Finder Local Network Prompt, Allow & Retry

1. Ensure `Mac A` is launched by double-clicking `/Applications/SynapseRead.app` in **Finder**, sharing at least one book via `File ▸ Share Books on This Network…` -> **Start sharing** -> confirm **Start Sharing** on the native prompt.
2. On a fresh account/snapshot on `Mac B`, launch `/Applications/SynapseRead.app` by double-clicking in **Finder**. Run collector `--role mac-b --label T-41-launch` and confirm `ppid=1 (launchd child — consistent with Finder/Dock/open; confirm Finder double-click manually)` (and record manual Finder confirmation).
3. Open `File ▸ Import from Another Device…`, enter `Mac A`'s `IP:port` and 6-digit code, and click **Connect**.
4. Take a screenshot of the macOS Local Network permission dialog (`mac-b-T-44-prompt.png`) and click **Allow**.
5. If the initial `Connect` attempt failed with `lan_unreachable` while waiting on the alert, click **Retry** (note whether single auto-retry succeeded automatically or manual **Retry** was needed).
6. **Expected**:
   - System alert displays the exact `NSLocalNetworkUsageDescription` text from `Info.plist` (`"SynapseRead uses your local network only when you choose to share or import books with another device on the same network."`) (`T-44` / `UA-6`).
   - After clicking **Allow**, **Retry** (or connection) reaches the remote catalog without relaunching.

### `T-42` (`UA-1`, `UA-12`) — Deny Local Network, Hints, System Settings Recovery & Reset Behavior

1. Start from a **fresh macOS user account or VM snapshot** on `Mac B`. Launch `/Applications/SynapseRead.app` from **Finder**.
2. Attempt `File ▸ Import from Another Device…` against active `Mac A`, and click **Don't Allow** on the macOS Local Network prompt. Take screenshot `mac-b-T-42-denied-error.png`.
3. Open **System Settings → Privacy & Security → Local Network**, verify **SynapseRead** is listed and turned off, then enable the **SynapseRead** toggle. Record whether any reset button exists or how toggling behaves (`UA-12`).
4. Return to SynapseRead, click **Retry**, and record whether **Retry** succeeds immediately or requires relaunching SynapseRead.
5. **Expected**:
   - Denial causes `lan_unreachable` (`Could not reach the source device`) showing macOS Local Network recovery hints (`Check Local Network access for SynapseRead in System Settings → Privacy & Security → Local Network`).
   - Record exact `macOS` build behavior for toggle recovery and relaunch requirement (`UA-1`, `UA-12`).

### `T-43` (`UA-2`) — Source Local Network Denied While Serving

1. On a fresh account/snapshot on `Mac A`, launch `/Applications/SynapseRead.app` from **Finder** with **SynapseRead** denied (or toggled off) under **System Settings → Privacy & Security → Local Network**.
2. Start sharing via `File ▸ Share Books on This Network…` -> **Start sharing** -> confirm **Start Sharing**.
3. From `Mac B` (with Local Network allowed), connect and import a small book from `Mac A`.
4. **Expected**:
   - Record whether `Mac A` accepts incoming TCP connections and completes the transfer without needing Local Network grant (`UA-2`), and capture any OS prompt if one appears.

### `T-49` (`UA-8`, Self-Use Scope) — Rebuild Persistence: Local Self-Signed vs Ad Hoc

Execute the **Ad hoc bound (`--adhoc-sign`)** arm, execute the **Local self-signed (`--local-sign`)** arm _(if a local Keychain Code Signing certificate is provisioned)_, and record the **Paid Apple Developer ID** arm as deferred:

1. **Pre-replacement baseline (mandatory for EACH tested signing mode)**:
   - Install the initial verified build (`Build 1`) into `/Applications/SynapseRead.app` on the Mac under test and launch from **Finder**.
   - Run the collector (`--label T-49-<mode>-pre`) and record `Build 1` **`CDHash`**, initial **Local Network** toggle (**System Settings → Privacy & Security → Local Network**), and initial **Application Firewall** rule (**System Settings → Network → Firewall**, with Firewall ON and incoming connections allowed for SynapseRead).
   - Verify BOTH directions succeed **before** replacing the app:
     - **Local Network (outbound) pre-check**: put the Mac under test in the **receiver** role, connect to the peer Mac, and confirm catalog load succeeds.
     - **Application Firewall (inbound) pre-check**: put the Mac under test in the **source** role (`Firewall ON`, SynapseRead allowed), start sharing, and confirm the peer Mac connects and imports cleanly.
2. **Rebuild and replace with a strictly different `CDHash`**:
   - Quit SynapseRead (`⌘Q`).
   - Build and verify a fresh replacement (`Build 2`) in the same signing mode (`--adhoc-sign` or `--local-sign`) such that its `CDHash` differs from `Build 1` (for example, after a commit or harmless build metadata/comment change).
   - Replace `/Applications/SynapseRead.app` with `Build 2`, clear any quarantine, and launch `Build 2` from **Finder**.
3. **Post-replacement pre-connection inspection**:
   - **Before** clicking Share or Connect, run the collector (`--label T-49-<mode>-post-before-connect`) to confirm **`Build 2 CDHash` ≠ `Build 1 CDHash`**, `Signature integrity = valid`, and initial Firewall rule state; screenshot **System Settings → Privacy & Security → Local Network** and **System Settings → Network → Firewall** to record whether existing toggles/rules survived replacement or disappeared/reset.
4. **Post-replacement directional checks**:
   - **Local Network (outbound) post-check**: put the Mac under test in the **receiver** role and connect to the peer Mac. Record whether macOS prompts again, succeeds immediately, or fails with `lan_unreachable` until re-enabled.
   - **Application Firewall (inbound) post-check**: put the Mac under test in the **source** role (`Firewall ON`), start sharing, and have the peer Mac connect. Record whether incoming connections succeed, fail, or trigger a firewall prompt, and whether re-allowing in System Settings is required.
5. **Paid Apple Developer ID arm**: record verbatim as `Deferred / N/A per OD-2 Rev 2 (self-used open-source project without paid Apple Developer account)`.
6. Record pre-replacement and post-replacement `CDHash`, Local Network, and Firewall outcomes separately for each tested mode in Appendix B.

### `UA-3` — Local Network Denied: Physical LAN vs Loopback Isolation Check

Because production builds enforce `AddressPolicy::lan_only()` ([`crates/synapse-lan/src/address.rs`](../crates/synapse-lan/src/address.rs#L236-L252)), `127.0.0.1` is rejected before any socket call (`T-57`) and cannot be tested through the Finder UI. Resolve `UA-3` using the two concrete halves below plus ADR 0008 maintainer sign-off:

1. **Physical LAN denial (Finder-launched `.app`)**: Keep `/Applications/SynapseRead.app` launched from **Finder** on the macOS 15+ test Mac with **Local Network** explicitly toggled **OFF** in **System Settings → Privacy & Security → Local Network**, attempt to connect to the peer Mac's physical private LAN IPv4 (`192.168.x.x` / `10.x.x.x` / `172.16-31.x.x`), and record the `lan_unreachable` failure (`--label UA-3-lan-denied` + screenshot).
2. **Loopback exemption regression (`synapse-lan`)**: Run and record the `cargo test -p synapse-lan` loopback E2E suite (which exercises real sockets on `127.0.0.1` via test-only `AddressPolicy::loopback_for_tests()`) on the macOS 15+ host.
3. **Maintainer sign-off**: Record both halves explicitly in Appendix B and mark `UA-3` for maintainer acceptance in ADR 0008 (noting that production `AddressPolicy::lan_only()` intentionally blocks loopback in the packaged app).

---

## 5. Run 2: `M-pack` — Two Physical Macs on LAN + Role Swap

Use Finder-launched `/Applications/SynapseRead.app` on both `Mac A` and `Mac B` with Local Network permission allowed.

### Listener Lifecycle & Pairing

#### `T-10` (Packaged `.app` Full Listener Lifecycle) & `R3-05`

Run [`scripts/lan-sync-collect-evidence.sh`](../scripts/lan-sync-collect-evidence.sh) on `Mac A` at all 5 lifecycle points and record `SynapseRead LISTEN sockets`:

1. **Launch** (`--label T-10-launch`): right after opening SynapseRead from Finder -> **Expected:** `SynapseRead LISTEN sockets: 0`.
2. **Active share** (`--label T-10-share`): after confirming **Start Sharing** -> **Expected:** `SynapseRead LISTEN sockets: 1`, bound only to `<bound_ip>:<port>` (no `WARNING: wildcard listener`).
3. **Stop sharing** (`--label T-10-stop`): click **Stop sharing** -> **Expected:** `SynapseRead LISTEN sockets: 0`, dialog banner shows `Stopped`.
4. **Window close (`CloseRequested`, `R3-05`)** (`--label T-10-window-close`): start sharing again, then close the main window (`⌘W` / red close button while process stays alive or exits) -> **Expected:** `SynapseRead LISTEN sockets: 0` immediately on close.
5. **App quit** (`--label T-10-quit`): start sharing again, then quit SynapseRead (`⌘Q`) -> **Expected:** `Status: not running` and `SynapseRead LISTEN sockets: 0`.

#### `T-08` (`UA-4`) — Port `49319` Collision & Wildcard Coexistence in Packaged `.app`

1. On `Mac A`, bind a separate wildcard listener on port `49319` before starting share (for example, `python3 -c 'import socket,time; s=socket.socket(); s.bind(("0.0.0.0", 49319)); s.listen(1); time.sleep(300)'` in a test terminal).
2. Start sharing in SynapseRead (`Mac A`) and run collector (`--label T-08-wildcard-coexist`), noting the bound address in the Share dialog (`<lan_ip>:49319` vs fallback `<lan_ip>:49320`).
3. Also test binding `<lan_ip>:49319` specifically (without wildcard) and verify SynapseRead falls back to `<lan_ip>:49320`, and `Mac B` connects to `:49320`. Clean up the helper process afterward.

#### `T-12` — Native Confirmation Decline Leaves Zero Listeners

1. On `Mac A`, open `File ▸ Share Books on This Network…`, click **Start sharing**.
2. On the native `Share Books on This Network` system confirmation dialog, click **Cancel**.
3. Run collector (`--role mac-a --label T-12-decline`).
4. **Expected**: Sharing does not start, and `SynapseRead LISTEN sockets: 0`.

#### `OD-5` / `R3-09` — 5 Wrong Pairing Codes Lockout & Recovery

1. Start sharing on `Mac A`.
2. On `Mac B`, enter `Mac A`'s address and enter an invalid 6-digit code **5 times**.
3. **Expected**:
   - Failed attempts counter increments on `Mac A` (`1 of 5` … `4 of 5`).
   - On the 5th failure, `Mac A` shows `Code locked` (`Code locked after 5 failed attempts`) and `Mac B` receives `lan_attempts_exceeded` (`Pairing code locked`).
   - Even submitting the previously valid code stays locked until `Mac A` clicks **Regenerate code**.
   - Click **Regenerate code** on `Mac A` and connect with the new code -> succeeds.

#### `T-02` — Disconnect Receiver Mid-Transfer

1. Start importing a large book (`>= 1 GB`) from `Mac A` to `Mac B`.
2. While transfer progress is active, click **Disconnect receiver** on `Mac A`.
3. **Expected**: Active transfer aborts immediately, `Mac A` ends the paired session (returning to listening/new code or stopped state as displayed), `Mac B` cleans up `.part` files in `sync-staging/`, and a subsequent request with the old session fails.

#### `T-06` & `T-09` — Multi-Interface + VPN Exclusion & Wi-Fi Network Switch

1. (`T-06`) With a VPN (`utun*`) active alongside Wi-Fi/Ethernet on `Mac A`, open `File ▸ Share Books on This Network…` and verify the interface list includes only eligible LAN interfaces and excludes `utun*` and `lo0` (cross-check with collector `## Network`).
2. (`T-09`) Start sharing on `Mac A` over Wi-Fi, then turn Wi-Fi off or switch to a different Wi-Fi network so the bound IPv4 address disappears. Wait up to ~5–10 seconds and run collector (`--role mac-a --label T-09-net-change`).
3. **Expected**: Sharing stops automatically, the Share dialog displays `Needs attention` (`lan_network_changed` / network change summary), and `SynapseRead LISTEN sockets: 0`.

#### `R3-04` — Focus Mode Active-Sharing Indicator

1. Start sharing on `Mac A` and click **Hide** on the Share dialog.
2. Open a book and trigger `View ▸ Enter Focus Mode` (`⇧⌘F`) so the main toolbar auto-hides.
3. **Expected**: The floating `Sharing` indicator (`Sharing` / `Sharing · Connected` / `Sharing · Code locked`) remains visible in the bottom-right corner and clicking it re-opens the Share dialog.

### Firewall & Network Environment

#### `T-46` (`UA-7`) — Source macOS Application Firewall

On `Mac A` under **System Settings → Network → Firewall**:

1. Turn Firewall **On** and capture collector baseline (`--label T-46-fw-on`).
2. **Allow** arm: ensure **SynapseRead** is set to allow incoming connections -> `Mac B` connects and imports cleanly.
3. **Deny** arm: set **SynapseRead** to block incoming connections -> `Mac B` fails with `lan_unreachable` showing firewall hints.
4. **Block all incoming connections** arm: enable **Block all incoming connections** (`--getblockall` enabled) -> `Mac B` fails with `lan_unreachable` mentioning `"Block all incoming connections"` (turn this setting back off when done).

#### `T-47` (`UA-17`) — Guest Wi-Fi Client Isolation

1. Connect `Mac A` and `Mac B` to a guest Wi-Fi SSID (or AP with client/AP isolation enabled).
2. Start sharing on `Mac A` and attempt to connect from `Mac B`.
3. **Expected**: `Mac B` fails with `lan_unreachable` including the guest-network / client-isolation hint; `Mac A` shows **no** spurious blocked-peer notice when packets are dropped by the AP before reaching `Mac A`.

### Files, Recovery, Positions & Bookmarks

Prepare a test library on `Mac A` containing at least one **PDF**, **EPUB**, **TXT**, **Markdown (`.md`)**, and one **`>= 1 GB` file** (plus reading positions and bookmarks).

#### `T-15` & `T-28` — Multi-Format Transfer, `.md` Preservation (`R2-01`), Offline Reopen & Position Resume

1. On **`Mac A` (source)**, open all four format books (**PDF**, **EPUB**, **TXT**, **`.md`**) and advance each to a distinct, identifiable **non-start** reading position (for example: PDF page 2+, EPUB section/page 2+, TXT non-zero line, `.md` non-zero section/line). Record the exact saved position per format before sharing.
2. Start sharing on `Mac A` with **Reading positions** enabled. On `Mac B`, import all four books with **Use source reading position** selected.
3. Run collector (`--role mac-b --label T-15-after-import`) and verify `library/` file count increased and `.md` extension preservation (`<sha256>.md`, not `.txt`, `R2-01`) without listing filenames in evidence.
4. **Quit SynapseRead on `Mac A`** (`⌘Q`) so `Mac A` is completely offline (`T-15` / `T-28`).
5. On `Mac B`, open every imported book (**PDF**, **EPUB**, **TXT**, **`.md`**) offline and navigate to verify both offline readability (`T-15`) and that each format resumes at its exact imported non-start source position (`T-28`). Record the observed resume position per format in Appendix B.

#### `T-17` — Source File Edited After Catalog Load (`409 lan_source_changed`)

1. On `Mac B`, connect to `Mac A`, load the catalog, select a TXT/Markdown book, and reach the Preview step (`Review import`). Do not click **Import** yet.
2. On `Mac A`, modify the source file on disk (outside SynapseRead) so its size/hash changes.
3. On `Mac B`, click **Import**.
4. **Expected**: Execution fails cleanly for that book with `lan_source_changed` (`Source file changed`) and `0` body bytes are committed into `Mac B`'s library (`sync-staging/` stays clean).

#### `T-21`–`T-24` — Duplicate, Separate Version, Missing Restore, Changed Local File

1. **`T-21` (Renamed duplicate)**: On `Mac B`, import a book, rename its title locally or open the identical file under a different title, then reconnect to `Mac A`. Verify the catalog/preview badge shows **`On this device`** and transfers **`0` file bytes** (`On this device — no file transfer needed`).
2. **`T-22` (`Same title, different version`)**: Have a book on `Mac B` with the same title as a different-SHA file on `Mac A`. Connect and plan -> badge shows **`Same title, different version`**, file checkbox is labeled **`Download as a separate version`** with explicit confirmation copy. Select it and import -> creates a distinct document entry without overwriting `Mac B`'s original file or study data.
3. **`T-23` (`File missing` restore)**: On `Mac B`, delete or move the backing file of a previously imported/opened `.md` book (preserving its DB record, annotations/notes/MindMap cards) so `Mac A` has the matching SHA. Reconnect from `Mac B` -> badge shows **`File missing`**, checkbox **`Download and restore file`**. Import -> restores `.md` copy and re-opens cleanly with all local annotations/notes/MindMap cards intact.
4. **`T-24` (`Local file changed`)**: Modify a user-linked external file on `Mac B` so its SHA differs from the DB record while keeping the book record. Reconnect -> catalog marks it **`Local file changed`** (disabled checkbox / ineligible, `Local file changed. Open this book to resolve the change first.`).

#### `T-18`, `T-19`, `T-27`, `T-48` (`>= 1 GB` File) — Cancel, Force-Quit, Concurrent Reader, Sleep & Quit Recovery

1. **`T-27` (Concurrent responsiveness during `>= 1 GB` hashing/streaming)**:
   - On `Mac A` (source), open a readable book alongside the sharing setup and start sharing the `>= 1 GB` fixture (plus bookmarks). On `Mac B`, start importing the `>= 1 GB` file.
   - While `Mac B`'s progress bar is actively advancing:
     - On **`Mac A`**, click **Hide** on the Share dialog, open the book in the reader, scroll rapidly across pages/lines, and add/toggle bookmarks (`⌘D`). Confirm reader interaction remains responsive without stalling `Mac B`'s live transfer progress (`--label T-27-mid-transfer`).
     - On **`Mac B`**, observe smooth progress bar updates and verify clicking **Cancel** responds promptly without UI freeze. Record total transfer duration when running a full `>= 1 GB` completion pass.
2. **`T-18` (Cancel mid-transfer)**: Click **Cancel** during the `>= 1 GB` transfer -> results banner shows `Import cancelled`; collector (`--label T-18-after-cancel`) shows `0` `.part` files left in `sync-staging/`.
3. **`R3-05` (Window close cancels import)**: Start the `>= 1 GB` transfer again and close `Mac B`'s window (`⌘W` / close button). Verify transfer cancels cleanly and `sync-staging/` has `0` `.part` files.
4. **`T-19` & `R3-01` (Force-quit receiver startup reconciliation)**:
   - Start importing the `>= 1 GB` file on `Mac B` and **Force Quit** (`kill -9` or macOS Force Quit) `Mac B` mid-transfer so a `.part` file remains in `sync-staging/`.
   - Run collector (`--role mac-b --label T-19-before-relaunch`) to confirm `.part` count `>= 1`.
   - Launch `Mac B` from **Finder**, let startup finish, then run collector (`--label T-19-after-relaunch`) -> `sync-staging/` `.part` count is `0`.
   - (`R3-01`) Verify while a valid transfer is active in instance 1, launching a second instance does not delete instance 1's active `.part` file (sole-connection lock guard).
5. **`T-48` (Source sleep AND quit recovery — run BOTH sub-cases)**:
   - **Sleep sub-case**: Start importing the `>= 1 GB` file on `Mac B`, then put `Mac A` to sleep mid-transfer (`Apple menu ▸ Sleep`). Verify `Mac B` reports a clean connection/interruption error and leaves `0` `.part` files in `sync-staging/`. Wake `Mac A` (click **Regenerate code** / start a fresh share if the session stopped), reconnect from `Mac B` (or retry), and confirm the transfer **completes successfully**.
   - **Quit sub-case**: Start importing the `>= 1 GB` file again on `Mac B`, then quit `Mac A` (`⌘Q`) mid-transfer. Verify `Mac B` surfaces the interruption cleanly (`lan_source_stopped` / `lan_unreachable`) and cleans `sync-staging/` (`0` `.part` files). Relaunch `Mac A` from **Finder**, start sharing again, reconnect from `Mac B`, and confirm the transfer **completes successfully**.

#### `T-29`–`T-32` — Reading Positions, Conflict, Open-Book Flush & Recent Refresh

1. **`T-29` (Keep vs Adopt position)**: Import a book `On this device` whose source position differs from local. First verify **Keep yours** leaves local position untouched; repeat with **Use source reading position** checked -> `Mac B` adopts `Mac A`'s position.
2. **`T-30` (`lan_position_conflict`)**: Open the target book on `Mac B` or change its position between Preview (`Review import`) and clicking **Import** (or while previewing) -> verify Results shows **`Import finished — confirm reading position change`** / `Your local reading position changed before import finished` (`lan_position_conflict`), then click **`Replace with source position anyway`** to re-confirm and apply.
3. **`T-31` (Open-book scroll + `Close and use source position`)**: Have a book **open** in a tab on `Mac B`, scroll to a new position (without closing the tab), open `File ▸ Import from Another Device…`, select the book and check **`Close and use source position`**. Click **Import** -> verify the open tab flushes and closes cleanly (`Saving and closing open books before applying positions…`), applies `Mac A`'s position, and re-opening via **Continue reading** lands on `Mac A`'s position.
4. **`T-32` (Immediate `Continue reading` refresh)**: Return to the empty-state **Recent documents** (`Continue reading`) list on `Mac B` immediately after import (without relaunching) -> verify newly imported books and updated reading positions appear immediately.

#### `T-34`–`T-39` & `R3-09` — Bookmarks & In-Session `Back to catalog`

1. **`T-34` (Bookmark-only `0`-byte transfer)**: On a book already **`On this device`**, add a new bookmark on `Mac A`, import only the bookmark on `Mac B` -> `On this device — no file transfer needed`, `Bookmarks: Imported (+1)`, `0` book file bytes transferred.
2. **`T-35` (Idempotent repeat import)**: Immediately run import again on the same book -> preview reports `Already on device` (`0` new), `Import` inserts `0` new bookmarks, total bookmark count unchanged.
3. **`T-36` (Same-location different-label preservation)**: Ensure `Mac B` has bookmark label `"Local Note"` at the exact same location/anchor where `Mac A` has `"Source Note"`. Import -> `Mac B` keeps its original bookmark row (`id`, label `"Local Note"`, anchor payload, and `created_at` unchanged).
4. **`T-37` (Receiver local deletion offered again, per-item deselection, and re-import restore)**:
   - On `Mac B`, open the book with at least 2 imported bookmarks from `Mac A`, delete 1 bookmark locally in the Bookmarks sidebar (or delete 2 bookmarks), and close/save.
   - Re-connect `Mac B` to `Mac A` (or click **Back to catalog** -> **Review import**) and click **`Show bookmarks`** in Preview -> verify the locally deleted bookmark(s) appear again as selectable **`new`** candidate(s).
   - **Uncheck** the deleted bookmark in **`Show bookmarks`** (per-item deselection) and click **Import** -> confirm the deselected bookmark is **not** re-added (`+0` for that item).
   - Re-preview once more, leave the deleted bookmark **checked**, and click **Import** -> confirm it is restored cleanly (`+1`).
   - _(Separately note that deleting a bookmark on `Mac A` leaves `Mac B`'s existing bookmark untouched under V1 insert-only semantics.)_
5. **`T-39` (Live open Bookmarks panel refresh)**: Keep a book open on `Mac B` with `View ▸ Bookmarks` (`⌥⌘5`) sidebar visible. Import a new bookmark for that open book from `Mac A` -> the open Bookmarks panel updates live without reopening the book.
6. **`R3-09` (In-session `Back to catalog`)**: Click **`Back to catalog`** from Preview and from Results -> returns to the connected catalog within the same pairing session without re-entering the 6-digit code.

### WebKit, Accessibility & Role Swap

#### `T-53` (`UA-10`) — `WKWebView` Clipboard & Selectable Fallback

1. On active `Share Books on This Network` dialog on `Mac A`, click **Copy address**.
2. Paste into another app (e.g., TextEdit or `Mac B` notes) and verify `<ip>:<port>` copied cleanly, button showed `Copied`, and selectable `<ip>:<port>` (`select-all`) also supports `⌘C` manual copy fallback.

#### `T-56` — Keyboard Accessibility & VoiceOver Smoke (Both Required)

Run **both** checks explicitly (do not skip either):

1. **Keyboard-only check**: Navigate Share and Import dialogs using **Keyboard only** (`Tab`, `Shift+Tab`, `Space`, `Enter`, `Escape`). Confirm focus stays trapped inside the open modal (`Tab` / `Shift+Tab` wraps cleanly), reader shortcuts do not fire behind the modal, and `Escape` closes idle dialogs without dismissing an active transfer when dismissal is locked.
2. **VoiceOver check**: Enable **VoiceOver** (`⌘F5`), step through Share (idle + active/error states) and Import (Connect, Catalog, Preview, Progress, Results) controls, and confirm labels, roles, status badges, and `role="alert"` banners announce coherently.

#### `T-50` — Optional Mixed `arm64` ↔ `x86_64` Transfer

If an Intel (`x86_64`) Mac is available, pair `arm64` ↔ `x86_64` (using a `--target universal-apple-darwin` or matching-arch build) and transfer one book + position + bookmark; otherwise record `N/A (no Intel macOS hardware available)`.

#### Role Swap (`Mac B → Mac A`)

Swap roles so **`Mac B` shares** via `File ▸ Share Books on This Network…` and **`Mac A` imports** via `File ▸ Import from Another Device…`. Run a full end-to-end smoke across R2–R5:

- Confirm pairing + catalog load,
- Transfer at least one new book + reading position + bookmark,
- Verify `Mac A` opens the imported book offline after `Mac B` stops sharing / quits,
- Run collector on both Macs (`--label role-swap-complete`).

---

## 6. Defect & Exception Rules

- **Defect Rule**: Any real product, packaging, or protocol defect uncovered during Track B must get a dedicated GitHub issue and a `fix/*` PR with automated regression tests. Rebuild both Macs from the new merged `main` commit SHA and re-verify the affected row(s) before starting Track C.
- **Exception Rule**: Any deferred or `N/A` item (such as the paid Apple Developer ID comparison arm of `T-49` / `UA-8` under `OD-2 Rev 2`, `UA-3` loopback split under `AddressPolicy::lan_only()`, or `T-50` if no Intel Mac is available) must record explicit rationale and owner sign-off in Appendix B before Track C closes `#147` and `#132`.

---

## 7. Appendices

### Appendix A: Two-Mac Environment Table Template

| Field                  | `Mac A` (Initial Source) | `Mac B` (Initial Receiver) |
| ---------------------- | ------------------------ | -------------------------- |
| Device / Chip / Arch   |                          |                            |
| macOS Version & Build  |                          |                            |
| Memory                 |                          |                            |
| `WebKit` Bundle Ver.   |                          |                            |
| Source Commit SHA      |                          |                            |
| Signing Mode (`--...`) |                          |                            |
| `codesign -dv` Type    |                          |                            |
| `codesign --verify`    |                          |                            |
| `CDHash`               |                          |                            |
| Launch Method          | Finder (`/Applications`) | Finder (`/Applications`)   |
| Initial Firewall State |                          |                            |

### Appendix B: Per-Test Results Template

Leave **Result** blank until the physical two-Mac run completes. Valid values: `Pass`, `Fail`, `Exception`, `N/A`.

| ID                         | Run    | Roles     | Expected                                                                                                                     | Result | Evidence (collector label / screenshot / metrics) | Issue / sign-off |
| -------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------- | ---------------- |
| `T-45`                     | `Perm` | `Mac B`   | Terminal/dev launch shows no Local Network alert; collector (`--executable`) flags non-`launchd` parent                      |        |                                                   |                  |
| `T-41`                     | `Perm` | `Mac A/B` | Finder launch on fresh account prompts Local Network; **Allow** + **Retry** succeeds                                         |        |                                                   |                  |
| `T-44` / `UA-6`            | `Perm` | `Mac B`   | Alert text matches `Info.plist` `NSLocalNetworkUsageDescription`; no `NSBonjourServices`                                     |        |                                                   |                  |
| `T-42` / `UA-1`            | `Perm` | `Mac B`   | **Don't Allow** triggers `lan_unreachable` hints; System Settings enable + **Retry** recovery recorded                       |        |                                                   |                  |
| `UA-12`                    | `Perm` | `Mac B`   | Local Network Settings toggle/reset and relaunch requirement recorded on target macOS 15+ build                              |        |                                                   |                  |
| `T-43` / `UA-2`            | `Perm` | `Mac A`   | Source with Local Network denied still serves incoming transfer from allowed `Mac B` (or outcome noted)                      |        |                                                   |                  |
| `T-49` / `UA-8` (Ad hoc)   | `Perm` | `Mac A/B` | Pre-replacement & post-replacement (new `CDHash`) Local Network (receiver) + Firewall (source) observed; Dev ID deferred     |        |                                                   |                  |
| `T-49` / `UA-8` (Self-sgn) | `Perm` | `Mac A/B` | Pre-replacement & post-replacement (new `CDHash`) Local Network (receiver) + Firewall (source) observed (if cert configured) |        |                                                   |                  |
| `UA-3`                     | `Perm` | `Mac B`   | Finder physical LAN denied (`lan_unreachable`) + `synapse-lan` loopback E2E pass recorded; maintainer sign-off               |        |                                                   |                  |
| `T-10`                     | `Pack` | `Mac A`   | `LISTEN` count `0` (launch) -> `1` bound IP (share) -> `0` (stop / close `R3-05` / quit)                                     |        |                                                   |                  |
| `T-08` / `UA-4`            | `Pack` | `Mac A/B` | Coexists with `0.0.0.0:49319` wildcard; falls back to `49320` when `<lan_ip>:49319` occupied                                 |        |                                                   |                  |
| `T-12`                     | `Pack` | `Mac A`   | Declining native `Share Books on This Network` confirmation leaves `0` listeners                                             |        |                                                   |                  |
| `OD-5` / `R3-09`           | `Pack` | `Mac A/B` | 5 wrong codes -> `Code locked` + `lan_attempts_exceeded` + **Regenerate code** recovery                                      |        |                                                   |                  |
| `T-02`                     | `Pack` | `Mac A/B` | **Disconnect receiver** mid-transfer aborts immediately and cleans staging                                                   |        |                                                   |                  |
| `T-06`                     | `Pack` | `Mac A`   | Interface selector lists LAN interfaces only; `utun*` VPN and `lo0` excluded                                                 |        |                                                   |                  |
| `T-09`                     | `Pack` | `Mac A`   | Wi-Fi loss/switch losing bound IP stops share with **Needs attention** (`lan_network_changed`)                               |        |                                                   |                  |
| `R3-04`                    | `Pack` | `Mac A`   | Active-sharing indicator remains visible and clickable in Focus Mode (`⇧⌘F`)                                                 |        |                                                   |                  |
| `T-46` / `UA-7`            | `Pack` | `Mac A/B` | macOS Firewall Allow / Deny / "Block all incoming connections" matches expected `lan_unreachable`                            |        |                                                   |                  |
| `T-47` / `UA-17`           | `Pack` | `Mac A/B` | Guest Wi-Fi isolation fails on receiver (`lan_unreachable`); no spurious blocked-peer count on source                        |        |                                                   |                  |
| `T-15`                     | `Pack` | `Mac A/B` | PDF, EPUB, TXT, and `.md` transfer with `.md` extension preserved (`R2-01`) and reopen offline after `Mac A` quits           |        |                                                   |                  |
| `T-28`                     | `Pack` | `Mac A/B` | PDF, EPUB, TXT, and `.md` all resume at their imported non-start source reading positions offline after `Mac A` quits        |        |                                                   |                  |
| `T-17`                     | `Pack` | `Mac A/B` | Source file edited after catalog load -> `lan_source_changed` (`0` bytes committed)                                          |        |                                                   |                  |
| `T-21`                     | `Pack` | `Mac A/B` | Renamed duplicate shows `On this device`, transfers `0` file bytes                                                           |        |                                                   |                  |
| `T-22`                     | `Pack` | `Mac A/B` | `Same title, different version` + `Download as a separate version` creates distinct document                                 |        |                                                   |                  |
| `T-23`                     | `Pack` | `Mac A/B` | `File missing` + `Download and restore file` restores `.md` while preserving local study data                                |        |                                                   |                  |
| `T-24`                     | `Pack` | `Mac A/B` | `Local file changed` marked ineligible in catalog and preview                                                                |        |                                                   |                  |
| `T-18`                     | `Pack` | `Mac A/B` | Cancel mid-transfer (`>= 1 GB`) and window close (`R3-05`) clean `.part` files                                               |        |                                                   |                  |
| `T-19` / `R3-01`           | `Pack` | `Mac B`   | Force-quit leaves `.part`, startup reconciles to `0`, second instance guards active transfer (`R3-01`)                       |        |                                                   |                  |
| `T-27`                     | `Pack` | `Mac A/B` | Reader scrolling & bookmarking stay responsive on source (`Hide` dialog) while `>= 1 GB` transfer advances; duration noted   |        |                                                   |                  |
| `T-48`                     | `Pack` | `Mac A/B` | Source sleep AND source quit mid-transfer both error cleanly, leave `0` `.part`, and succeed on reconnect/retry              |        |                                                   |                  |
| `T-29`                     | `Pack` | `Mac A/B` | **Keep yours** vs **Use source reading position** works accurately                                                           |        |                                                   |                  |
| `T-30`                     | `Pack` | `Mac A/B` | `lan_position_conflict` triggers **Replace with source position anyway** re-confirm                                          |        |                                                   |                  |
| `T-31`                     | `Pack` | `Mac A/B` | Open-book scroll + **Close and use source position** flushes, closes, and applies source position                            |        |                                                   |                  |
| `T-32`                     | `Pack` | `Mac B`   | **Continue reading** (`Recent documents`) updates immediately after import                                                   |        |                                                   |                  |
| `T-34`                     | `Pack` | `Mac A/B` | Bookmark-only import on existing book transfers `0` file bytes                                                               |        |                                                   |                  |
| `T-35`                     | `Pack` | `Mac A/B` | Repeat import inserts `0` new bookmarks (`Already on device`, total unchanged)                                               |        |                                                   |                  |
| `T-36`                     | `Pack` | `Mac A/B` | Same-location different-label preserves receiver `id`, label, anchor, and `created_at`                                       |        |                                                   |                  |
| `T-37`                     | `Pack` | `Mac A/B` | Receiver-deleted bookmark reappears as selectable in Preview; per-item deselect skips it; re-checking restores it            |        |                                                   |                  |
| `T-39`                     | `Pack` | `Mac B`   | Live open **Bookmarks** sidebar updates immediately when new bookmarks import                                                |        |                                                   |                  |
| `R3-09`                    | `Pack` | `Mac B`   | **Back to catalog** returns to active session catalog without re-pairing                                                     |        |                                                   |                  |
| `T-53` / `UA-10`           | `Pack` | `Mac A`   | `WKWebView` **Copy address** + manual selectable fallback copy `<ip>:<port>`                                                 |        |                                                   |                  |
| `T-56`                     | `Pack` | `Mac A/B` | BOTH keyboard-only navigation (focus trap, shortcut isolation, `Escape`) AND VoiceOver smoke pass                            |        |                                                   |                  |
| `T-50`                     | `Pack` | `Mac A/B` | Optional `arm64` ↔ `x86_64` transfer (or `N/A` if single-arch hardware only)                                                 |        |                                                   |                  |
| `Role Swap`                | `Pack` | `Mac B→A` | `Mac B` shares -> `Mac A` imports (smoke across R2–R5 + offline reopen)                                                      |        |                                                   |                  |

### Appendix C: Track C Transcription & Milestone Closure

After all applicable rows in Appendix B pass (or have filed `fix/*` PRs verified from `main` / owner-accepted exceptions):

1. Open branch `docs/lan-sync-two-mac-evidence` from `main`.
2. Transcribe Appendix A, Appendix B outcomes/measurements, and resolved `UA-*` rows into [`docs/adr/0008-lan-book-sync.md`](adr/0008-lan-book-sync.md) (recording the `OD-2 Rev 2` deferred exception on `T-49` / `UA-8`).
3. Check `[x]` on the **Native two-Mac Finder validation (`#147`, `OD-2 Rev 2`)** bullet in [`docs/ROADMAP.md`](ROADMAP.md).
4. Update the top status callout and any observed `macOS 15+` troubleshooting details in [`README.md`](../README.md).
5. Run all 5 CI gates (`pnpm check`, `pnpm e2e`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`) and open the Track C PR with `Closes #147` and `Closes #132`.
