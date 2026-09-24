import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Database } from '@daja/database';
import { requirePermission } from '@daja/security';
import { DATABASE } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';

function reportDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Datum izveštaja mora biti u formatu YYYY-MM-DD.');
  return value;
}

@Controller('reports/internal-sales')
export class InternalSalesReportController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get()
  async report(@Req() request: Request, @Query('from') fromValue?: string, @Query('to') toValue?: string, @Query('locationId') locationId?: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    const today = new Date().toISOString().slice(0, 10);
    const from = reportDate(fromValue, today);
    const to = reportDate(toValue, today);
    const filter = locationId ? ' AND sale.location_id = $4' : '';
    const params = locationId ? [ctx.organizationId, from, to, locationId] : [ctx.organizationId, from, to];
    const [summary, goods, services, payments, cheques, sellers, returns] = await Promise.all([
      this.database.pool.query(
        `SELECT count(*)::int AS "saleCount", COALESCE(sum(sale.total_minor), 0)::int AS "grossMinor",
                COALESCE(sum(sale.cash_paid_minor), 0)::int AS "cashMinor", COALESCE(sum(sale.card_paid_minor), 0)::int AS "cardMinor"
         FROM internal_sales sale WHERE sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}`,
        params
      ),
      this.database.pool.query(
        `SELECT line.product_variant_id AS "variantId", COALESCE(variant.name, line.product_variant_id::text) AS name,
                sum(line.quantity)::int AS quantity, sum(line.quantity * line.unit_price_minor)::int AS "revenueMinor"
         FROM internal_sale_lines line JOIN internal_sales sale ON sale.id = line.sale_id
         LEFT JOIN product_variants variant ON variant.id = line.product_variant_id
         WHERE sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}
         GROUP BY line.product_variant_id, variant.name ORDER BY "revenueMinor" DESC`,
        params
      ),
      this.database.pool.query(
        `SELECT line.service_id AS "serviceId", line.service_name AS name, sum(line.quantity)::int AS quantity,
                sum(line.quantity * line.unit_price_minor)::int AS "revenueMinor"
         FROM internal_sale_service_lines line JOIN internal_sales sale ON sale.id = line.sale_id
         WHERE sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}
         GROUP BY line.service_id, line.service_name ORDER BY "revenueMinor" DESC`,
        params
      ),
      this.database.pool.query(
        `SELECT part.method, sum(part.amount_minor)::int AS "amountMinor"
         FROM internal_sale_payment_parts part JOIN internal_sales sale ON sale.id = part.sale_id
         WHERE sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}
         GROUP BY part.method ORDER BY part.method`,
        params
      ),
      this.database.pool.query(
        `SELECT COALESCE(sum(part.cheque_count), 0)::int AS count, COALESCE(sum(part.amount_minor), 0)::int AS "amountMinor"
         FROM internal_sale_payment_parts part JOIN internal_sales sale ON sale.id = part.sale_id
         WHERE part.method = 'cheque' AND sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}`,
        params
      ),
      this.database.pool.query(
        `SELECT COALESCE(sale.seller_name, 'Nije izabran') AS "sellerName", count(*)::int AS "saleCount", COALESCE(sum(sale.total_minor), 0)::int AS "revenueMinor"
         FROM internal_sales sale WHERE sale.organization_id = $1 AND sale.created_at >= $2::date AND sale.created_at < ($3::date + interval '1 day')${filter}
         GROUP BY sale.seller_name ORDER BY "revenueMinor" DESC`,
        params
      ),
      this.database.pool.query(
        `SELECT count(*)::int AS count
         FROM internal_sale_returns returned JOIN internal_sales sale ON sale.id = returned.sale_id
         WHERE returned.organization_id = $1 AND returned.created_at >= $2::date AND returned.created_at < ($3::date + interval '1 day')${locationId ? ' AND returned.location_id = $4' : ''}`,
        params
      )
    ]);
    return { range: { from, to, locationId: locationId ?? null }, summary: summary.rows[0], goods: goods.rows, services: services.rows, payments: payments.rows, cheques: cheques.rows[0], sellers: sellers.rows, returns: returns.rows[0] };
  }
}
