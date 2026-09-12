# Screen Beaver → MSIX (Microsoft Store)

Tauri does **not** emit MSIX. Do **not** ship NSIS/MSI/WiX installers into the Store package.

Use your own Visual Studio packaging project (or MakeAppx) and point it at the staged payload below.

## Build + stage

```powershell
npm run desktop:build:store
```

This produces:

| Path | Role |
|------|------|
| `src-tauri/target/release/screen-beaver.exe` | Release binary |
| `packaging/msix/payload/ScreenWeaver.exe` | Staged copy |

Optional: set `SCREENBEAVER_MSIX_VS_PAYLOAD` to also copy into an external VS packaging payload folder.

## Package

1. Open your MSIX packaging solution
2. **Release | x64**
3. **Publish → Create App Packages…**
4. Upload to Partner Center as **MSIX**

Replace placeholders in `Package.appxmanifest` (`YOUR_PACKAGE_IDENTITY_NAME`, `CN=YOUR_PUBLISHER`) with your Partner Center identity before Store submission.

## Why not MSI / NSIS?

| Approach | Result |
|----------|--------|
| MSI/NSIS inside MSIX | Double install, Store policy pain |
| Raw EXE in full-trust MSIX | One install from the Store |
