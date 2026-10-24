BEGIN;

-- Restore the welcome offer for existing storefronts with all eligibility
-- checks enforced by the same promotion engine used at final checkout.
INSERT INTO promotions (
  organization_id, code, name, description, active, discount_type, discount_value,
  applies_to, login_requirement, requires_verified_email, requires_newsletter,
  first_order_only, per_customer_usage_limit
)
SELECT id, 'DOBRODOSLI10', 'Newsletter dobrodošlice',
  '10% popusta na prvu porudžbinu za prijavljene kupce sa verifikovanim emailom i aktivnom newsletter pretplatom.',
  true, 'percentage', 10, 'order', 'authenticated', true, true, true, 1
FROM organizations
ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO UPDATE SET
  active = true, discount_type = 'percentage', discount_value = 10,
  applies_to = 'order', login_requirement = 'authenticated',
  requires_verified_email = true, requires_newsletter = true, first_order_only = true,
  per_customer_usage_limit = 1, updated_at = now();

COMMIT;
