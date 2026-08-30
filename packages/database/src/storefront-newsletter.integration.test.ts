import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@daja/security';
import { createFixtureUser, createTestDatabase, resetDatabase } from '../test/helpers.js';
import { migrate } from './migrations.js';
import { OrganizationRepository } from './repositories.js';
import { StorefrontRepository } from './storefront.js';
import type { Database } from './pool.js';

describe('storefront email subscriptions and verification', () => {
  let database: Database;
  let organizationId: string;

  beforeEach(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
    const organization = await new OrganizationRepository(database.pool).create({
      name: 'Storefront email test',
      slug: 'storefront-email-test'
    });
    organizationId = organization.id;
    await createFixtureUser(database.pool, organization.id);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('activates newsletter subscriptions immediately and rejects duplicates', async () => {
    const repository = new StorefrontRepository(database.pool);
    const subscription = await repository.subscribeNewsletter({
      organizationId,
      email: 'customer@example.com'
    });

    expect(subscription.active).toBe(true);
    await expect(
      repository.subscribeNewsletter({ organizationId, email: 'customer@example.com' })
    ).rejects.toMatchObject({ code: ERROR_CODES.resourceConflict });
  });

  it('verifies a customer email with a single-use, valid token', async () => {
    const repository = new StorefrontRepository(database.pool);
    const customer = await repository.createPasswordCustomer({
      organizationId,
      email: 'customer@example.com',
      displayName: 'Customer',
      passwordHash: 'not-used-by-this-test'
    });

    await repository.createCustomerEmailVerification({
      organizationId,
      customerId: customer.customerId,
      tokenHash: 'valid-token-hash',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });
    await expect(repository.confirmCustomerEmailVerification('valid-token-hash')).resolves.toMatchObject({
      email: 'customer@example.com',
      customerId: customer.customerId,
      organizationId
    });
    await expect(repository.confirmCustomerEmailVerification('valid-token-hash')).rejects.toMatchObject({
      code: ERROR_CODES.validationFailed
    });
  });

  it('rejects expired customer verification tokens', async () => {
    const repository = new StorefrontRepository(database.pool);
    const customer = await repository.createPasswordCustomer({
      organizationId,
      email: 'expired@example.com',
      displayName: 'Expired customer',
      passwordHash: 'not-used-by-this-test'
    });
    await repository.createCustomerEmailVerification({
      organizationId,
      customerId: customer.customerId,
      tokenHash: 'expired-token-hash',
      expiresAt: new Date(Date.now() - 1000)
    });

    await expect(repository.confirmCustomerEmailVerification('expired-token-hash')).rejects.toMatchObject({
      code: ERROR_CODES.validationFailed
    });
  });
});
