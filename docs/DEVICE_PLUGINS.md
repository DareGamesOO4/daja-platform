# Device plugins

DAJA Platform is the source of truth for device SDK packages. Release metadata is
stored in PostgreSQL and the immutable ZIP package is stored in the configured R2
bucket. RFIDDaja downloads a package only after its size and SHA-256 checksum match
the published manifest.

The desktop-facing routes are public so the Electron main process can refresh and
install drivers before a user has a session:

- `GET /api/v1/plugins/catalog`
- `GET /api/v1/plugins/packages/:pluginId/:version/download`

The download route redirects to a short-lived R2 URL. It never buffers a large SDK
archive in the API process.

## Publishing a release

Publishing is deliberately an admin operation. The caller must have both
`catalog.write` and `admin.users`. The R2 environment variables already used for
media storage must be configured.

1. Build one ZIP archive for the SDK and calculate its byte size and lowercase
   SHA-256 hash.
2. `POST /api/v1/plugins/admin/releases` with the driver metadata, size, and hash.
   The response contains the authenticated API upload path.
3. Upload the ZIP to that path using `PUT` and `content-type: application/zip`.
   The API streams it to R2 while independently calculating its SHA-256.
   Uploads whose body exceeds the declared size or is not a ZIP archive are rejected.
4. `POST /api/v1/plugins/admin/releases/:pluginId/:version/publish`.

The publish step confirms the R2 object size, MIME type, and checksum before making
the release appear in the desktop catalog. `POST .../unpublish` removes a version
from the catalog without deleting its release record or archive.

The first published YRM100 release uses this metadata:

```json
{
  "schemaVersion": 1,
  "id": "yrm100-reader",
  "name": "YRM100 RFID Reader",
  "vendor": "YRM",
  "kind": "rfid_reader",
  "version": "2024.5.25",
  "summary": "YRM100 RFID reader SDK and Windows driver package.",
  "description": "Verified YRM100 SDK bundle with Windows CP210x driver, desktop demo files, Android examples, and reference material.",
  "models": ["YRM100"],
  "platforms": ["win32", "android"],
  "capabilities": ["serial", "usb", "esp32_wifi"],
  "packageSizeBytes": 77031726,
  "packageChecksumSha256": "9c042a76cc5bb16b52f8dc33d345891b1779649e144dce02a00a931428a72a62"
}
```

The licensed YRM100 ZIP is stored in R2 rather than source control. The Devices >
Plugins panel in RFIDDaja shows this release and retains the verified unpacked copy
locally after installation.
