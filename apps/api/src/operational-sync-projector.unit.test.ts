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
