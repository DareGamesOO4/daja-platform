BEGIN;
CREATE TABLE catalog_contributor_rate_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  category_id uuid REFERENCES categories(id),
  rate_minor integer NOT NULL CHECK (rate_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX contributor_rate_rules_scope ON catalog_contributor_rate_rules
  (organization_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), department_id,
   COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
COMMIT;
