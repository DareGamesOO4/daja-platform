import { Body, Controller, Delete, Get, Inject, Param, Put, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Database } from '@daja/database';
import { TransactionManager } from '@daja/database';
import { ValidationFailedError, requirePermission } from '@daja/security';
import { z } from 'zod';
import { DATABASE, LOGGER } from './tokens.js';
import type { Logger } from '@daja/observability';
import { resolveRequestContext } from './runtime/request-context.js';

const assignmentSchema = z.object({
  roleId: z.string().uuid(),
  scope: z.enum(['location', 'all_locations']),
  locationId: z.string().uuid().optional(),
  primary: z.boolean().optional()
}).superRefine((value, context) => {
  if (value.scope === 'location' && !value.locationId) {
    context.addIssue({ code: 'custom', path: ['locationId'], message: 'Location is required.' });
  }
  if (value.scope === 'all_locations' && value.locationId) {
    context.addIssue({ code: 'custom', path: ['locationId'], message: 'Global assignment cannot have a location.' });
  }
});

const assignmentsSchema = z.object({ assignments: z.array(assignmentSchema).max(100) });
const roleSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).optional() });
const permissionSchema = z.object({ permissions: z.array(z.string().trim().min(1).max(120)).max(300) });
const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(160),
  roleId: z.string().uuid()
});

@Controller('admin/access')
export class AccessControlController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  /** Return the current staff session capabilities for navigation and UI
   * gating. This is intentionally available to every authenticated staff
   * member; it does not expose other users or organization data. */
  @Get('me')
  async me(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    return {
      userId: ctx.userId,
      roles: ctx.roles,
      permissions: ctx.permissions,
      isOwner: Boolean(ctx.isOwner),
    };
  }

  @Get('roles')
  async roles(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['roles.view', 'admin.users']);
    const result = await this.database.pool.query(
      `SELECT r.id, r.organization_id AS "organizationId", r.code, r.name,
              r.description, r.system_role AS "system", r.is_system AS "isSystem",
              COUNT(DISTINCT ura.user_id)::int AS "userCount",
              COALESCE(jsonb_agg(DISTINCT rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL), '[]'::jsonb) AS permissions
       FROM roles r
       LEFT JOIN user_role_assignments ura ON ura.role_id = r.id AND ura.deleted_at IS NULL
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.organization_id = $1 AND r.deleted_at IS NULL
       GROUP BY r.id
       ORDER BY r.name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  @Get('users')
  async users(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['users.view', 'admin.users']);
    const result = await this.database.pool.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.active,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', ura.id, 'roleId', ura.role_id, 'scope', ura.scope,
                'locationId', ura.location_id, 'primary', ura.is_primary
              ) ORDER BY ura.is_primary DESC, ura.created_at)
              FILTER (WHERE ura.id IS NOT NULL), '[]'::jsonb) AS assignments
       FROM users u
       LEFT JOIN user_role_assignments ura
         ON ura.user_id = u.id AND ura.organization_id = u.organization_id AND ura.deleted_at IS NULL
       WHERE u.organization_id = $1
         AND ($2 OR ura.scope = 'all_locations' OR ura.location_id = ANY($3::uuid[]))
       GROUP BY u.id
       ORDER BY u.display_name, u.email`,
      [ctx.organizationId, Boolean(ctx.isOwner), await visibleLocationIds(this.database, ctx)]
    );
    return result.rows;
  }

  @Post('users')
  async createUser(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['users.create', 'admin.users']);
    const input = parse(createUserSchema, body);
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const role = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [input.roleId, ctx.organizationId]
      );
      if (role.rowCount !== 1) throw new ValidationFailedError('Uloga ne postoji u organizaciji.');
      const user = await client.query<{ id: string; email: string; displayName: string }>(
        `INSERT INTO users (organization_id, email, display_name, active)
         VALUES ($1, lower($2), $3, true)
         ON CONFLICT (organization_id, normalized_email)
         DO UPDATE SET display_name = EXCLUDED.display_name, active = true, updated_at = now()
         RETURNING id, email, display_name AS "displayName"`,
        [ctx.organizationId, input.email, input.displayName]
      );
      const created = user.rows[0];
      if (!created) throw new ValidationFailedError('Korisnik nije kreiran.');
      await client.query(
        `INSERT INTO user_role_assignments (organization_id, user_id, role_id, scope, is_primary)
         VALUES ($1, $2, $3, 'all_locations', true)
         ON CONFLICT DO NOTHING`,
        [ctx.organizationId, created.id, input.roleId]
      );
      return { ...created, assignments: [{ roleId: input.roleId, scope: 'all_locations', primary: true }] };
    });
  }

  @Post('roles')
  async createRole(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['roles.create', 'admin.users']);
    const input = parse(roleSchema, body);
    const result = await this.database.pool.query(
      `INSERT INTO roles (organization_id, name, description, system_role, is_system)
       VALUES ($1, $2, $3, false, false)
       RETURNING id, organization_id AS "organizationId", name, description, system_role AS "system"`,
      [ctx.organizationId, input.name, input.description ?? null]
    );
    return result.rows[0];
  }

  @Put('roles/:roleId/permissions')
  async updateRolePermissions(@Req() request: Request, @Param('roleId') roleId: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['roles.manage_permissions', 'admin.users']);
    const input = parse(permissionSchema, body);
    if (!ctx.isOwner) {
      const target = await this.database.pool.query(
        `SELECT 1 FROM user_role_assignments ura JOIN role_permissions rp ON rp.role_id = ura.role_id
         WHERE ura.organization_id = $1 AND ura.user_id = $2 AND ura.deleted_at IS NULL
           AND rp.permission_id = 'roles.manage_permissions'
           AND (ura.scope = 'all_locations' OR ura.location_id = ANY($3::uuid[])) LIMIT 1`,
        [ctx.organizationId, ctx.userId, await visibleLocationIds(this.database, ctx)]
      );
      if (target.rowCount !== 1) throw new Error('Administrator scope is insufficient.');
    }
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM permissions WHERE id = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [roleId, input.permissions]
      );
      await client.query(
        `UPDATE organization_access_policies SET policy_version = policy_version + 1, updated_at = now()
         WHERE organization_id = $1`,
        [ctx.organizationId]
      );
      return { updated: true, roleId, permissions: input.permissions };
    });
  }

  @Put('users/:userId/assignments')
  async updateAssignments(@Req() request: Request, @Param('userId') userId: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requireAnyPermission(ctx, ['users.update', 'admin.users']);
    const input = parse(assignmentsSchema, body);
    const locations = await visibleLocationIds(this.database, ctx);
    if (!ctx.isOwner && input.assignments.some((item) => item.scope === 'all_locations' || !locations.includes(item.locationId ?? ''))) {
      throw new Error('Administrator cannot assign access outside its locations.');
    }
    if (!ctx.isOwner && input.assignments.some((item) => item.scope === 'all_locations')) {
      throw new Error('Only the owner can assign all locations.');
    }
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const user = await client.query(`SELECT 1 FROM users WHERE id = $1 AND organization_id = $2`, [userId, ctx.organizationId]);
      if (user.rowCount !== 1) throw new Error('User not found.');
      await client.query(`UPDATE user_role_assignments SET deleted_at = now(), updated_at = now(), version = version + 1 WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`, [ctx.organizationId, userId]);
      for (const assignment of input.assignments) {
        await client.query(
          `INSERT INTO user_role_assignments (organization_id, user_id, role_id, scope, location_id, is_primary)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [ctx.organizationId, userId, assignment.roleId, assignment.scope, assignment.locationId ?? null, assignment.primary ?? false]
        );
      }
      await client.query(`UPDATE organization_access_policies SET policy_version = policy_version + 1, updated_at = now() WHERE organization_id = $1`, [ctx.organizationId]);
      return { updated: true, userId, assignments: input.assignments };
    });
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationFailedError('Invalid request body', { issues: result.error.issues });
  return result.data;
}

function requireAnyPermission(ctx: { permissions: string[] }, permissions: string[]): void {
  if (!permissions.some((permission) => ctx.permissions.includes(permission))) {
    requirePermission(ctx, permissions[0]!);
  }
}

async function visibleLocationIds(database: Database, ctx: { organizationId: string; userId: string; isOwner?: boolean }): Promise<string[]> {
  if (ctx.isOwner) {
    const result = await database.pool.query(`SELECT id FROM locations WHERE organization_id = $1 AND active AND deleted_at IS NULL`, [ctx.organizationId]);
    return result.rows.map((row: { id: string }) => row.id);
  }
  const result = await database.pool.query(
    `SELECT DISTINCT location_id AS id FROM user_role_assignments
     WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL AND scope = 'location'`,
    [ctx.organizationId, ctx.userId]
  );
  return result.rows.map((row: { id: string }) => row.id);
}
