ALTER TABLE wishlist_alert_preferences ADD COLUMN price_coupon_consent_at timestamptz;
ALTER TABLE wishlist_alert_preferences ADD COLUMN price_coupon_consent_version text;
ALTER TABLE promotions ADD COLUMN protected_unit_price integer CHECK (protected_unit_price >= 0);

CREATE TABLE wishlist_price_coupons (
  price_event_id uuid NOT NULL REFERENCES product_regular_price_alert_events (id),
  customer_id uuid NOT NULL REFERENCES customers (id),
  promotion_id uuid NOT NULL UNIQUE REFERENCES promotions (id),
  delivery_id uuid UNIQUE REFERENCES whatsapp_deliveries (id) ON DELETE SET NULL,
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  regular_price_at_issue integer NOT NULL,
  activated_at timestamptz,
  PRIMARY KEY (price_event_id, customer_id)
);
