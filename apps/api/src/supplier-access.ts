import type { Database } from '@daja/database';
import type { RequestContext } from '@daja/shared';

/** Supplier controls also recognize the server-configured storefront administrator.
 * This is a module capability; it does not grant the organization owner role. */
export async function canManageSupplierChecks(database: Database, ctx: RequestContext, configuredEmails: string): Promise<boolean> {
  if (ctx.isOwner) return true;
  const emails = configuredEmails.split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!emails.length || !ctx.permissions.includes('catalog.write')) return false;
  const result = await database.pool.query(`SELECT 1 FROM users u
    JOIN user_role_assignments a ON a.user_id=u.id AND a.organization_id=u.organization_id AND a.deleted_at IS NULL
    JOIN roles r ON r.id=a.role_id AND r.organization_id=u.organization_id AND r.deleted_at IS NULL
    WHERE u.id=$1 AND u.organization_id=$2 AND u.active AND u.normalized_email=ANY($3::text[])
      AND lower(r.name)='storefront_admin' LIMIT 1`, [ctx.userId, ctx.organizationId, emails]);
  return Boolean(result.rowCount);
}
