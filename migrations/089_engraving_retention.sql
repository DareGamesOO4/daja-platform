-- Fixed guest lifetime cannot be extended by repeatedly touching a draft.
-- Existing drafts receive the release timestamp and get the full retention window.
ALTER TABLE engraving_drafts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX engraving_drafts_guest_retention_idx
  ON engraving_drafts(organization_id, created_at) WHERE customer_id IS NULL;
CREATE INDEX engraving_assets_draft_idx ON engraving_assets(draft_id);
