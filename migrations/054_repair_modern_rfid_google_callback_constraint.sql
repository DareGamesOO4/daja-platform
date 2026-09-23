BEGIN;

ALTER TABLE desktop_google_oauth_grants
  DROP CONSTRAINT IF EXISTS desktop_google_oauth_grants_callback_loopback_chk;

-- These credentials are one-time and expire within minutes. Discarding old
-- grants safely removes callback formats no longer approved by the mobile app.
TRUNCATE TABLE desktop_google_oauth_grants;

ALTER TABLE desktop_google_oauth_grants
  ADD CONSTRAINT desktop_google_oauth_grants_callback_loopback_chk CHECK (
    callback_url ~ '^http://127\.0\.0\.1:[1-9][0-9]{0,4}/callback$'
    OR callback_url IN (
      'dajashop-rfid://auth',
      'dajashop-reader-station://auth',
      'modern-rfid://auth',
      'modern-rfid-reader-station://auth'
    )
  );

COMMIT;
