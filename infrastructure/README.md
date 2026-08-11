# Infrastructure

Infrastructure definitions live here when they outgrow the root local `docker-compose.yml`.

- `docker/`: shared container assets.
- `development/`: local development infrastructure.
- `staging/`: staging deployment infrastructure.
- `production/`: production deployment infrastructure.

Plan 1 uses the root `docker-compose.yml` for local PostgreSQL and Redis.
