# Backup And Restore

## PostgreSQL

Production provider requirements:

- automated backups;
- PITR where available;
- encrypted storage;
- documented retention;
- regular restore drills.

Local drill command:

```bash
npm run backup:restore:drill
```

The script creates test data, runs `pg_dump`, computes a backup checksum and reports critical counts. A full destructive restore into a fresh database should be run in staging before production cutover.

## R2

Media metadata is protected by PostgreSQL backups. R2/object storage should use provider lifecycle/versioning where useful. Derivatives can be regenerated from originals if metadata and original objects are intact.
