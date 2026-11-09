ALTER TABLE media_worker_settings
  ADD COLUMN studio_seen_at timestamptz,
  ADD COLUMN studio_image_error text,
  ADD COLUMN studio_image_error_since timestamptz,
  ADD COLUMN studio_linkel_error text,
  ADD COLUMN studio_linkel_error_since timestamptz,
  ADD COLUMN studio_notified_mask integer NOT NULL DEFAULT 0;
