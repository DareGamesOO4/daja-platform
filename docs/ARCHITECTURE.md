# Architecture

DAJA Platform is the central backend for webshop, RFID, POS, admin, ERP, marketplace, automation, and device integrations.

PostgreSQL is the future master business datastore. Firestore data from `dajashopweb` can be migrated or referenced during migration, but Firestore must not remain a permanent second master because dual authoritative stores would create inventory, catalog, media, audit, and tenant consistency failures.

The implementation preserves RFIDDaja concepts that fit the central platform:

- NestJS API boundary.
- PostgreSQL tenant scope.
- Explicit versions for optimistic concurrency.
- Append-only audit events.
- Idempotency records.
- Redis-backed queue infrastructure.
- Clear server-side ownership of sync and integration primitives.

The implementation does not preserve RFIDDaja's in-memory repository or demo runtime mode. Production paths require PostgreSQL and Redis.

## Structure

- `apps/api`: NestJS HTTP API under `/api/v1` plus `/health/live` and `/health/ready`.
- `apps/worker`: BullMQ worker connected to Redis.
- `packages/config`: Zod environment validation.
- `packages/database`: PostgreSQL pool, query timing, migrations, transactions, repositories, Redis connection.
- `packages/observability`: Pino logger factory with redaction.
- `packages/security`: stable application errors.
- `packages/contracts`, `packages/shared`, `packages/validation`: shared API and runtime primitives.
- `migrations`: ordered SQL migrations.

API startup does not mutate schema. Run migrations explicitly with `npm run db:migrate`.
