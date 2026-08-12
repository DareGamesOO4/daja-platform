# Backend Consolidation Status

Batch 1 status: implemented locally, pending real credential dry-runs and client cutover testing.

Implemented:

- Repository audit against DAJA Platform, RFIDDaja, and dajashopweb.
- Capability matrix.
- Staff auth with Argon2id, access JWT, refresh JWT, rotation, session family revocation, device binding, logout, and `/me`.
- Trusted request context and token-derived guards via middleware.
- User/role/location/device session support.
- RFIDDaja-compatible login/refresh token shape.
- Sync contract permissions and existing sync API verification surface.
- R2 bucket/CDN configuration for `dajashop-images` and `https://cdn.dajashop.rs`.
- Firestore dry-run/mapping schema and verified read access to `daja-shop-site`.
- Product/brand/category/spec mapping documentation.
- Existing image reference preservation rules.
- Auth integration tests.

Latest Firestore dry-run:

- `products`: 20 source rows, 20 valid, 0 invalid.
- Image URLs checked through `https://cdn.dajashop.rs/images/...` and returned 200.

Stop point: per `DAJA_PLATFORM_BACKEND_CONSOLIDATION_PLAN.md`, do not continue into later consolidation phases or force production cutover until Batch 1 is reviewed and dry-run/reconciliation outputs are approved.
