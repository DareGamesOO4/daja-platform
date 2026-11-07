BEGIN;
ALTER TABLE media_derivative_jobs ADD COLUMN local_worker boolean NOT NULL DEFAULT false;
CREATE INDEX media_derivative_jobs_local_due
  ON media_derivative_jobs (organization_id, available_at, created_at)
  WHERE local_worker AND paused_at IS NULL;
COMMIT;
