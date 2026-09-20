BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.id = 'realtime.read'
WHERE r.code = 'catalog_contributor'
ON CONFLICT DO NOTHING;

COMMIT;
