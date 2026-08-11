# Operations

## Local Services

```bash
docker compose up -d postgres redis
```

PostgreSQL runs on `localhost:5432`. Redis runs on `localhost:6379`.

## Migrations

```bash
npm run db:migrate
npm run db:status
```

API boot never applies migrations. Production deploys must run the migration command as a separate release step.

## Health

- `GET /health/live`: process is alive.
- `GET /health/ready`: PostgreSQL and Redis connectivity verified.

Readiness returns minimal diagnostics only.

## Worker

The worker connects to Redis and listens on the `daja-foundation` BullMQ queue. Unknown production job names fail and are recorded through queue failure events.
