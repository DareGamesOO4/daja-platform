import type { Database } from '@daja/database';
import type { RequestContext } from '@daja/shared';
import { TenantAccessDeniedError, ValidationFailedError } from '@daja/security';
import { z } from 'zod';

export type SessionStatus = 'open' | 'completed' | 'abandoned';
interface SessionRow {
  organization_id: string; user_id: string; product_id: string | null; kind: string;
  status: SessionStatus; complete: boolean; active_seconds: number; started_at: Date;
}
interface ClientRow { sequence: string; active_seconds: number; updated_at: Date }
interface LeaseRow { owner_id: string; expires_at: Date }
export interface TimingRow {
  id: string; productId: string | null; productName: string; kind: string; status: SessionStatus;
  complete: boolean; startedAt: Date; finishedAt: Date | null; activeSeconds: number;
  elapsedSeconds: string | null; editSessions: number;
}
export interface TeamRow {
  id: string; name: string; count: number; approved: number; returned: number;
  activeSeconds: number | null; elapsedSeconds: string | null; measured: number;
}

export const workSessionSchema = z.object({
  actorUserId: z.string().uuid(), organizationId: z.string().uuid(),
  ownerId: z.string().uuid(), sequence: z.number().int().positive(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  productId: z.string().uuid().optional(), kind: z.enum(['create', 'edit', 'review']),
  activeSeconds: z.number().min(0).max(100_000_000), eligible: z.boolean(),
  complete: z.boolean(), status: z.enum(['open', 'completed', 'abandoned'])
}).refine(input => input.status !== 'completed' || Boolean(input.productId && input.finishedAt));
export const dashboardQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
  startHour: z.coerce.number().int().min(0).max(12).default(0),
  hours: z.coerce.number().int().refine(value => value === 12 || value === 24).default(24)
}).refine(input => input.startHour + input.hours <= 24);

export async function recordWorkSession(db: Database['pool'], ctx: RequestContext, id: string, input: z.infer<typeof workSessionSchema>) {
  if (input.actorUserId !== ctx.userId || input.organizationId !== ctx.organizationId) throw new TenantAccessDeniedError();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // One lease per worker prevents overlapping tabs from counting the same time twice.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`work-time:${ctx.organizationId}:${ctx.userId}`]);
    const now = Date.now();
    const start = new Date(input.startedAt).getTime();
    const finish = input.finishedAt ? new Date(input.finishedAt).getTime() : null;
    if (start > now + 60_000 || (finish !== null && (finish < start || finish > now + 60_000))) {
      throw new ValidationFailedError('Invalid session timestamps');
    }
    if (input.productId) {
      const product = (await client.query<{ created_by_user_id: string | null }>(`SELECT created_by_user_id FROM products WHERE organization_id=$1 AND id=$2`, [ctx.organizationId, input.productId])).rows[0];
      if (!product || (input.kind === 'create' && product.created_by_user_id !== ctx.userId)) throw new TenantAccessDeniedError();
    }
    await client.query(`INSERT INTO catalog_work_sessions(id,organization_id,user_id,product_id,kind,started_at,complete)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [id, ctx.organizationId, ctx.userId, input.productId ?? null, input.kind, input.startedAt, input.complete]);
    const session = (await client.query<SessionRow>(`SELECT * FROM catalog_work_sessions WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!session || session.organization_id !== ctx.organizationId || session.user_id !== ctx.userId || session.kind !== input.kind ||
      (session.product_id && input.productId && session.product_id !== input.productId)) throw new TenantAccessDeniedError();
    if (session.status !== 'open') {
      await client.query('COMMIT');
      return { status: session.status, complete: session.complete, activeSeconds: Number(session.active_seconds) };
    }
    const previous = (await client.query<ClientRow>(`SELECT * FROM catalog_work_session_clients WHERE session_id=$1 AND owner_id=$2`, [id, input.ownerId])).rows[0];
    if (previous && Number(previous.sequence) >= input.sequence) {
      await client.query('COMMIT');
      return { status: session.status, complete: session.complete, activeSeconds: Number(session.active_seconds) };
    }
    const lease = (await client.query<LeaseRow>(`SELECT * FROM catalog_work_leases WHERE organization_id=$1 AND user_id=$2`, [ctx.organizationId, ctx.userId])).rows[0];
    const lastClient = !previous ? (await client.query<{released: boolean; updated_at: Date}>(
      `SELECT released,updated_at FROM catalog_work_session_clients WHERE session_id=$1 ORDER BY updated_at DESC LIMIT 1`, [id])).rows[0] : undefined;
    const interrupted = lastClient && !lastClient.released && now - new Date(lastClient.updated_at).getTime() > 40_000;
    const canCount = !lease || lease.owner_id === input.ownerId || new Date(lease.expires_at).getTime() <= now;
    const requested = Math.max(0, input.activeSeconds - Number(previous?.active_seconds ?? 0));
    if (previous && input.activeSeconds < Number(previous.active_seconds)) throw new ValidationFailedError('Active time must be cumulative');
    const elapsed = previous ? Math.max(0, (now - new Date(previous.updated_at).getTime()) / 1000) : Math.max(0, (now - start) / 1000);
    const accepted = canCount ? Math.min(requested, elapsed + 1, 35) : 0;
    // A delayed/lost heartbeat cannot be reconstructed as trustworthy active time.
    const complete = input.complete && !interrupted && requested <= Math.min(elapsed + 1, 35) + 1 && (canCount || requested < .01);
    if (canCount) {
      await client.query(`INSERT INTO catalog_work_leases(organization_id,user_id,owner_id,expires_at)
        VALUES($1,$2,$3,now() + interval '40 seconds') ON CONFLICT(organization_id,user_id)
        DO UPDATE SET owner_id=EXCLUDED.owner_id, expires_at=CASE WHEN $4 THEN now() + interval '40 seconds' ELSE now() END`,
        [ctx.organizationId, ctx.userId, input.ownerId, input.eligible && input.status === 'open']);
      if (!input.eligible || input.status !== 'open') await client.query(`UPDATE catalog_work_leases SET expires_at=now() WHERE organization_id=$1 AND user_id=$2 AND owner_id=$3`, [ctx.organizationId, ctx.userId, input.ownerId]);
    }
    await client.query(`INSERT INTO catalog_work_session_clients(session_id,owner_id,sequence,active_seconds,released)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id,owner_id) DO UPDATE SET sequence=EXCLUDED.sequence,
      active_seconds=EXCLUDED.active_seconds,released=EXCLUDED.released,updated_at=now()`, [id, input.ownerId, input.sequence, input.activeSeconds, !input.eligible]);
    const result = (await client.query<{status: SessionStatus; complete: boolean; activeSeconds: number}>(`UPDATE catalog_work_sessions SET active_seconds=active_seconds+$2,
      complete=complete AND $3, status=$4, finished_at=$5, product_id=COALESCE(product_id,$6),updated_at=now()
      WHERE id=$1 RETURNING status,complete,active_seconds AS "activeSeconds"`,
      [id, accepted, complete, input.status, input.finishedAt ?? null, input.productId ?? null])).rows[0];
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function workforceDashboard(db: Database['pool'], organizationId: string, userId: string, input: z.infer<typeof dashboardQuerySchema>) {
  const values = [organizationId, userId, input.date, input.startHour, input.hours];
  const daily = (await db.query<{date: string; count: number; periodCount: number}>(`SELECT to_char(g.day,'YYYY-MM-DD') AS date,count(p.id)::int AS count,
      count(p.id) FILTER(WHERE extract(hour FROM p.created_at AT TIME ZONE 'Europe/Belgrade') >= $4::int
        AND extract(hour FROM p.created_at AT TIME ZONE 'Europe/Belgrade') < $4::int+$5::int)::int AS "periodCount"
    FROM generate_series(($3::date-89)::timestamp,$3::date::timestamp,interval '1 day') g(day)
    LEFT JOIN products p ON p.organization_id=$1 AND p.created_by_user_id=$2
      AND (p.created_at AT TIME ZONE 'Europe/Belgrade')::date=g.day::date
    GROUP BY g.day ORDER BY g.day`, values)).rows;
  const timings = (await db.query<TimingRow>(`SELECT s.id,s.product_id AS "productId",COALESCE(p.name,'Nesačuvan unos') AS "productName",
      s.kind,s.status,s.complete,s.started_at AS "startedAt",s.finished_at AS "finishedAt",s.active_seconds AS "activeSeconds",
      extract(epoch FROM(COALESCE(s.finished_at,now())-s.started_at)) AS "elapsedSeconds",
      (SELECT count(*)::int FROM catalog_work_sessions e WHERE e.organization_id=$1 AND e.user_id=$2
        AND e.product_id=s.product_id AND e.kind='edit' AND e.status='completed') AS "editSessions"
    FROM catalog_work_sessions s LEFT JOIN products p ON p.id=s.product_id AND p.organization_id=$1
    WHERE s.organization_id=$1 AND s.user_id=$2
      AND (COALESCE(s.finished_at,s.started_at) AT TIME ZONE 'Europe/Belgrade')::date=$3::date
    ORDER BY COALESCE(s.finished_at,s.started_at),s.id`, values.slice(0,3))).rows;
  const team = (await db.query<TeamRow>(`WITH bounds AS (
      SELECT $2::uuid AS selected_user, ($3::date::timestamp + make_interval(hours=>$4::int)) AT TIME ZONE 'Europe/Belgrade' AS start,
        ($3::date::timestamp + make_interval(hours=>($4::int+$5::int))) AT TIME ZONE 'Europe/Belgrade' AS finish
    )
    SELECT u.id,COALESCE(u.display_name,u.email) AS name,
      (SELECT count(*)::int FROM products p CROSS JOIN bounds b WHERE p.organization_id=$1 AND p.created_by_user_id=u.id
        AND p.created_at>=b.start AND p.created_at<b.finish) AS count,
      (SELECT count(*)::int FROM products p CROSS JOIN bounds b WHERE p.organization_id=$1 AND p.created_by_user_id=u.id
        AND p.created_at>=b.start AND p.created_at<b.finish AND p.deleted_at IS NULL AND p.quality_review_status='approved') AS approved,
      (SELECT count(*)::int FROM products p CROSS JOIN bounds b WHERE p.organization_id=$1 AND p.created_by_user_id=u.id
        AND p.created_at>=b.start AND p.created_at<b.finish AND p.deleted_at IS NULL AND p.quality_review_status='changes_requested') AS returned,
      (SELECT avg(s.active_seconds) FROM catalog_work_sessions s CROSS JOIN bounds b WHERE s.organization_id=$1 AND s.user_id=u.id
        AND s.kind='create' AND s.status='completed' AND s.complete AND s.finished_at>=b.start AND s.finished_at<b.finish) AS "activeSeconds",
      (SELECT avg(extract(epoch FROM(s.finished_at-s.started_at))) FROM catalog_work_sessions s CROSS JOIN bounds b WHERE s.organization_id=$1 AND s.user_id=u.id
        AND s.kind='create' AND s.status='completed' AND s.complete AND s.finished_at>=b.start AND s.finished_at<b.finish) AS "elapsedSeconds",
      (SELECT count(*)::int FROM catalog_work_sessions s CROSS JOIN bounds b WHERE s.organization_id=$1 AND s.user_id=u.id
        AND s.kind='create' AND s.status='completed' AND s.complete AND s.finished_at>=b.start AND s.finished_at<b.finish) AS measured
    FROM users u WHERE u.organization_id=$1 AND EXISTS(SELECT 1 FROM products p WHERE p.organization_id=$1 AND p.created_by_user_id=u.id)
    ORDER BY count DESC,name`, values)).rows;
  return { daily, timings, team };
}
