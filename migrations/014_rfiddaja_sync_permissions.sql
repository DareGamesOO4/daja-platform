BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('sync.read', 'Pull offline sync events'),
  ('sync.write', 'Push offline sync events'),
  ('sync.conflicts', 'Resolve offline sync conflicts')
ON CONFLICT (id) DO NOTHING;

-- Storefront-admin accounts are verified by the server-side Google allowlist.
-- Grant the current sync permission names to already provisioned accounts too.
INSERT INTO role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM roles
CROSS JOIN permissions
WHERE lower(roles.name) = 'storefront_admin'
  AND permissions.id IN ('sync.read', 'sync.write', 'sync.conflicts')
ON CONFLICT DO NOTHING;

COMMIT;
