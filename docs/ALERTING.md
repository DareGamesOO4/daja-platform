# Alerting

Future production alerts should be actionable:

- API readiness failure for more than one health interval.
- Elevated 5xx rate.
- Latency regression on public catalog/RFID routes.
- PostgreSQL pool saturation.
- Redis outage or repeated cache errors.
- Stuck worker queue or rising failed job count.
- Repeated media processing failures.
- Sync conflict spike.
- Backup or PITR failure.
- Migration failure.

Avoid alerts that do not identify an operator action.
