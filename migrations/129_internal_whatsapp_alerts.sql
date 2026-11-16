CREATE TABLE internal_whatsapp_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('contact', 'studio_offline')),
  event_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'sending', 'accepted', 'failed', 'unknown', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  provider_id text UNIQUE,
  error_code text,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, kind, event_key)
);

CREATE INDEX internal_whatsapp_alerts_pending ON internal_whatsapp_alerts (organization_id, available_at)
  WHERE state = 'queued';
