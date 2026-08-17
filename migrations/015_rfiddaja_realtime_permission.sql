BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('realtime.read', 'Receive live operational change notifications')
ON CONFLICT (id) DO NOTHING;

-- Desktop staff accounts use the same server-provisioned storefront-admin role.
INSERT INTO role_permissions (role_id, permission_id)
SELECT roles.id, 'realtime.read'
FROM roles
WHERE lower(roles.name) = 'storefront_admin'
ON CONFLICT DO NOTHING;

COMMIT;
