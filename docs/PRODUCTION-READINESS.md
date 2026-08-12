# Production Readiness

## Completed

- Plan 1 foundation remains in place.
- Plan 2 catalog/media/RFID/inventory/import foundations remain in place.
- Plan 3 adds durable sync revisions/events/conflicts.
- Device identity/session/authorization schema exists.
- Sync push/pull/bootstrap/conflict APIs exist.
- Tenant-scoped WebSocket gateway exists.
- OpenAPI generation command exists.
- Production API/worker Dockerfiles exist.
- Production preflight, no-demo check, performance scripts and backup drill script exist.

## Verified Locally

Run these before release:

```bash
npm.cmd run lint
npm.cmd run format:check
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run openapi:check
npm.cmd run check:no-demo
npm.cmd run plan2:perf
npm.cmd run plan3:perf
```

## Not Live Verified

- Cloudflare R2 production bucket/domain upload.
- Firestore read with real service-account credentials.
- Paid PostgreSQL/Redis provider behavior.
- DNS/CDN/TLS routing.

## Blockers Before Public Production

- Replace trusted header identity with real staff/customer/device token verification at the edge or API.
- Complete full public/staff permission matrix tests.
- Run full staging migration rehearsal with real source data.
- Run restore into a fresh staging database, not only local `pg_dump` creation.
- Choose and provision production PostgreSQL/Redis/R2 region/provider with approval.

## Status

Not ready to label production-ready until the blockers above are closed. Ready for a staging deployment and integration rehearsal.
