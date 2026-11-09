CREATE TABLE supplier_linkel_workers (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_bulk_claim_at timestamptz
);

ALTER TABLE supplier_check_leases ADD COLUMN worker_id text REFERENCES supplier_linkel_workers(worker_id);
CREATE UNIQUE INDEX supplier_linkel_bulk_worker_lease ON supplier_check_leases(worker_id)
  WHERE provider_code='linkel' AND worker_id IS NOT NULL;
