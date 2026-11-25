BEGIN;

INSERT INTO permissions (id, code, module, action, description)
VALUES ('organization.profile.configure', 'organization.profile.configure', 'organization', 'profile.configure',
        'Edit company name, legal name and tax number')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, 'organization.profile.configure'
FROM roles r
WHERE r.deleted_at IS NULL
  AND (r.code IN ('owner', 'system_admin') OR (r.system_role AND lower(r.name) = 'storefront_admin'))
ON CONFLICT DO NOTHING;

COMMIT;
