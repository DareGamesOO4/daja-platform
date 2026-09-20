BEGIN;

-- Product editors need to see the organization's placement tree and persist
-- the quantity/location selected in the product form. Product and variant
-- ownership is still enforced by the catalog endpoints before saving.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.id IN ('inventory.read', 'inventory.adjust')
WHERE r.code = 'catalog_contributor'
ON CONFLICT DO NOTHING;

COMMIT;
