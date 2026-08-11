import type pg from 'pg';
import type { QueryResultRow } from 'pg';
import { TenantAccessDeniedError, VersionConflictError } from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export class OrganizationRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async create(input: {
    name: string;
    slug: string;
    status?: string;
  }): Promise<OrganizationRecord> {
    const result = await this.client.query<OrganizationRow>(
      `INSERT INTO organizations (name, slug, status)
       VALUES ($1, $2, $3)
       RETURNING id, name, slug, status, version, created_at, updated_at, deleted_at`,
      [input.name, input.slug, input.status ?? 'active']
    );
    return mapOrganization(requireRow(result));
  }

  async findByIdForContext(ctx: RequestContext, id: string): Promise<OrganizationRecord> {
    if (ctx.organizationId !== id) {
      throw new TenantAccessDeniedError();
    }

    const result = await this.client.query<OrganizationRow>(
      `SELECT id, name, slug, status, version, created_at, updated_at, deleted_at
       FROM organizations
       WHERE id = $1 AND deleted_at IS NULL`,
      [ctx.organizationId]
    );

    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    return mapOrganization(requireRow(result));
  }

  async updateName(
    ctx: RequestContext,
    input: { id: string; expectedVersion: number; name: string }
  ): Promise<OrganizationRecord> {
    if (ctx.organizationId !== input.id) {
      throw new TenantAccessDeniedError();
    }

    const result = await this.client.query<OrganizationRow>(
      `UPDATE organizations
       SET name = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL
       RETURNING id, name, slug, status, version, created_at, updated_at, deleted_at`,
      [input.name, input.id, input.expectedVersion]
    );

    if (result.rowCount === 0) {
      throw new VersionConflictError();
    }
    return mapOrganization(requireRow(result));
  }
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  version: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function requireRow<T extends QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error('Expected database row was not returned');
  }
  return row;
}

function mapOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}
