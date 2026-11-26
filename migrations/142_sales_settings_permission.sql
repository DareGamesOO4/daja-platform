BEGIN;

INSERT INTO permissions (id, code, module, action, description)
VALUES ('organization.sales.configure', 'organization.sales.configure', 'organization', 'sales.configure',
        'Configure sales services, staff and shifts')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT id, 'organization.sales.configure'
FROM roles
WHERE deleted_at IS NULL
  AND (code IN ('owner', 'system_admin') OR (system_role AND lower(name) = 'storefront_admin'))
ON CONFLICT DO NOTHING;

COMMIT;
