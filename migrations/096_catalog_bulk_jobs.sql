BEGIN;

CREATE TABLE IF NOT EXISTS catalog_bulk_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  context jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','completed_with_errors','cancelled')),
  total integer NOT NULL CHECK (total BETWEEN 1 AND 1000),
  processed integer NOT NULL DEFAULT 0,
  succeeded integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_bulk_one_active ON catalog_bulk_jobs(organization_id)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS catalog_bulk_due ON catalog_bulk_jobs(next_run_at) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS catalog_bulk_items (
  job_id uuid NOT NULL REFERENCES catalog_bulk_jobs(id) ON DELETE CASCADE,
  position integer NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','conflict','failed')),
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, position)
);

-- Written in the catalog mutation transaction, independent of Redis availability.
CREATE TABLE IF NOT EXISTS catalog_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL,
  context jsonb NOT NULL,
  slugs jsonb NOT NULL,
  cache_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_deliveries_due ON catalog_deliveries(available_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS catalog_deliveries_job ON catalog_deliveries(organization_id, (context->>'correlationId')) WHERE completed_at IS NULL;

COMMIT;
