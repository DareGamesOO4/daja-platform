CREATE TABLE catalog_search_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  version integer NOT NULL DEFAULT 0,
  synonyms jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog_search_misses (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  query text NOT NULL CHECK (length(query) BETWEEN 2 AND 120),
  department text NOT NULL DEFAULT '',
  day date NOT NULL DEFAULT CURRENT_DATE,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, query, department, day)
);
CREATE INDEX catalog_search_misses_day ON catalog_search_misses(day);
