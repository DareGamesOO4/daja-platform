import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@daja/security';
import { createFixtureUser, createTestDatabase, resetDatabase } from '../test/helpers.js';
import { migrate } from './migrations.js';
import { OrganizationRepository } from './repositories.js';
import { StorefrontRepository } from './storefront.js';
import type { Database } from './pool.js';

describe('newsletter double opt-in', () => {
  let database: Database;
  let organizationId: string;

  beforeEach(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
    const organization = await new OrganizationRepository(database.pool).create({
      name: 'Newsletter test',
      slug: 'newsletter-test'
    });
    organizationId = organization.id;
    await createFixtureUser(database.pool, organization.id);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('keeps a subscription pending until its token is confirmed', async () => {
    const repository = new StorefrontRepository(database.pool);
    const pending = await repository.subscribeNewsletter({
      organizationId,
      email: 'customer@example.com',
      verificationTokenHash: 'first-token-hash',
      verificationExpiresAt: new Date(Date.now() + 60_000)
    });

    expect(pending.active).toBe(false);

    const confirmed = await repository.confirmNewsletterSubscription({
      organizationId,
      verificationTokenHash: 'first-token-hash'
    });
    expect(confirmed.email).toBe('customer@example.com');

    const state = await database.pool.query<{
      active: boolean;
      verification_token_hash: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT active, verification_token_hash, confirmed_at
       FROM newsletter_subscribers
       WHERE organization_id = $1 AND normalized_email = lower($2)`,
      [organizationId, 'customer@example.com']
    );
    expect(state.rows[0]).toMatchObject({
      active: true,
      verification_token_hash: null
    });
    expect(state.rows[0]?.confirmed_at).toBeInstanceOf(Date);

    await expect(
      repository.subscribeNewsletter({
        organizationId,
        email: 'customer@example.com',
        verificationTokenHash: 'replacement-token-hash',
        verificationExpiresAt: new Date(Date.now() + 60_000)
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.resourceConflict });
  });

  it('rejects expired confirmation tokens', async () => {
    const repository = new StorefrontRepository(database.pool);
    await repository.subscribeNewsletter({
      organizationId,
      email: 'expired@example.com',
      verificationTokenHash: 'expired-token-hash',
      verificationExpiresAt: new Date(Date.now() - 1_000)
    });

    await expect(
      repository.confirmNewsletterSubscription({
        organizationId,
        verificationTokenHash: 'expired-token-hash'
      })
    ).rejects.toMatchObject({ code: ERROR_CODES.validationFailed });
  });
});
