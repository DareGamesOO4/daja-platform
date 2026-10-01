CREATE TABLE catalog_filter_configurations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  department text NOT NULL CHECK (department IN ('satovi', 'daljinski', 'baterije', 'naocare')),
  revision integer NOT NULL DEFAULT 0,
  draft jsonb,
  published jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, department)
);

CREATE TABLE catalog_filter_versions (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  department text NOT NULL,
  revision integer NOT NULL,
  configuration jsonb NOT NULL,
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, department, revision),
  FOREIGN KEY (organization_id, department) REFERENCES catalog_filter_configurations(organization_id, department)
);
