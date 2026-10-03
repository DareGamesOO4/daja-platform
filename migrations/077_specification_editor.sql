CREATE TABLE specification_editor_configurations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  version integer NOT NULL DEFAULT 0,
  configuration jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, department_id)
);
