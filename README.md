# DAJA Platform

Central NestJS API, worker, and PostgreSQL datastore for DAJA business systems.

PostgreSQL is the authoritative business datastore. Client applications must use
the API and must not connect directly to PostgreSQL.

## Quick Start

```bash
npm ci
docker compose up -d postgres redis
cp .env.example .env
npm run db:migrate
npm run dev
```

API health:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

See `docs/DEVELOPMENT.md` for the full local workflow.
