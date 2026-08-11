import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@daja/security';
import { AuditRepository } from './audit.js';
import { IdempotencyStore } from './idempotency.js';
import { migrate } from './migrations.js';
import { OrganizationRepository } from './repositories.js';
import { TransactionManager } from './transaction.js';
import { contextFor, createTestDatabase, resetDatabase } from '../test/helpers.js';
import type { Database } from './pool.js';
import { createLogger } from '@daja/observability';
import { loadConfig } from '@daja/config';

describe('foundation data access', () => {
  let database: Database;

  beforeEach(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('blocks cross-tenant organization reads', async () => {
    const repository = new OrganizationRepository(database.pool);
    const tenantA = await repository.create({ name: 'Tenant A', slug: 'tenant-a' });
    const tenantB = await repository.create({ name: 'Tenant B', slug: 'tenant-b' });

    await expect(
      repository.findByIdForContext(contextFor(tenantA.id), tenantB.id)
    ).rejects.toMatchObject({
      code: ERROR_CODES.tenantAccessDenied
    });
  });

  it('returns a stable optimistic concurrency conflict', async () => {
    const repository = new OrganizationRepository(database.pool);
    const organization = await repository.create({ name: 'Tenant A', slug: 'tenant-a' });

    await repository.updateName(contextFor(organization.id), {
      id: organization.id,
      expectedVersion: organization.version,
      name: 'Tenant A Updated'
    });

    await expect(
      repository.updateName(contextFor(organization.id), {
        id: organization.id,
        expectedVersion: organization.version,
        name: 'Stale Update'
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.resourceVersionConflict });
  });

  it('rejects audit row update and delete', async () => {
    const repository = new OrganizationRepository(database.pool);
    const organization = await repository.create({ name: 'Tenant A', slug: 'tenant-a' });
    const auditId = await new AuditRepository(database.pool).append({
      ctx: contextFor(organization.id),
      aggregateType: 'organization',
      aggregateId: organization.id,
      operation: 'create',
      afterPayload: organization
    });

    await expect(
      database.query('UPDATE audit_events SET operation = $1 WHERE id = $2', ['changed', auditId])
    ).rejects.toThrow(/append-only/);
    await expect(
      database.query('DELETE FROM audit_events WHERE id = $1', [auditId])
    ).rejects.toThrow(/append-only/);
  });

  it('replays matching idempotency requests and rejects mismatched reuse', async () => {
    const organization = await new OrganizationRepository(database.pool).create({
      name: 'Tenant A',
      slug: 'tenant-a'
    });
    const store = new IdempotencyStore(database.pool);
    let calls = 0;

    const first = await store.run(organization.id, 'idem-1', { name: 'same' }, () => {
      calls += 1;
      return Promise.resolve({ status: 201, payload: { id: 'created' } });
    });
    const second = await store.run(organization.id, 'idem-1', { name: 'same' }, () => {
      calls += 1;
      return Promise.resolve({ status: 201, payload: { id: 'other' } });
    });

    expect(first.replayed).toBe(false);
    expect(second).toEqual({ replayed: true, status: 201, payload: { id: 'created' } });
    expect(calls).toBe(1);
    await expect(
      store.run(organization.id, 'idem-1', { name: 'different' }, () =>
        Promise.resolve({
          status: 201,
          payload: {}
        })
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.idempotencyConflict });
  });

  it('rolls back all work when a transaction fails', async () => {
    const config = loadConfig();
    const tx = new TransactionManager(database.pool, createLogger(config, 'test'));

    await expect(
      tx.run(async (client) => {
        await new OrganizationRepository(client).create({
          name: 'Rolled Back',
          slug: 'rolled-back'
        });
        throw new Error('fail after write');
      })
    ).rejects.toThrow(/fail after write/);

    const rows = await database.query<{ count: string }>(
      'SELECT count(*) FROM organizations WHERE slug = $1',
      ['rolled-back']
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
