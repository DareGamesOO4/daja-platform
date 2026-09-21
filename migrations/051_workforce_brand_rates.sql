BEGIN;

ALTER TABLE catalog_contributor_rate_rules
  ADD COLUMN brand_id uuid REFERENCES brands(id);

DROP INDEX contributor_rate_rules_scope;

CREATE UNIQUE INDEX contributor_rate_rules_scope ON catalog_contributor_rate_rules
  (organization_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), department_id,
   COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid),
   COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMIT;
