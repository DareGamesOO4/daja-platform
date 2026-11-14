BEGIN;

CREATE TABLE wishlist_alert_preferences (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp')),
  contact text NOT NULL,
  language text NOT NULL CHECK (language IN ('sr','en')),
  policy_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,customer_id,channel)
);

ALTER TABLE product_alert_subscriptions ADD COLUMN wishlist_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE whatsapp_subscriptions ADD COLUMN wishlist_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX product_alert_wishlist_owner_idx ON product_alert_subscriptions(organization_id,wishlist_customer_id,product_id) WHERE wishlist_customer_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX whatsapp_alert_wishlist_owner_idx ON whatsapp_subscriptions(organization_id,wishlist_customer_id,product_id) WHERE wishlist_customer_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX wishlist_alert_contact_idx ON wishlist_alert_preferences(organization_id,channel,contact);

-- A changed or deactivated contact needs fresh consent before future enrollment.
CREATE FUNCTION revoke_wishlist_alerts_on_contact_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.active OR NEW.deleted_at IS NOT NULL OR NOT NEW.email_verified OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN
    DELETE FROM wishlist_alert_preferences WHERE organization_id=NEW.organization_id AND customer_id=NEW.id AND channel='email';
    WITH revoked AS (
      UPDATE product_alert_subscriptions SET active=false,revoked_at=now(),updated_at=now()
      WHERE organization_id=NEW.organization_id AND wishlist_customer_id=NEW.id AND revoked_at IS NULL RETURNING id
    )
    UPDATE email_deliveries d SET status='suppressed',last_error='Wishlist contact changed'
    FROM revoked WHERE d.payload->>'productAlertSubscriptionId'=revoked.id::text AND d.status IN ('pending','failed');
  END IF;

  IF NOT NEW.active OR NEW.deleted_at IS NOT NULL OR NOT NEW.phone_verified OR NEW.phone IS DISTINCT FROM OLD.phone THEN
    DELETE FROM wishlist_alert_preferences WHERE organization_id=NEW.organization_id AND customer_id=NEW.id AND channel='whatsapp';
    WITH revoked AS (
      UPDATE whatsapp_subscriptions SET active=false,revoked_at=now(),updated_at=now()
      WHERE organization_id=NEW.organization_id AND wishlist_customer_id=NEW.id AND revoked_at IS NULL RETURNING id
    )
    UPDATE whatsapp_deliveries d SET state='cancelled',updated_at=now()
    FROM revoked WHERE d.subscription_id=revoked.id AND d.state='queued';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER customers_revoke_wishlist_alerts
AFTER UPDATE OF email,email_verified,phone,phone_verified,active,deleted_at ON customers
FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.email_verified IS DISTINCT FROM NEW.email_verified
  OR OLD.phone IS DISTINCT FROM NEW.phone OR OLD.phone_verified IS DISTINCT FROM NEW.phone_verified
  OR OLD.active IS DISTINCT FROM NEW.active OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION revoke_wishlist_alerts_on_contact_change();

COMMIT;
