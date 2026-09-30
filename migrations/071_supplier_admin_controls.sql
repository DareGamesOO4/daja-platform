-- Current controls and bounded aggregates; existing queue positions and epochs are preserved.
ALTER TABLE supplier_provider_checks
 ADD COLUMN manual_pause_mode text CHECK(manual_pause_mode IN ('schedule','all')),
 ADD COLUMN manual_pause_until timestamptz,
 ADD COLUMN manual_pause_at timestamptz,
 ADD COLUMN manual_pause_reason text,
 ADD COLUMN manual_pause_by text,
 ADD COLUMN statistics_started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE supplier_product_links ADD COLUMN manual_requested_at timestamptz;
ALTER TABLE supplier_check_leases DROP CONSTRAINT supplier_check_leases_kind_check;
ALTER TABLE supplier_check_leases ADD CONSTRAINT supplier_check_leases_kind_check CHECK(kind IN ('initial','regular','confirmation','health','legacy','preview','manual'));
CREATE TABLE supplier_hourly_statistics (
 scope_id text NOT NULL, provider_code text NOT NULL REFERENCES supplier_provider_checks(provider_code),
 hour_at timestamptz NOT NULL, completed bigint NOT NULL DEFAULT 0,
 available bigint NOT NULL DEFAULT 0, missing bigint NOT NULL DEFAULT 0,
 out_of_stock bigint NOT NULL DEFAULT 0, errors bigint NOT NULL DEFAULT 0,
 duration_ms bigint NOT NULL DEFAULT 0, max_duration_ms bigint NOT NULL DEFAULT 0,
 skipped bigint NOT NULL DEFAULT 0, disabled bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(scope_id,provider_code,hour_at)
);
CREATE INDEX supplier_statistics_retention ON supplier_hourly_statistics(hour_at);
CREATE OR REPLACE FUNCTION supplier_queue_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config supplier_provider_checks%ROWTYPE; free_position integer; reset_link boolean;
BEGIN
  IF NEW.provider_code IN ('linkel','milano') THEN
    IF TG_OP='INSERT' THEN NEW.initial_requested_at:=now();
    ELSIF NEW.url IS DISTINCT FROM OLD.url OR (NEW.checks_enabled AND NOT OLD.checks_enabled) THEN
      NEW.generation:=OLD.generation+1; NEW.checks_enabled:=true; NEW.removed:=NEW.url IS NULL;
      NEW.initial_requested_at:=now(); NEW.manual_requested_at:=NULL; NEW.disabled_reason:=NULL; NEW.disabled_at:=NULL;
      NEW.missing_count:=0; NEW.last_error:=NULL; NEW.first_problem_at:=NULL; NEW.first_problem_reason:=NULL; NEW.confirmation_due_at:=NULL;
      IF NEW.url IS DISTINCT FROM OLD.url THEN NEW.last_good_result:=NULL; NEW.last_checked_at:=NULL; NEW.last_seen_at:=NULL; END IF;
    ELSIF NOT NEW.checks_enabled AND OLD.checks_enabled THEN
      NEW.generation:=OLD.generation+1; NEW.initial_requested_at:=NULL; NEW.manual_requested_at:=NULL;
    END IF;
    IF NEW.url IS NULL OR NEW.removed THEN
      IF TG_OP='UPDATE' AND NOT OLD.removed THEN NEW.generation:=OLD.generation+1; END IF;
      NEW.confirmation_due_at:=NULL; NEW.checks_enabled:=false; NEW.initial_requested_at:=NULL; NEW.manual_requested_at:=NULL; END IF;
    INSERT INTO supplier_state_revisions(organization_id,revision) VALUES (NEW.organization_id,1)
      ON CONFLICT(organization_id) DO UPDATE SET revision=supplier_state_revisions.revision+1 RETURNING revision INTO NEW.state_revision;
    NEW.updated_at:=now(); RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('supplier-queue:' || NEW.provider_code));
  SELECT * INTO config FROM supplier_provider_checks WHERE provider_code = NEW.provider_code;
  reset_link := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    reset_link := NEW.url IS DISTINCT FROM OLD.url OR (NEW.checks_enabled AND NOT OLD.checks_enabled) OR (OLD.removed AND NOT NEW.removed);
  END IF;
  IF NEW.url IS NULL OR NEW.removed THEN
    NEW.removed := true; NEW.checks_enabled := false; NEW.queue_position := NULL; NEW.manual_requested_at := NULL;
    NEW.next_regular_at := NULL; NEW.initial_requested_at := NULL; NEW.confirmation_due_at := NULL;
    IF TG_OP = 'UPDATE' AND (NOT OLD.removed OR OLD.url IS DISTINCT FROM NEW.url) THEN NEW.generation := OLD.generation + 1; END IF;
  ELSIF reset_link THEN
    NEW.removed := false; NEW.checks_enabled := true; NEW.manual_requested_at := NULL;
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
    NEW.manual_requested_at := NULL;
    IF TG_OP='UPDATE' AND OLD.checks_enabled THEN NEW.generation:=OLD.generation+1; END IF;
    NEW.queue_position := NULL; NEW.next_regular_at := NULL; NEW.confirmation_due_at := NULL; NEW.initial_requested_at := NULL;
  END IF;
  INSERT INTO supplier_state_revisions(organization_id,revision) VALUES (NEW.organization_id,1)
    ON CONFLICT (organization_id) DO UPDATE SET revision = supplier_state_revisions.revision + 1
    RETURNING revision INTO NEW.state_revision;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION supplier_publish_provider_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.paused_until IS DISTINCT FROM OLD.paused_until OR NEW.pause_reason IS DISTINCT FROM OLD.pause_reason
 OR NEW.manual_pause_mode IS DISTINCT FROM OLD.manual_pause_mode OR NEW.manual_pause_until IS DISTINCT FROM OLD.manual_pause_until
 OR NEW.manual_pause_reason IS DISTINCT FROM OLD.manual_pause_reason THEN
   UPDATE supplier_product_links SET updated_at=now() WHERE provider_code=NEW.provider_code;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION supplier_release_deleted_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtext('supplier-state'));
   UPDATE supplier_product_links SET removed=true,checks_enabled=false WHERE product_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
-- Publish legacy links once without scheduling initial checks.
UPDATE supplier_product_links SET updated_at=now() WHERE provider_code IN ('linkel','milano');

UPDATE supplier_product_links l SET removed=true,checks_enabled=false FROM products p WHERE p.id=l.product_id AND p.deleted_at IS NOT NULL AND l.provider_code IN ('linkel','milano');
