-- Change regular scheduling only. Fetchers, outcomes, retries, pauses and leases stay unchanged.
SELECT pg_advisory_xact_lock(hashtext('supplier-state'));

ALTER TABLE supplier_provider_checks
  ADD COLUMN cycle_seconds integer NOT NULL DEFAULT 864000 CHECK (cycle_seconds > 0),
  ADD COLUMN regular_interval_seconds integer CHECK (regular_interval_seconds > 0);

-- Reserved phases in the common six-minute frame; these are not active providers.
CREATE TABLE supplier_timeline_reservations (
  slot_code text PRIMARY KEY,
  department text NOT NULL CHECK (department IN ('satovi','ostalo')),
  phase_seconds integer NOT NULL UNIQUE CHECK (phase_seconds >= 0 AND phase_seconds < 360),
  interval_seconds integer NOT NULL CHECK (interval_seconds = 360),
  cycle_seconds integer NOT NULL CHECK (cycle_seconds IN (864000,1296000)),
  capacity integer NOT NULL CHECK (capacity = cycle_seconds / interval_seconds)
);
INSERT INTO supplier_timeline_reservations VALUES
  ('watch_5','satovi',30,360,864000,2400),
  ('watch_6','satovi',90,360,864000,2400),
  ('other_3','ostalo',270,360,1296000,3600);
-- Phase 330 (05:30) remains free.

CREATE FUNCTION supplier_regular_slot(epoch timestamptz, phase integer, spacing integer,
  slot_position integer, reference_at timestamptz, cycle_seconds integer)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE candidate timestamptz;
BEGIN
  IF epoch IS NULL OR slot_position IS NULL THEN RETURN NULL; END IF;
  candidate := epoch + make_interval(secs => phase + (slot_position - 1) * spacing);
  IF candidate < reference_at THEN
    candidate := candidate + ceil(extract(epoch FROM reference_at - candidate) / cycle_seconds)::integer
      * make_interval(secs => cycle_seconds);
  END IF;
  RETURN candidate;
END $$;

-- Legacy providers retain their existing collector and retry behavior. Only their
-- periodic timeline receives positions; interval_seconds stays NULL deliberately.
CREATE FUNCTION supplier_legacy_timeline_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config supplier_provider_checks%ROWTYPE; free_position integer; reset_timeline boolean;
BEGIN
  IF NEW.provider_code NOT IN ('linkel','milano') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('supplier-queue:' || NEW.provider_code));
  SELECT * INTO config FROM supplier_provider_checks WHERE provider_code=NEW.provider_code;
  IF NOT NEW.checks_enabled OR NEW.removed OR NEW.url IS NULL THEN
    NEW.queue_position := NULL;
    RETURN NEW;
  END IF;
  reset_timeline := TG_OP='INSERT';
  IF TG_OP='UPDATE' THEN
    reset_timeline := NEW.url IS DISTINCT FROM OLD.url
      OR NEW.queue_position IS DISTINCT FROM OLD.queue_position
      OR (NEW.checks_enabled AND NOT OLD.checks_enabled)
      OR (OLD.removed AND NOT NEW.removed)
      OR NEW.next_check_at IS DISTINCT FROM OLD.next_check_at;
  END IF;
  IF NEW.queue_position IS NULL THEN
    SELECT candidate INTO free_position FROM generate_series(1,config.capacity) candidate
    WHERE NOT EXISTS (SELECT 1 FROM supplier_product_links occupied
      WHERE occupied.provider_code=NEW.provider_code AND occupied.queue_position=candidate AND occupied.id<>NEW.id)
    ORDER BY candidate LIMIT 1;
    IF free_position IS NULL THEN RAISE EXCEPTION 'Red dobavljača je popunjen'; END IF;
    NEW.queue_position := free_position;
    reset_timeline := true;
  END IF;
  IF reset_timeline AND NEW.last_error IS NULL AND NEW.missing_count=0
    AND NEW.confirmation_due_at IS NULL THEN
    NEW.next_check_at := supplier_regular_slot(config.cycle_epoch,config.phase_seconds,
      config.regular_interval_seconds,NEW.queue_position,now()+interval '1 second',config.cycle_seconds);
  END IF;
  RETURN NEW;
END $$;
-- Runs after supplier_queue_write_trigger, without replacing its state handling.
CREATE TRIGGER supplier_timeline_write_trigger BEFORE INSERT OR UPDATE ON supplier_product_links
  FOR EACH ROW EXECUTE FUNCTION supplier_legacy_timeline_write();

UPDATE supplier_provider_checks SET
  cycle_epoch = TIMESTAMPTZ '2026-10-01 00:00:00 Europe/Belgrade',
  cycle_seconds = CASE WHEN provider_code IN ('linkel','milano') THEN 1296000 ELSE 864000 END,
  regular_interval_seconds = CASE WHEN provider_code IN ('linkel','milano') THEN 360 END,
  phase_seconds = CASE provider_code WHEN 'ekka' THEN 0 WHEN 'bultime' THEN 60
    WHEN 'timezone' THEN 120 WHEN 'qandq' THEN 300 WHEN 'linkel' THEN 150 WHEN 'milano' THEN 210 END,
  capacity = CASE WHEN provider_code IN ('linkel','milano') THEN 3600 ELSE capacity END
WHERE provider_code IN ('ekka','bultime','timezone','qandq','linkel','milano');

-- Past slots move to the next occurrence without replaying this cycle's checks.
UPDATE supplier_product_links l SET next_regular_at=supplier_regular_slot(
  p.cycle_epoch,p.phase_seconds,p.interval_seconds,l.queue_position,now()+interval '1 second',p.cycle_seconds)
FROM supplier_provider_checks p WHERE p.provider_code=l.provider_code
  AND l.provider_code IN ('ekka','bultime','timezone','qandq') AND l.queue_position IS NOT NULL;

UPDATE supplier_product_links SET updated_at=now()
WHERE provider_code IN ('linkel','milano') AND checks_enabled AND NOT removed AND url IS NOT NULL;
