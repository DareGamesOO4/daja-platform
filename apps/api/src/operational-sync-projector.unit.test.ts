import { describe, expect, it, vi } from 'vitest';
import { OperationalSyncProjector } from './operational-sync-projector.js';

type StateProjector = {
  applyRfidCycleCountState(
    ctx: { organizationId: string; deviceId?: string },
    countId: string,
    count: Record<string, unknown>,
    action: 'review' | 'complete' | 'cancel',
    existing: { ownerDeviceId: string | null; status: string; version: string }
  ): Promise<void>;
};

describe('OperationalSyncProjector RFID terminal state', () => {
  it('materializes a supplier command into a canonical cloud snapshot', async () => {
    const supplierId = '11111111-1111-4111-8111-111111111111';
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: supplierId,
            code: 'SUP-001',
            name: 'Daja Trade',
            taxNumber: '109876543',
            contactEmail: 'nabavka@example.test',
            active: true,
            version: '1'
          }
        ]
      });
    const projector = new OperationalSyncProjector({ query } as never);

    const result = await projector.materialize(
      {
        requestId: 'request-id',
        correlationId: 'correlation-id',
        organizationId: 'organization-id',
        userId: 'user-id',
        roles: [],
        permissions: ['sync.write']
      },
      {
        eventId: 'event-id',
        idempotencyKey: 'idempotency-key',
        aggregateType: 'supplier',
        aggregateId: supplierId,
        operation: 'command',
        payloadVersion: 1,
        payload: {
          command: {
            kind: 'supplier.upsert',
            payload: {
              code: 'sup-001',
              name: 'Daja Trade',
              taxNumber: '109876543',
              contactEmail: 'nabavka@example.test',
              active: true
            }
          }
        }
      }
    );

    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO suppliers');
    expect(result.payload.operationalSnapshot).toMatchObject({
      kind: 'supplier',
      supplier: { id: supplierId, code: 'SUP-001', name: 'Daja Trade' }
    });
  });

  it('materializes an RFID count header directly from its create command', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'location-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'count-id',
            locationId: 'location-id',
            warehouseId: null,
            zoneId: null,
            binId: null,
            name: 'RFID popis',
            status: 'draft',
            expectedTotal: 0,
            readTotal: 0,
            foundTotal: 0,
            missingTotal: 0,
            unexpectedTotal: 0,
            startedAt: null,
            completedAt: null,
            createdByUserId: 'user-id',
            ownerDeviceId: 'desktop-id',
            ownerState: 'owned',
            version: '1',
            createdAt: new Date('2026-08-28T10:00:00.000Z'),
            updatedAt: new Date('2026-08-28T10:00:00.000Z')
          }
        ]
      });
    const projector = new OperationalSyncProjector({ query } as never);

    const result = await projector.materialize(
      {
        requestId: 'request-id',
        correlationId: 'correlation-id',
        organizationId: 'organization-id',
        userId: 'user-id',
        deviceId: 'desktop-id',
        roles: [],
        permissions: ['rfid_counts.sync']
      },
      {
        eventId: 'event-id',
        idempotencyKey: 'idempotency-key',
        aggregateType: 'cycle_count',
        aggregateId: 'count-id',
        operation: 'command',
        payloadVersion: 1,
        payload: {
          command: {
            kind: 'count.create',
            payload: { locationId: 'location-id', actorUserId: 'user-id' }
          }
        }
      }
    );

    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO rfid_cycle_counts');
    expect(result.payload.operationalSnapshot).toMatchObject({
      kind: 'rfid.cycle_count',
      operation: 'create',
      count: { id: 'count-id', status: 'draft' }
    });
  });

  it('accepts the state snapshot that follows an already completed command', async () => {
    const query = vi.fn();
    const projector = new OperationalSyncProjector({ query } as never) as unknown as StateProjector;

    await expect(
      projector.applyRfidCycleCountState(
        { organizationId: 'organization-id', deviceId: 'desktop-id' },
        'count-id',
        { status: 'completed' },
        'complete',
        { ownerDeviceId: null, status: 'completed', version: '4' }
      )
    ).resolves.toBeUndefined();

    expect(query).not.toHaveBeenCalled();
  });
});
