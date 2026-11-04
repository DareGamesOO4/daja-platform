# Product image filenames

New generated product files use `<model>-<index>.avif`, `<model>-<index>.webp`,
`<model>-<index>-thumb.avif` and `<model>-<index>-thumb.webp`.

R2 paths retain immutable media/revision directories, for example:
`c10a-019py/<media-id>/<revision-id>/c10a-019py-1.avif`.
Source uploads live under `<model>/<media-id>/source/` separately from generated
files. Existing stored objects and URLs are not renamed.

Each attempt has a different revision directory. This preserves immutable CDN
caching and prevents delayed cleanup of a failed or replaced asset from deleting
a new file. A fixed `<model>/<model>-1.avif` object key would not provide that
isolation and is intentionally not reused.

The initial pipeline still encodes only the main AVIF. During the existing
03:00–07:00 job, the three remaining formats are encoded as before. The main AVIF
is copied, without re-encoding, alongside the new WebP revision so replacing the
extension selects a real paired file. The initial AVIF remains referenced and
valid for previously returned URLs. Both layouts are supported by the storefront
format-selection helper.

No tests or deployment completion checks were run, per project instructions.
