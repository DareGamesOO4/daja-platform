BEGIN;
ALTER TABLE media_derivative_jobs ADD COLUMN paused_at timestamptz;

-- Old permanent failures must not keep cycling after this release.
UPDATE media_derivative_jobs SET paused_at=now()
WHERE attempts >= 8 AND last_error_code IS NOT NULL;

CREATE INDEX media_derivative_jobs_due_active
  ON media_derivative_jobs(available_at,created_at)
  WHERE paused_at IS NULL;
COMMIT;
