BEGIN;
CREATE TABLE catalog_work_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid REFERENCES products(id),
  kind text NOT NULL CHECK (kind IN ('create', 'edit', 'review')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  active_seconds double precision NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
  complete boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'abandoned')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX catalog_work_sessions_worker ON catalog_work_sessions(organization_id, user_id, started_at);
CREATE INDEX catalog_work_sessions_product ON catalog_work_sessions(organization_id, product_id);
CREATE TABLE catalog_work_session_clients (
  session_id uuid NOT NULL REFERENCES catalog_work_sessions(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0,
  active_seconds double precision NOT NULL DEFAULT 0,
  released boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, owner_id)
);
CREATE TABLE catalog_work_leases (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  owner_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id, user_id)
);
COMMIT;
