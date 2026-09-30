CREATE OR REPLACE FUNCTION supplier_regular_slot(epoch timestamptz, phase integer, spacing integer, slot_position integer, reference_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE candidate timestamptz;
BEGIN
  IF epoch IS NULL OR slot_position IS NULL THEN RETURN NULL; END IF;
  candidate := epoch + make_interval(secs => phase + (slot_position - 1) * spacing);
  IF candidate < reference_at THEN
    candidate := candidate + ceil(extract(epoch FROM reference_at - candidate) / 864000)::integer * interval '240 hours';
  END IF;
  RETURN candidate;
END $$;
