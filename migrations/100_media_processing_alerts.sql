BEGIN;
ALTER TABLE media_derivative_jobs ADD COLUMN last_error_at timestamptz;

CREATE TABLE media_processing_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('upload','overnight')),
  error_code text NOT NULL,
  message text NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,
  event_key text NOT NULL,
  first_failure_at timestamptz NOT NULL DEFAULT now(),
  last_failure_at timestamptz NOT NULL DEFAULT now(),
  retry_requested_at timestamptz,
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('ready','removed','dismissed')),
  UNIQUE (organization_id,media_asset_id,phase)
);
CREATE INDEX media_processing_alerts_inbox ON media_processing_alerts(organization_id,last_failure_at DESC,id);
CREATE INDEX media_processing_alerts_open ON media_processing_alerts(organization_id) WHERE resolved_at IS NULL;
CREATE INDEX media_derivative_jobs_expired ON media_derivative_jobs(organization_id,lease_until) WHERE lease_until IS NOT NULL;

CREATE TABLE media_processing_alert_reads (
  alert_id uuid NOT NULL REFERENCES media_processing_alerts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_through timestamptz NOT NULL,
  seen_event_key text NOT NULL,
  PRIMARY KEY (alert_id,user_id)
);

-- Surface failures already waiting in the queue when this release is installed.
INSERT INTO media_processing_alerts
  (organization_id,media_asset_id,phase,error_code,message,occurrences,event_key)
SELECT organization_id,media_asset_id,'overnight','DERIVATIVES_RETRY',
  'Noćna obrada nije uspela. Velika AVIF slika je dostupna; ostale verzije čekaju ponovni pokušaj.',
  greatest(attempts,1),'migration-100'
FROM media_derivative_jobs WHERE last_error_code IS NOT NULL;
COMMIT;
