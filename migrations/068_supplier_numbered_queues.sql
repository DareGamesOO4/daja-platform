ALTER TABLE supplier_provider_checks
  ADD COLUMN cycle_epoch timestamptz,
  ADD COLUMN interval_seconds integer,
  ADD COLUMN phase_seconds integer,
  ADD COLUMN capacity integer,
  ADD COLUMN pause_reason text,
  ADD COLUMN health_checked_at timestamptz,
  ADD COLUMN health_ok boolean,
  ADD COLUMN probe_requested_at timestamptz;

INSERT INTO supplier_provider_checks(provider_code) VALUES ('ekka'),('bultime'),('timezone'),('qandq') ON CONFLICT DO NOTHING;

UPDATE supplier_provider_checks SET
  interval_seconds = CASE WHEN provider_code IN ('ekka','bultime') THEN 180 ELSE 360 END,
  phase_seconds = CASE provider_code WHEN 'ekka' THEN 0 WHEN 'bultime' THEN 60 WHEN 'timezone' THEN 120 ELSE 300 END,
  capacity = CASE WHEN provider_code IN ('ekka','bultime') THEN 4800 ELSE 2400 END,
  next_request_at = 'infinity', paused_until = NULL, consecutive_errors = 0
WHERE provider_code IN ('ekka','bultime','timezone','qandq');

ALTER TABLE supplier_product_links ALTER COLUMN url DROP NOT NULL;
ALTER TABLE supplier_product_links
  ADD COLUMN queue_position integer,
  ADD COLUMN checks_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN removed boolean NOT NULL DEFAULT false,
  ADD COLUMN generation integer NOT NULL DEFAULT 1,
  ADD COLUMN next_regular_at timestamptz,
  ADD COLUMN initial_requested_at timestamptz,
  ADD COLUMN negative_count integer NOT NULL DEFAULT 0 CHECK (negative_count BETWEEN 0 AND 2),
  ADD COLUMN first_problem_at timestamptz,
  ADD COLUMN first_problem_reason text,
  ADD COLUMN confirmation_due_at timestamptz,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_reason text,
  ADD COLUMN last_good_result jsonb,
  ADD COLUMN window_observed_at timestamptz,
  ADD COLUMN window_bad boolean,
  ADD COLUMN state_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE supplier_state_revisions (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  revision bigint NOT NULL DEFAULT 0
);

UPDATE supplier_product_links l SET checks_enabled = false, disabled_at = now(),
  disabled_reason = 'Ranije potvrđen nestali link'
WHERE provider_code IN ('ekka','bultime','timezone','qandq') AND check_status = 'missing';
UPDATE supplier_product_links l SET checks_enabled = false, removed = true
FROM products p WHERE p.id = l.product_id AND p.deleted_at IS NOT NULL
  AND l.provider_code IN ('ekka','bultime','timezone','qandq');
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY provider_code ORDER BY created_at,id)::integer AS position
  FROM supplier_product_links WHERE provider_code IN ('ekka','bultime','timezone','qandq') AND checks_enabled AND NOT removed
)
UPDATE supplier_product_links l SET queue_position = CASE WHEN r.position <= p.capacity THEN r.position END,
  checks_enabled = r.position <= p.capacity,
  disabled_reason = CASE WHEN r.position > p.capacity THEN 'Red dobavljača je popunjen' ELSE NULL END,
  missing_count = 0
FROM ranked r, supplier_provider_checks p WHERE l.id = r.id AND p.provider_code = l.provider_code;

UPDATE supplier_product_links SET last_good_result=jsonb_build_object('checkedAt',last_checked_at,'stockStatus',stock_status,'priceAmount',price_amount,'priceCurrency',price_currency)
WHERE provider_code IN ('ekka','bultime','timezone','qandq') AND check_status='available' AND last_checked_at IS NOT NULL;

CREATE UNIQUE INDEX supplier_queue_position_unique ON supplier_product_links(provider_code,queue_position)
  WHERE queue_position IS NOT NULL;
CREATE INDEX supplier_regular_due_idx ON supplier_product_links(next_regular_at) WHERE checks_enabled AND NOT removed;

CREATE TABLE supplier_check_leases (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code text NOT NULL REFERENCES supplier_provider_checks(provider_code),
  link_id uuid REFERENCES supplier_product_links(id) ON DELETE CASCADE,
  generation integer,
  kind text NOT NULL CHECK (kind IN ('initial','regular','confirmation','health','legacy','preview')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 seconds'
);
CREATE UNIQUE INDEX supplier_live_link_lease ON supplier_check_leases(link_id) WHERE link_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_live_health_lease ON supplier_check_leases(provider_code) WHERE kind = 'health';

CREATE FUNCTION supplier_regular_slot(epoch timestamptz, phase integer, spacing integer, slot_position integer, reference_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE candidate timestamptz;
BEGIN
  IF epoch IS NULL OR slot_position IS NULL THEN RETURN NULL; END IF;
  candidate := epoch + make_interval(secs => phase + (slot_position - 1) * spacing);
  IF candidate < reference_at THEN
    candidate := candidate + (floor(extract(epoch FROM reference_at - candidate) / 864000)::integer + 1) * interval '240 hours';
  END IF;
  RETURN candidate;
END $$;

CREATE FUNCTION supplier_queue_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config supplier_provider_checks%ROWTYPE; free_position integer; reset_link boolean;
BEGIN
  IF NEW.provider_code NOT IN ('ekka','bultime','timezone','qandq') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('supplier-queue:' || NEW.provider_code));
  SELECT * INTO config FROM supplier_provider_checks WHERE provider_code = NEW.provider_code;
  reset_link := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    reset_link := NEW.url IS DISTINCT FROM OLD.url OR (NEW.checks_enabled AND NOT OLD.checks_enabled) OR (OLD.removed AND NOT NEW.removed);
  END IF;
  IF NEW.url IS NULL OR NEW.removed THEN
    NEW.removed := true; NEW.checks_enabled := false; NEW.queue_position := NULL;
    NEW.next_regular_at := NULL; NEW.initial_requested_at := NULL; NEW.confirmation_due_at := NULL;
    IF TG_OP = 'UPDATE' AND (NOT OLD.removed OR OLD.url IS DISTINCT FROM NEW.url) THEN NEW.generation := OLD.generation + 1; END IF;
  ELSIF reset_link THEN
    NEW.removed := false; NEW.checks_enabled := true;
    IF TG_OP = 'UPDATE' THEN NEW.generation := OLD.generation + 1; END IF;
    IF TG_OP = 'UPDATE' AND NEW.url IS DISTINCT FROM OLD.url THEN
      NEW.last_good_result := NULL; NEW.last_checked_at := NULL; NEW.last_seen_at := NULL;
      NEW.price_amount := NULL; NEW.price_currency := NULL;
    END IF;
    IF NEW.queue_position IS NULL THEN
      SELECT candidate INTO free_position FROM generate_series(1,config.capacity) candidate
      WHERE NOT EXISTS (SELECT 1 FROM supplier_product_links occupied
        WHERE occupied.provider_code = NEW.provider_code AND occupied.queue_position = candidate AND occupied.id <> NEW.id)
      ORDER BY candidate LIMIT 1;
      NEW.queue_position := free_position;
    END IF;
    NEW.checks_enabled := NEW.queue_position IS NOT NULL;
    NEW.disabled_reason := CASE WHEN NEW.queue_position IS NULL THEN 'Red dobavljača je popunjen' ELSE NULL END;
    NEW.disabled_at := NULL; NEW.negative_count := 0; NEW.missing_count := 0;
    NEW.first_problem_at := NULL; NEW.first_problem_reason := NULL; NEW.confirmation_due_at := NULL;
    NEW.last_error := NULL; NEW.check_status := 'unverified'; NEW.stock_status := NULL;
    NEW.initial_requested_at := now(); NEW.window_observed_at := NULL; NEW.window_bad := NULL;
    NEW.next_regular_at := supplier_regular_slot(config.cycle_epoch,config.phase_seconds,config.interval_seconds,NEW.queue_position,now());
  ELSIF NOT NEW.checks_enabled THEN
    NEW.queue_position := NULL; NEW.next_regular_at := NULL; NEW.confirmation_due_at := NULL; NEW.initial_requested_at := NULL;
  END IF;
  INSERT INTO supplier_state_revisions(organization_id,revision) VALUES (NEW.organization_id,1)
    ON CONFLICT (organization_id) DO UPDATE SET revision = supplier_state_revisions.revision + 1
    RETURNING revision INTO NEW.state_revision;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_queue_write_trigger BEFORE INSERT OR UPDATE ON supplier_product_links
FOR EACH ROW EXECUTE FUNCTION supplier_queue_write();

-- Seed current state without resetting migrated statuses or issuing initial checks.
UPDATE supplier_product_links SET updated_at = now() WHERE provider_code IN ('ekka','bultime','timezone','qandq');

CREATE FUNCTION supplier_release_deleted_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('supplier-state'));
    UPDATE supplier_product_links SET removed = true, checks_enabled = false
    WHERE product_id = NEW.id AND provider_code IN ('ekka','bultime','timezone','qandq');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_release_deleted_product_trigger AFTER UPDATE OF deleted_at ON products
FOR EACH ROW EXECUTE FUNCTION supplier_release_deleted_product();

CREATE FUNCTION supplier_publish_provider_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.interval_seconds IS NOT NULL AND
    (NEW.paused_until IS DISTINCT FROM OLD.paused_until OR NEW.pause_reason IS DISTINCT FROM OLD.pause_reason) THEN
    UPDATE supplier_product_links SET updated_at = now() WHERE provider_code = NEW.provider_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_publish_provider_state_trigger AFTER UPDATE ON supplier_provider_checks
FOR EACH ROW EXECUTE FUNCTION supplier_publish_provider_state();
