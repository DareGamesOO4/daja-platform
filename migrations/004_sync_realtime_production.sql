BEGIN;

CREATE TABLE organization_revisions (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id),
  current_revision bigint NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_revisions (organization_id, current_revision)
SELECT id, 0
FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid REFERENCES users (id),
  location_id uuid REFERENCES locations (id),
  device_key text NOT NULL,
  display_name text NOT NULL,
  device_type text NOT NULL CHECK (device_type IN ('rfiddaja_desktop', 'rfiddaja_mobile', 'pos', 'admin', 'bridge', 'other')),
  active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  offline_authorization_expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX devices_org_key_uq ON devices (organization_id, device_key) WHERE deleted_at IS NULL;
CREATE INDEX devices_org_user_idx ON devices (organization_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX devices_org_location_idx ON devices (organization_id, location_id) WHERE deleted_at IS NULL;

CREATE TABLE device_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  user_id uuid REFERENCES users (id),
  refresh_token_hash text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX device_sessions_org_device_active_idx ON device_sessions (organization_id, device_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE device_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  location_id uuid REFERENCES locations (id),
  permission text NOT NULL,
  granted_by uuid REFERENCES users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX device_authorizations_active_uq ON device_authorizations (organization_id, device_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), permission) WHERE revoked_at IS NULL;

CREATE TABLE server_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid REFERENCES locations (id),
  device_id uuid REFERENCES devices (id),
  user_id uuid REFERENCES users (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  operation text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version > 0),
  base_version bigint,
  client_timestamp timestamptz,
  server_timestamp timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  request_id uuid,
  correlation_id uuid
);
CREATE UNIQUE INDEX server_sync_events_org_revision_uq ON server_sync_events (organization_id, revision);
CREATE UNIQUE INDEX server_sync_events_org_idempotency_uq ON server_sync_events (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX server_sync_events_org_aggregate_idx ON server_sync_events (organization_id, aggregate_type, aggregate_id, revision DESC);
CREATE INDEX server_sync_events_org_location_revision_idx ON server_sync_events (organization_id, location_id, revision) WHERE location_id IS NOT NULL;

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  event_id uuid,
  device_id uuid REFERENCES devices (id),
  user_id uuid REFERENCES users (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  operation text NOT NULL,
  base_version bigint,
  server_version bigint,
  client_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(client_payload) = 'object'),
  server_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(server_payload) = 'object'),
  status text NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'rejected')),
  resolution jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resolution) = 'object'),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id)
);
CREATE INDEX sync_conflicts_unresolved_idx ON sync_conflicts (organization_id, created_at DESC, id) WHERE status = 'unresolved';
CREATE INDEX sync_conflicts_aggregate_idx ON sync_conflicts (organization_id, aggregate_type, aggregate_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_sync_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'server_sync_events is append-only' USING ERRCODE = '45000';
END;
$$;

CREATE TRIGGER server_sync_events_no_update
BEFORE UPDATE ON server_sync_events
FOR EACH ROW EXECUTE FUNCTION reject_sync_event_mutation();

CREATE TRIGGER server_sync_events_no_delete
BEFORE DELETE ON server_sync_events
FOR EACH ROW EXECUTE FUNCTION reject_sync_event_mutation();

CREATE OR REPLACE FUNCTION enforce_plan3_tenant_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_org uuid;
BEGIN
  IF TG_TABLE_NAME = 'devices' THEN
    IF NEW.user_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM users WHERE id = NEW.user_id;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'device user organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.location_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM locations WHERE id = NEW.location_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'device location organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'device_sessions' THEN
    SELECT organization_id INTO ref_org FROM devices WHERE id = NEW.device_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'device session organization mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'device_authorizations' THEN
    SELECT organization_id INTO ref_org FROM devices WHERE id = NEW.device_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'device authorization organization mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.location_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM locations WHERE id = NEW.location_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'device authorization location organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER devices_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, user_id, location_id ON devices
FOR EACH ROW EXECUTE FUNCTION enforce_plan3_tenant_integrity();

CREATE TRIGGER device_sessions_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, device_id ON device_sessions
FOR EACH ROW EXECUTE FUNCTION enforce_plan3_tenant_integrity();

CREATE TRIGGER device_authorizations_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, device_id, location_id ON device_authorizations
FOR EACH ROW EXECUTE FUNCTION enforce_plan3_tenant_integrity();

COMMIT;
