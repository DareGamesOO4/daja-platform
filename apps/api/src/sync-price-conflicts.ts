import type pg from 'pg';
import type { SyncPushEvent } from '@daja/database';
import type { RequestContext } from '@daja/shared';
import { ValidationFailedError } from '@daja/security';

type Query = Pick<pg.PoolClient, 'query'>;
export type PriceField = 'regular' | 'promotion';
export type PriceValue = { amount: number; currency: string; from?: string | null; until?: string | null } | null;
export type PriceChoices = Partial<Record<PriceField, 'local' | 'remote' | undefined>>;
export const priceFields = ['regular', 'promotion'] as const;
type PriceVersion = { value: PriceValue; savedAt: string | null; deviceId: string | null; actorName: string | null; deviceName: string | null };
export type PriceState = {
  variantId: string;
  productId: string;
  version: number;
  name: string;
  sku: string | null;
  regular: PriceVersion;
  promotion: PriceVersion;
};

export type PricePlan = {
  preserve: ReadonlySet<PriceField>;
  savedAt?: string;
  replacePromotion?: boolean;
  promotion?: NonNullable<PriceValue>;
};

export type PriceComparison = {
  field: PriceField;
  before: PriceValue;
  local: PriceValue;
  remote: PriceValue;
  remoteSavedAt: string | null;
  remoteActorName: string | null;
  remoteDeviceName: string | null;
};

export function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

export function samePrice(left: PriceValue, right: PriceValue): boolean {
  return left === right || (left !== null && right !== null &&
    left.amount === right.amount && left.currency === right.currency &&
    (left.from ?? null) === (right.from ?? null) && (left.until ?? null) === (right.until ?? null));
}

function price(value: unknown): PriceValue {
  if (value === null) return null;
  const entry = object(value);
  if (typeof entry.amount !== 'number' || !Number.isSafeInteger(entry.amount) ||
      entry.amount < 0 || entry.amount > 2147483600 || typeof entry.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(entry.currency)) {
    throw new ValidationFailedError('Iznos ili valuta cene nisu ispravni.');
  }
  return {
    amount: entry.amount, currency: entry.currency,
    ...(Object.hasOwn(entry, 'from') ? { from: date(entry.from) } : {}),
    ...(Object.hasOwn(entry, 'until') ? { until: date(entry.until) } : {})
  };
}

export function preserveUneditedItemFields(input: Record<string, unknown>, baseline: unknown, state: PriceState) {
  const previous = object(baseline);
  const adjusted = { ...input };
  if (typeof previous.name === 'string' && input.name === previous.name) adjusted.name = state.name;
  for (const key of ['sku', 'description', 'slug', 'variantName']) {
    if (Object.hasOwn(previous, key) && Object.hasOwn(input, key) &&
        String(input[key] ?? '').trim() === String(previous[key] ?? '').trim()) {
      delete adjusted[key];
    }
  }
  if (!Object.hasOwn(adjusted, 'variantName') && typeof previous.variantName === 'string') {
    const attrs = object(adjusted.attributes);
    if (attrs._variantName === previous.variantName) {
      const { _variantName: ignored, ...rest } = attrs;
      void ignored;
      adjusted.attributes = rest;
    }
  }
  return adjusted;
}

export async function readPriceState(
  client: Query, organizationId: string, variantId: string, lock = false
): Promise<PriceState | undefined> {
  // Use a separate statement after acquiring the lock so concurrent sale edits
  // committed while waiting are visible to the subsequent query.
  if (lock) {
    await client.query(
      `SELECT p.id FROM products p JOIN product_variants v ON v.organization_id=p.organization_id AND v.product_id=p.id
       WHERE v.organization_id=$1 AND v.id=$2 FOR UPDATE OF p`, [organizationId, variantId]
    );
    await client.query('SELECT id FROM product_variants WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, variantId]);
  }
  const { rows: [row] } = await client.query<{
    product_id: string; version: string; name: string; sku: string | null;
    amount: number; currency: string; sale_amount: number | null; sale_currency: string | null;
    starts: Date | null; ends: Date | null; regular_at: Date | null; promotion_at: Date | null;
    regular_device: string | null; promotion_device: string | null;
    regular_actor: string | null; promotion_actor: string | null;
    regular_device_name: string | null; promotion_device_name: string | null;
  }>(
    `SELECT v.product_id, v.version::text, p.name, v.sku, v.current_price_amount AS amount, v.currency,
            sale.amount_minor AS sale_amount, sale.currency AS sale_currency, sale.valid_from AS starts,
            sale.valid_until AS ends, regular.saved_at AS regular_at, regular.device_id AS regular_device,
            promotion.saved_at AS promotion_at, promotion.device_id AS promotion_device,
            regular_actor.display_name AS regular_actor, promo_actor.display_name AS promotion_actor,
            regular_device.display_name AS regular_device_name, promo_device.display_name AS promotion_device_name
     FROM product_variants v JOIN products p ON p.organization_id=v.organization_id AND p.id=v.product_id
     LEFT JOIN variant_price_edit_clocks regular ON regular.organization_id=v.organization_id AND regular.variant_id=v.id AND regular.kind='regular'
     LEFT JOIN variant_price_edit_clocks promotion ON promotion.organization_id=v.organization_id AND promotion.variant_id=v.id AND promotion.kind='promotion'
     LEFT JOIN users regular_actor ON regular_actor.id=regular.user_id AND regular_actor.organization_id=v.organization_id
     LEFT JOIN users promo_actor ON promo_actor.id=promotion.user_id AND promo_actor.organization_id=v.organization_id
     LEFT JOIN devices regular_device ON regular_device.id=regular.device_id AND regular_device.organization_id=v.organization_id
     LEFT JOIN devices promo_device ON promo_device.id=promotion.device_id AND promo_device.organization_id=v.organization_id
     LEFT JOIN LATERAL (
       SELECT amount_minor, currency, valid_from, valid_until FROM variant_prices
       WHERE organization_id=v.organization_id AND variant_id=v.id AND price_type='sale' AND cancelled_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1
     ) sale ON true
     WHERE v.organization_id=$1 AND v.id=$2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [organizationId, variantId]
  );
  if (!row) return undefined;
  return {
    variantId, productId: row.product_id, version: Number(row.version), name: row.name, sku: row.sku,
    regular: { value: { amount: row.amount, currency: row.currency }, savedAt: date(row.regular_at), deviceId: row.regular_device,
      actorName: row.regular_actor, deviceName: row.regular_device_name },
    promotion: {
      value: row.sale_amount === null ? null : {
        amount: row.sale_amount, currency: row.sale_currency ?? row.currency, from: date(row.starts), until: date(row.ends)
      },
      savedAt: date(row.promotion_at), deviceId: row.promotion_device,
      actorName: row.promotion_actor, deviceName: row.promotion_device_name
    }
  };
}

export function hasPriceBaseline(event: SyncPushEvent): boolean {
  return object(event.basePayload?.priceEdit).version === 1;
}

export async function preparePriceEdit(client: Query, ctx: RequestContext, event: SyncPushEvent) {
  const command = object(event.payload.command);
  const input = object(command.payload);
  if (!hasPriceBaseline(event) || event.aggregateType !== 'product_variant' ||
      !['item.update', 'item.promotion.clear'].includes(String(command.kind))) return undefined;
  const variantId = command.kind === 'item.update' ? input.id : input.productVariantId;
  if (variantId !== event.aggregateId) throw new ValidationFailedError('Šifra izmene ne odgovara artiklu.');
  const state = await readPriceState(client, ctx.organizationId, event.aggregateId, true);
  if (!state) throw new ValidationFailedError('Artikal više nije dostupan na serveru.');
  const base = object(event.basePayload?.priceEdit);
  const regular = price(base.regular);
  const promotion = price(base.promotion);
  const currency = typeof input.currency === 'string' ? input.currency : regular?.currency ?? 'RSD';
  const proposed: Record<PriceField, PriceValue> = {
    regular: command.kind === 'item.update'
      ? price({ amount: Number(input.salePriceMinor) * 100, currency }) : regular,
    promotion: typeof input.promotionalPriceMinor === 'number'
      ? price({ amount: input.promotionalPriceMinor * 100,
          currency: currency === regular?.currency ? promotion?.currency ?? currency : currency,
          from: input.promotionalValidFrom ?? promotion?.from, until: input.promotionalValidUntil ?? promotion?.until })
      : input.clearPromotion === true || input.promotionalPriceMinor === null || command.kind === 'item.promotion.clear'
        ? null : promotion
  };
  // Desktop displays whole currency units. Keep the precise server amount
  // behind an unchanged form field until the user actually edits it.
  if (regular && proposed.regular?.currency === regular.currency && proposed.regular.amount === Math.floor(regular.amount / 100) * 100)
    proposed.regular = regular;
  if (promotion && proposed.promotion?.currency === promotion.currency &&
      proposed.promotion.amount === Math.floor(promotion.amount / 100) * 100)
    proposed.promotion = { ...proposed.promotion, amount: promotion.amount };

  const preserve = new Set<PriceField>();
  const disputes: PriceComparison[] = [];
  const savedAt = date(event.clientTimestamp);
  for (const field of priceFields) {
    const before = field === 'regular' ? regular : promotion;
    const remote = state[field];
    const local = proposed[field];
    if (samePrice(local, before) || samePrice(local, remote.value)) {
      preserve.add(field);
      continue;
    }
    if (!savedAt || Date.parse(savedAt) > Date.now() + 5_000)
      throw new ValidationFailedError('Vreme čuvanja cene nije pouzdano. Proveri datum i vreme računara, pa ponovo sačuvaj artikal.');
    const clockKey = field === 'regular' ? 'regularSavedAt' : 'promotionSavedAt';
    const changedSinceBaseline = Object.hasOwn(base, clockKey) && remote.savedAt !== null &&
      remote.savedAt !== date(base[clockKey]);
    if (samePrice(before, remote.value) && !changedSinceBaseline) continue;
    if (!remote.savedAt)
      throw new ValidationFailedError('Server nema vreme prethodne promene cene. Otvori artikal i proveri aktuelnu cenu pre ponovnog čuvanja.');
    const difference = Date.parse(savedAt) - Date.parse(remote.savedAt);
    if (remote.deviceId !== ctx.deviceId && Math.abs(difference) <= 60_000) {
      disputes.push({ field, before, local, remote: remote.value, remoteSavedAt: remote.savedAt,
        remoteActorName: remote.actorName, remoteDeviceName: remote.deviceName });
    } else if (difference < 0) {
      preserve.add(field);
    }
  }
  const adjusted = preserveUneditedItemFields(input, base, state);
  return {
    state, savedAt, proposed, disputes,
    event: { ...event, payload: { ...event.payload, command: { ...command, payload: adjusted } } },
    plan: { preserve, ...(savedAt ? { savedAt } : {}), replacePromotion: true,
      ...(proposed.promotion ? { promotion: proposed.promotion } : {}) } satisfies PricePlan
  };
}
