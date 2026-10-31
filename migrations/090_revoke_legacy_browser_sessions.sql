-- Browser credentials formerly lived in JavaScript storage. Retire those
-- existing customer session families once before HttpOnly-cookie rollout.
-- RFID staff sessions use a separate table and are deliberately preserved.
UPDATE customer_sessions
SET revoked_at = now(), revoked_reason = 'browser_cookie_session_migration'
WHERE revoked_at IS NULL;
