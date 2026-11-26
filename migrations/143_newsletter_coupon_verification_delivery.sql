BEGIN;

CREATE OR REPLACE VIEW email_active_links AS
SELECT t.token_hash, 'potvrda-email-adrese'::text AS tag, t.expires_at
FROM customer_email_verification_tokens t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id
WHERE t.used_at IS NULL AND c.active AND c.deleted_at IS NULL
UNION ALL
SELECT t.token_hash, 'promena-lozinke', t.expires_at
FROM customer_password_reset_tokens t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id
WHERE t.used_at IS NULL AND c.active AND c.deleted_at IS NULL
UNION ALL
-- A live token may belong to an active coupon subscriber or a legacy pending signup.
SELECT confirmation_token_hash, 'novosti-potvrda', confirmation_expires_at
FROM newsletter_subscribers
WHERE confirmation_token_hash IS NOT NULL AND revoked_at IS NULL
UNION ALL
SELECT token_hash, 'product-alert-confirmation', expires_at FROM product_alert_confirmations WHERE used_at IS NULL;

COMMIT;
