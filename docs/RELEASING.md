# Releasing LanPlay

Installed copies update themselves from the **latest GitHub release** of this repository. They only accept a
`manifest.json` signed with the release key (Ed25519); the public key is `UPDATE_PUBLIC_KEY_B64` in
`src/core/update/update.ts`. If the private key is lost, installed copies can never update again: back it up.

One-time: `node scripts/release-sign.mjs keygen` creates the private key in
`~/Library/Application Support/lanplay-release/update-signing-key.pem`; paste the printed public key into `update.ts`.

Each release (example 0.2.1):
1. Bump the version: `npm version 0.2.1 --no-git-tag-version`; run `npm run typecheck && npm test`; commit and tag `v0.2.1`.
2. Build: `npm run build`, then
   `npx electron-builder --config scripts/electron-builder.config.cjs --win nsis --x64 --publish never`
   (Mac: `node scripts/fetch-vendor.mjs && npm run pack:mac`, then `ditto -c -k --keepParent release/mac-arm64/LanPlay.app release/LanPlay-<version>-mac-arm64.zip`; the zip name must match `LanPlay-{v}-mac-arm64.zip` from src/link-contract.ts).
3. Sign: `node scripts/release-sign.mjs manifest --version 0.2.1 --notes-file notes.txt --out release/signed --asset win32-x64=release/LanPlay-Setup-0.2.1.exe [--asset darwin-arm64=release/LanPlay-0.2.1-mac-arm64.zip]`
4. Publish: `gh release create v0.2.1 release/LanPlay-Setup-0.2.1.exe release/signed/manifest.json release/signed/manifest.sig --title "LanPlay 0.2.1" --notes-file notes.txt`
   (the installer file name must match the URL inside the manifest, which the script derives from `--asset`).

The release must be a normal (non-draft, non-prerelease) release: `/releases/latest/download/manifest.json` only finds those.
Copies running an older version download the installer, verify size and SHA-256, and offer "Restart and update".
