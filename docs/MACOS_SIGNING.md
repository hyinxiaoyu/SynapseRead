# macOS Code Signing, Notarization, and Universal Releases

SynapseRead V1.0 ships for macOS on Apple Silicon (`arm64`) and Intel (`x86_64`) as a universal `.app` and `.dmg` (`universal-apple-darwin`). Apple Developer ID signing and notarization are required for Gatekeeper acceptance and for native two-Mac Finder validation of LAN Book Sync (`#147`, [ADR 0008](adr/0008-lan-book-sync.md) `OD-2`).

## Prerequisites

- An Apple Developer account with a **Developer ID Application** certificate (`Developer ID Application: <Name> (<TEAM_ID>)`).
- Xcode Command Line Tools (`xcode-select --install`, providing `codesign`, `xcrun notarytool`, `xcrun stapler`, `spctl`, `plutil`, `lipo`, and `hdiutil`).
- Both macOS Rust targets installed locally:

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

To test universal packaging without Apple credentials (unsigned/ad-hoc only, not valid for `#147`):

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

> **Reminder for `#147` Two-Mac Validation:** Install the Apple-signed `SynapseRead.app` into `/Applications/` on both Macs and launch from **Finder** (never `pnpm dev` or Terminal execution, per Apple TN3179) so macOS enforces and records Local Network privacy permissions accurately.
