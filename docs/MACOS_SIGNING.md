# macOS Code Signing, Notarization, and Universal Releases

SynapseRead V1.0 ships for macOS on Apple Silicon (`arm64`) and Intel (`x86_64`) as a universal `.app` and `.dmg` (`universal-apple-darwin`). Apple Developer ID signing and notarization are **optional** (needed only for Gatekeeper-accepted public distribution). For self-use and V1 LAN Book Sync validation (`#147`), [ADR 0008](adr/0008-lan-book-sync.md) (`OD-2 Rev 2`) accepts Finder-launched local self-signed (`--local-sign`) or ad hoc bound (`--adhoc-sign`) builds without an Apple Developer account.

## Prerequisites

- _(Optional, for Gatekeeper-accepted public releases only)_ An Apple Developer account with a **Developer ID Application** certificate (`Developer ID Application: <Name> (<TEAM_ID>)`). Self-use `--local-sign` and `--adhoc-sign` builds require no Apple account.
- Xcode Command Line Tools (`xcode-select --install`, providing `codesign`, `xcrun notarytool`, `xcrun stapler`, `spctl`, `plutil`, `lipo`, and `hdiutil`).
- Both macOS Rust targets installed locally (or the target passed to `--target`):

  ```sh
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  ```

## Hardened Runtime & Security Invariants

`apps/desktop/src-tauri/tauri.conf.json` enables macOS Hardened Runtime (`bundle.macOS.hardenedRuntime: true`) without a custom entitlements plist and without hardcoding a personal `signingIdentity`.

- `synapseread-desktop` links exclusively against macOS system frameworks and `/usr/lib/` system libraries (no third-party dylibs or helper binaries), and `WKWebView` runs web content and JavaScript JIT inside Apple's own signed XPC services, so no Hardened Runtime exception entitlements are needed.
- `app.security.csp`, `app.security.assetProtocol`, `apps/desktop/src-tauri/capabilities/default.json`, and `apps/desktop/src-tauri/Info.plist` (`NSLocalNetworkUsageDescription` present, `NSBonjourServices` absent) remain unchanged.

## GitHub Actions Release Workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds `universal-apple-darwin`, notarizes and staples both `SynapseRead.app` and `SynapseRead_<version>_universal.dmg`, verifies the bundles before any upload, generates `SHA256SUMS.txt`, uploads workflow artifacts, and creates or updates a draft GitHub Release when triggered by a `v*` tag push or `workflow_dispatch` with `create_release=true`.

### Required Repository Secrets

Configure these under **Settings → Secrets and variables → Actions**:

| Secret                       | Required | Description                                                                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Yes      | Base64-encoded `.p12` export of your **Developer ID Application** certificate + private key                                     |
| `APPLE_CERTIFICATE_PASSWORD` | Yes      | Password used when exporting the `.p12` file                                                                                    |
| `APPLE_SIGNING_IDENTITY`     | Optional | Exact certificate identity string (e.g. `Developer ID Application: Example (TEAMID1234)`) to verify against the imported `.p12` |

Provide **one** complete notarization credential set (Option A is preferred if both are present):

| Option                                                | Secrets                                                 | Description                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Option A (App Store Connect API Key, recommended)** | `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | Key ID, Issuer UUID, and `.p8` file contents (raw PKCS#8 PEM or base64-encoded `.p8`) |
| **Option B (Apple ID)**                               | `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`           | Apple ID email, app-specific password, and 10-character Team ID                       |

To encode your exported `.p12` certificate and upload it directly to `APPLE_CERTIFICATE` without writing a base64 plaintext file to disk:

```sh
openssl base64 -A -in DeveloperIDApplication.p12 | gh secret set APPLE_CERTIFICATE
```

> **Note:** Never save plaintext certificate exports inside the repository, and never commit `.p12`, `.pem`, `.key`, or `.p8` files (all four extensions are listed in `.gitignore`).

### Triggering Builds

- **Tag push (`v*`):** Push a tag matching `tauri.conf.json` `version` (for example `v0.1.0`) to build, sign, notarize, verify, and attach assets to a draft GitHub Release bound to that commit.
- **`workflow_dispatch` (signed test build for `#147`):** Run **Release** manually from GitHub Actions with `create_release=false` (whether dispatched from a branch or a `v*` tag) to download a signed, notarized `SynapseRead-<version>-macos-universal` workflow artifact without creating or modifying any GitHub Release. Setting `create_release=true` creates or updates a draft Release only when the built commit matches any existing remote tag/draft and no published Release exists for that tag.
- **`workflow_dispatch` (unsigned CI smoke test):** Set `allow_unsigned=true` (requires `create_release=false`) when Apple secrets are not configured yet. Unsigned artifacts are labeled `-unsigned` and are not valid for `#147`.

> **Draft Release Protection:** `scripts/release-publish-draft.sh` validates all three expected assets before writing, uploads missing assets directly to the verified draft's Release ID `upload_url` without `--clobber` or asset deletion, skips identical-digest assets, and aborts on digest mismatches, `starter` placeholders, or published releases. To guarantee at the GitHub server level that a release cannot receive new or modified assets if someone publishes the draft mid-upload, enable **Release immutability** in **Repository Settings → General → Releases**.

### Recovering from Failed Upload (`starter` Assets)

If a transient gateway failure (such as HTTP `502`) leaves an incomplete `state: "starter"` placeholder asset on a draft Release, `scripts/release-publish-draft.sh` refuses to auto-delete it and prints both the draft release ID and the stuck asset ID. Recover manually without discarding your already-signed artifacts:

1. **Confirm the release is still an unpublished draft** (and bound to the expected commit SHA):

   ```sh
   gh api repos/<owner>/<repo>/releases/<release-id> \
     --jq '{id, tag_name, draft, target_commitish, assets: [.assets[] | {id, name, state, size, digest}]}'
   ```

   Verify `"draft": true` and confirm `<asset-id>` has `"state": "starter"`. Never delete assets from a published release.

2. **Delete only the incomplete `starter` asset**:

   ```sh
   gh api --method DELETE repos/<owner>/<repo>/releases/assets/<asset-id>
   ```

3. **Rerun using the original build artifacts**: re-run the failed `publish-release` job in the same GitHub Actions workflow run so it downloads the exact `SynapseRead-<version>-macos-universal` artifact from `build-macos` (matching any already-uploaded assets on that draft) rather than rebuilding fresh binaries.

## Self-Use / Open-Source macOS Builds (No Apple Developer Account)

Per [ADR 0008](adr/0008-lan-book-sync.md) (`OD-2 Rev 2`), you can build and run packaged `.app`/`.dmg` artifacts on your own Macs without paying for an Apple Developer account:

| Mode                        | What it does                                                                         | `Info.plist` bound? | Identity stable across rebuilds?                               | Valid for `#147`? |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------- | ----------------- |
| `--local-sign "<identity>"` | Signs `.app` and `.dmg` with a local Keychain Code Signing certificate (`runtime`)   | Yes                 | Same local certificate across rebuilds (see TN3179 note below) | Yes               |
| `--adhoc-sign`              | Re-signs `.app` ad hoc (`codesign --force --deep --sign -`) and packages a fresh DMG | Yes                 | No (CDHash changes on every rebuild)                           | Yes               |
| `--allow-unsigned`          | Leaves Tauri's default linker-signed bundle as-is                                    | No (`not bound`)    | No                                                             | No                |

### 1. Create a Local Self-Signed Certificate (One-Time Setup)

1. Open **Keychain Access → Certificate Assistant → Create a Certificate…**
2. Set **Name** to `SynapseRead Local Signing`, **Identity Type** to **Self-Signed Root**, and **Certificate Type** to **Code Signing**, then create it in the `login` keychain.
3. Verify macOS sees it as a valid code-signing identity:

   ```sh
   security find-identity -v -p codesigning
   ```

   If the certificate does not appear in the list, double-click it in Keychain Access, expand **Trust**, set **Code Signing** to **Always Trust**, and re-run `security find-identity -v -p codesigning`.

To build on both of your Macs with the same local identity, export the certificate and private key via **File → Export Items…** as a password-protected `.p12`, then double-click to import and trust it on the second Mac. Never commit `.p12` files into the repository (`.gitignore` excludes `*.p12`). Alternatively, build on one Mac and copy `SynapseRead.app` (or the `.dmg`) to the second Mac.

### 2. Build and Package Locally

```sh
# Recommended for two personal Macs: local self-signed certificate (no notarization).
# Accepts exact certificate common name or 40-hex SHA-1 fingerprint from `security find-identity`.
scripts/macos-build-signed.sh --local-sign "SynapseRead Local Signing"

# Faster single-architecture build on Apple Silicon
scripts/macos-build-signed.sh --target aarch64-apple-darwin --local-sign "SynapseRead Local Signing"

# Zero-certificate alternative: ad hoc signature with bound Info.plist
scripts/macos-build-signed.sh --target aarch64-apple-darwin --adhoc-sign
```

In `--local-sign` and `--adhoc-sign` modes, `scripts/macos-build-signed.sh`:

1. Passes `--bundles app` to Tauri so Tauri does not package a DMG before `SynapseRead.app` is signed (and in `--local-sign` mode resolves the exact unique certificate SHA-1 fingerprint before building).
2. Signs `SynapseRead.app` (`--options runtime --timestamp=none` for local self-signed, or `--sign -` for ad hoc).
3. Packages `SynapseRead_<version>_<arch>.dmg` from the signed `.app` with `hdiutil`, signs the `.dmg` in `--local-sign` mode, and runs `scripts/verify-macos-bundle.sh` (`--require-local-signed` or `--require-adhoc-bound`, which also mounts the `.dmg` read-only to verify the inner `SynapseRead.app` signature, bound `Info.plist`, and per-architecture `CDHash` match).

### 3. Install, Clear Quarantine, and Re-Grant Caveat

- Copy `SynapseRead.app` into `/Applications/` on both Macs and launch from **Finder** (never `pnpm dev` or Terminal).
- If you transferred the `.app` or `.dmg` over AirDrop or a local download and macOS added a quarantine attribute, clear it once on the receiving Mac:

  ```sh
  xattr -dr com.apple.quarantine /Applications/SynapseRead.app
  ```

- Gatekeeper (`spctl`) rejection is expected for local self-signed and ad hoc builds because they are not notarized by Apple. If macOS still warns because quarantine was not cleared manually, allow the app once via **System Settings → Privacy & Security → Open Anyway**.
- **macOS 15+ Local Network & Firewall rebuild caveat:** Per Apple TN3179, Apple only guarantees persistent Local Network permission tracking across rebuilds for Apple-issued signing identities. Rebuild persistence under a local self-signed certificate is checked empirically during `T-49` rather than assumed; under `--adhoc-sign`, each rebuild produces a new CDHash, so you may need to re-allow **SynapseRead** in **System Settings → Privacy & Security → Local Network** and **System Settings → Network → Firewall** after replacing the app.

### 4. Verify Local Self-Signed or Ad Hoc Bundles

```sh
APP="/Applications/SynapseRead.app"
DMG="target/aarch64-apple-darwin/release/bundle/dmg/SynapseRead_0.1.0_aarch64.dmg"

codesign -dv --verbose=4 "$APP"
# Local self-signed expects: Authority=SynapseRead Local Signing, Info.plist entries=<n>, flags=0x10000(runtime)
# Ad hoc bound expects:      Signature=adhoc, Info.plist entries=<n>

scripts/verify-macos-bundle.sh --app "$APP" --dmg "$DMG" --require-local-signed
# Or for --adhoc-sign builds:
scripts/verify-macos-bundle.sh --app "$APP" --dmg "$DMG" --require-adhoc-bound
```

## Local Signed & Notarized Builds

Use [`scripts/macos-build-signed.sh`](../scripts/macos-build-signed.sh) to build, sign, notarize (`.app` and `.dmg`), staple, and verify locally:

```sh
# Option 1: using a Developer ID certificate already installed in Keychain + API key
export APPLE_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID1234)"
export APPLE_API_KEY="YOUR_KEY_ID"
export APPLE_API_ISSUER="YOUR_ISSUER_UUID"
export APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY}.p8"

scripts/macos-build-signed.sh --target universal-apple-darwin
```

You can also use `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` instead of a Keychain identity, or `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` instead of an API key.

To test universal packaging without signing (produces Tauri's default linker-signed bundle with `Info.plist=not bound`; not valid for `#147` — use `--local-sign` or `--adhoc-sign` instead):

```sh
scripts/macos-build-signed.sh --target universal-apple-darwin --allow-unsigned --ci
```

To notarize and staple an already-signed `.dmg` separately (since Tauri notarizes and staples `.app` only):

```sh
scripts/macos-notarize-dmg.sh target/universal-apple-darwin/release/bundle/dmg/SynapseRead_0.1.0_universal.dmg
```

## Verification Commands

[`scripts/verify-macos-bundle.sh`](../scripts/verify-macos-bundle.sh) automates these checks, or you can run them directly on a packaged build:

```sh
APP="target/universal-apple-darwin/release/bundle/macos/SynapseRead.app"
DMG="target/universal-apple-darwin/release/bundle/dmg/SynapseRead_0.1.0_universal.dmg"

lipo -archs "$APP/Contents/MacOS/synapseread-desktop"
plutil -p "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"

hdiutil verify "$DMG"
codesign --verify --verbose=2 "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
xcrun stapler validate "$DMG"
```

> **Reminder for `#147` Two-Mac Validation:** Install the local self-signed (`--local-sign`) or ad hoc bound (`--adhoc-sign`) `SynapseRead.app` (per [ADR 0008](adr/0008-lan-book-sync.md) `OD-2 Rev 2`) into `/Applications/` on both Macs and launch from **Finder** (never `pnpm dev` or Terminal execution, per Apple TN3179) so macOS enforces and records Local Network privacy permissions accurately.
