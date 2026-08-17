BEGIN;

ALTER TABLE desktop_google_oauth_grants
  DROP CONSTRAINT IF EXISTS desktop_google_oauth_grants_callback_loopback_chk;

ALTER TABLE desktop_google_oauth_grants
  ADD CONSTRAINT desktop_google_oauth_grants_callback_loopback_chk CHECK (
    callback_url ~ '^http://127\.0\.0\.1:[1-9][0-9]{0,4}/callback$'
  );

COMMIT;
