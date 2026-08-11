# Database

PostgreSQL is the authoritative store for DAJA business state.

## Migrations

Migrations are ordered SQL files in `migrations/`. The runner:

- Uses `schema_migrations` for history.
- Uses a PostgreSQL advisory lock to prevent concurrent deploys from migrating.
- Verifies migration checksums.
- Stops on first failure.
- Does not run from API startup.

Commands:

```bash
npm run db:migrate
npm run db:status
```

## Current Migration

`001_core_foundation.sql` creates:

- `organizations`
- `locations`
- `users`
- `roles`
- `permissions`
- `role_permissions`
- `user_roles`
- `user_location_assignments`
- `idempotency_records`
- `audit_events`
- `schema_migrations`

Core tables use UUID primary keys and `timestamptz`. Mutable aggregates use `version bigint not null default 1`.

## Production Role

Production should use a non-superuser application role with privileges limited to the application database and schema. Do not run the API with a cluster superuser.
