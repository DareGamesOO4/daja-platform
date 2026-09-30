import type pg from 'pg';
type Client = Pick<pg.PoolClient, 'query'>;
export async function recordSupplierStatistics(
  client: Client,
  scope: string,
  provider: string,
  values: { outcome?: string; duration?: number; skipped?: number; disabled?: number }
) {
  const completed = values.outcome ? 1 : 0;
  await client.query(
    `INSERT INTO supplier_hourly_statistics(scope_id,provider_code,hour_at,completed,available,missing,out_of_stock,errors,duration_ms,max_duration_ms,skipped,disabled)
    VALUES($1,$2,date_trunc('hour',now()),$3,$4,$5,$6,$7,$8,$8,$9,$10)
    ON CONFLICT(scope_id,provider_code,hour_at) DO UPDATE SET
    completed=supplier_hourly_statistics.completed+EXCLUDED.completed,
    available=supplier_hourly_statistics.available+EXCLUDED.available,
    missing=supplier_hourly_statistics.missing+EXCLUDED.missing,
    out_of_stock=supplier_hourly_statistics.out_of_stock+EXCLUDED.out_of_stock,
    errors=supplier_hourly_statistics.errors+EXCLUDED.errors,
    duration_ms=supplier_hourly_statistics.duration_ms+EXCLUDED.duration_ms,
    max_duration_ms=GREATEST(supplier_hourly_statistics.max_duration_ms,EXCLUDED.max_duration_ms),
    skipped=supplier_hourly_statistics.skipped+EXCLUDED.skipped,
    disabled=supplier_hourly_statistics.disabled+EXCLUDED.disabled`,
    [
      scope,
      provider,
      completed,
      values.outcome === 'available' ? 1 : 0,
      values.outcome === 'missing' ? 1 : 0,
      values.outcome === 'out_of_stock' ? 1 : 0,
      values.outcome === 'error' ? 1 : 0,
      Math.max(0, Math.round(values.duration || 0)),
      values.skipped || 0,
      values.disabled || 0
    ]
  );
}
