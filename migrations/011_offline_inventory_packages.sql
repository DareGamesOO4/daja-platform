BEGIN;

CREATE TABLE offline_inventory_packages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  baseline_server_revision bigint NOT NULL CHECK (baseline_server_revision >= 0),
  package jsonb NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);

CREATE INDEX offline_inventory_packages_active_idx
  ON offline_inventory_packages (organization_id, location_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE standalone_count_evidence (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  count_session_id uuid NOT NULL,
  package_id uuid NOT NULL REFERENCES offline_inventory_packages(id),
  idempotency_key text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  reconciliation jsonb NOT NULL CHECK (jsonb_typeof(reconciliation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, count_session_id),
  UNIQUE (organization_id, idempotency_key)
);

COMMIT;
