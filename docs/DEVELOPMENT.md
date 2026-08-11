# Development

## Setup

```bash
npm ci
docker compose up -d postgres redis
cp .env.example .env
npm run db:migrate
```

## Commands

```bash
npm run dev
npm run dev:api
npm run dev:worker
npm run build
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run test:unit
npm run test:integration
```

`npm run db:seed:dev` is intentionally a no-op for Plan 1 and is blocked in production.

## Tests

Integration tests require local PostgreSQL and Redis. They reset the test database schema and are guarded by `NODE_ENV=test`.
