BEGIN;

-- Move older pending image jobs from the legacy overnight queue to the PC queue.
UPDATE media_derivative_jobs j
SET local_worker = true
FROM media_assets a
WHERE j.organization_id = a.organization_id
  AND j.media_asset_id = a.id
  AND NOT j.local_worker
  AND j.attempts < 8
  AND j.paused_at IS NULL
  AND a.status = 'ready'
  AND a.deleted_at IS NULL
  AND a.storage_key = j.avif_main_key;

COMMIT;
