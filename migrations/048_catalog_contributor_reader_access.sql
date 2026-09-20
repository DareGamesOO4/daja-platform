BEGIN;

-- Product editors can use the already-registered G2 reader from the product
-- form to fill EPC/barcode fields. Reader ownership and active-session locks
-- remain enforced by ReaderStationService.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.id = 'rfid.scan'
WHERE r.code = 'catalog_contributor'
ON CONFLICT DO NOTHING;

COMMIT;
