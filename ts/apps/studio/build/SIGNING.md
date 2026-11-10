# Signing NH Studio (not configured yet)

`npm run dist:mac` / `dist:win` build **unsigned** installers (`mac.identity: null`,
no Windows certificate). macOS Gatekeeper and Windows SmartScreen warn on first
launch; on macOS right-click → Open, on Windows "More info → Run anyway".
`--publish never` is in both scripts: the `publish` block (GitHub Releases of
wenzi7777/New-Horizons-Gateway, draft) is configuration only.

## macOS: Developer ID + notarization

1. Install a "Developer ID Application" certificate in the login keychain.
2. In `package.json` → `build.mac`: remove `"identity": null` (or set it to the
   certificate's name) and set `"hardenedRuntime": true`; the entitlements in
   `build/entitlements.mac.plist` are already referenced.
3. Notarize: add `"notarize": true` to `build.mac` and export
   `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
   (or `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`) before `npm run dist:mac`.

## Windows: Authenticode

Export `CSC_LINK` (path or base64 of the .pfx) and `CSC_KEY_PASSWORD` before
`npm run dist:win` (or `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` when building on
macOS). For an EV / cloud HSM certificate use `build.win.azureSignOptions` or a
custom `build.win.signtoolOptions.sign` script instead.

## Publishing

Only when a release should go out: `GH_TOKEN=… npx electron-builder --mac --win --publish always`
(drafts a GitHub release; review and publish it by hand).

## Self-update while unsigned

Studio checks `releases/studio-latest.json` / `studio-beta.json` (same shape as
`gateway-bin-*.json`: `{version, notes_url, assets: {"darwin-arm64"|"darwin-x64"|"win32-x64": {url, sha256, size}}}`).
A download is accepted only when its size and sha256 match the manifest. Then:

- **macOS**: the `.dmg` is opened (Finder mounts it) and Studio quits; the user
  drags NH Studio into Applications. Unsigned, so the first launch of the new
  copy needs right-click → Open (Gatekeeper), and the quarantine flag on the
  download may make macOS say the app "is damaged" on some systems — then
  `xattr -dr com.apple.quarantine "/Applications/NH Studio.app"`.
- **Windows**: the NSIS installer runs with its normal UI (not `/S`, so the
  install folder and SmartScreen's "More info → Run anyway" stay visible) and
  Studio quits.

Signing (above) removes these prompts; the update flow itself does not change.
