-- Give manual checks a turn alongside the regular queue without changing weekly slots.
ALTER TABLE supplier_provider_checks ADD COLUMN last_manual_claim_at timestamptz;
