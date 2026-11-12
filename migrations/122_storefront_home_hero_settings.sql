CREATE TABLE storefront_home_hero_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  interval_ms integer NOT NULL DEFAULT 5600 CHECK (interval_ms = 0 OR interval_ms BETWEEN 3000 AND 30000),
  slides jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(slides) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
