CREATE TABLE order_whatsapp_alerts (
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'preparing', 'sending', 'accepted', 'failed', 'unknown', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provider_id text UNIQUE,
  error_code text
);

CREATE INDEX order_whatsapp_alerts_pending ON order_whatsapp_alerts (available_at)
  WHERE state IN ('queued', 'preparing');
