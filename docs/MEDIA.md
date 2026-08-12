# Media

Media metadata is stored in PostgreSQL. Binary media is stored in R2/S3-compatible object storage.

Normal public media reads must go through CDN/R2 URLs, not through NestJS.

Implemented local flow:

1. API creates `media_assets(status=pending_upload)`.
2. API returns presigned PUT URL.
3. Client uploads to R2/S3-compatible storage.
4. API verifies object existence with `HEAD`.
5. Worker processes image with Sharp and writes WebP derivative metadata.

Local verification uses MinIO. Live Cloudflare R2 verification still requires real credentials.
