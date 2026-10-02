import type { Database } from '@daja/database';
import type { RequestContext } from '@daja/shared';
import { ResourceConflictError, ResourceNotFoundError, ValidationFailedError } from '@daja/security';
import { z } from 'zod';

type Client = Pick<Database['pool'], 'query'>;
export interface GroupProduct {
  id: string; name: string; slug: string; brand: string | null; department: string | null;
  image: string | null; public: boolean;
}
export interface GroupRecord {
  id: string; kind: 'automatic' | 'custom'; source_prefix: string | null;
  internal_name: string | null; follow_auto: boolean; customized: boolean;
  created_by_user_id: string | null;
}
export interface ProductPolicy {
  product_id: string; group_id: string | null; origin_group_id: string | null;
  kind: 'manual' | 'snapshot' | 'detached';
}
export interface GroupState {
  products: GroupProduct[]; groups: GroupRecord[]; policies: ProductPolicy[]; revision: number; catalogRevision: string;
}
export interface VariantGroup {
  key: string; id: string | null; kind: 'automatic' | 'custom'; prefix: string | null;
  internalName: string | null; name: string; followAuto: boolean; customized: boolean;
  createdBy: string | null; revision: number; catalogRevision: string; memberIds: string[]; automaticMemberIds: string[];
  manualMemberIds: string[]; excludedIds: string[];
}
export interface GroupOverview {
  groups: VariantGroup[]; products: GroupProduct[]; ungroupedIds: string[];
  assignments: Record<string, string>; revision: number; catalogRevision: string;
}
export const groupSaveSchema = z.object({
  key: z.string().max(500).nullable(),
  expectedRevision: z.number().int().nonnegative(),
  expectedCatalogRevision: z.string().length(32),
  internalName: z.string().trim().max(240).nullable(),
  followAuto: z.boolean(), editMembers: z.boolean(), memberIds: z.array(z.string().uuid()).max(10000),
  removedIds: z.array(z.string().uuid()).max(10000)
}).strict();
export const groupRevisionSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedCatalogRevision: z.string().length(32) }).strict();

function prefix(name: string): string | null {
  const parts = name.split('-');
  return parts.length < 2 ? null : parts.slice(0, -1).join('-');
}
function key(group: GroupRecord): string {
  return group.kind === 'automatic' ? `auto:${group.source_prefix!}` : group.id;
}

export async function loadGroupState(db: Client, organizationId: string, includeImages = true): Promise<GroupState> {
  // A single statement keeps products, assignments and revision in one MVCC snapshot.
  const result = await db.query<GroupState>(`SELECT
    COALESCE((SELECT jsonb_agg(entry) FROM (
      SELECT p.id, p.name, p.slug, b.name AS brand, d.name AS department,
        CASE WHEN $2::boolean THEN (SELECT ma.public_url FROM product_media pm JOIN media_assets ma ON ma.id=pm.media_asset_id AND ma.status='ready'
         WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id
         ORDER BY pm.is_primary DESC, pm.position, pm.id LIMIT 1) ELSE NULL END AS image,
        (p.active AND p.published AND EXISTS (SELECT 1 FROM product_variants v
          WHERE v.organization_id=p.organization_id AND v.product_id=p.id AND v.active AND v.published AND v.deleted_at IS NULL)) AS public
      FROM products p LEFT JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id
      LEFT JOIN departments d ON d.id=p.department_id AND d.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.deleted_at IS NULL ORDER BY p.name, p.id
    ) entry), '[]'::jsonb) AS products,
    COALESCE((SELECT jsonb_agg(g) FROM catalog_variant_groups g WHERE g.organization_id=$1), '[]'::jsonb) AS groups,
    COALESCE((SELECT jsonb_agg(m) FROM catalog_variant_group_products m WHERE m.organization_id=$1), '[]'::jsonb) AS policies,
    COALESCE((SELECT revision FROM catalog_variant_group_versions WHERE organization_id=$1),0) AS revision,
    (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(p.id,p.name) ORDER BY p.id)::text,'[]'))
     FROM products p WHERE p.organization_id=$1 AND p.deleted_at IS NULL) AS "catalogRevision"`, [organizationId,includeImages]);
  return result.rows[0]!;
}

function ownership(state: GroupState) {
  const policies = new Map(state.policies.map(p => [p.product_id, p]));
  const configured = state.groups.filter(g => g.kind === 'automatic' && g.customized)
    .sort((a,b) => b.source_prefix!.length - a.source_prefix!.length);
  const owners = new Map<string, string | null>();
  for (const product of state.products) {
    const policy = policies.get(product.id);
    if (policy) { owners.set(product.id, policy.group_id); continue; }
    const group = configured.find(g => product.name.startsWith(g.source_prefix!));
    if (group) owners.set(product.id, group.follow_auto ? group.id : null);
  }
  return { policies, owners };
}

export function groupOverview(state: GroupState): GroupOverview {
  const { owners, policies } = ownership(state);
  const records = new Map(state.groups.map(g => [key(g), g]));
  for (const product of state.products) {
    const base = prefix(product.name);
    if (base !== null && !records.has(`auto:${base}`)) records.set(`auto:${base}`, {
      id: '', kind: 'automatic', source_prefix: base, internal_name: null,
      follow_auto: true, customized: false, created_by_user_id: null
    });
  }
  const groups: VariantGroup[] = [];
  for (const [groupKey, record] of records) {
    const memberIds = state.products.filter(p => {
      if (owners.has(p.id)) return Boolean(record.id) && owners.get(p.id) === record.id;
      return record.kind === 'automatic' && !record.customized && p.name.startsWith(record.source_prefix!);
    }).map(p => p.id);
    const automaticMemberIds = record.kind === 'automatic' ? state.products.filter(p => {
      const policy = policies.get(p.id);
      const longerRule = state.groups.some(g => g.kind === 'automatic' && g.customized && g.id !== record.id &&
        g.source_prefix!.length > record.source_prefix!.length && p.name.startsWith(g.source_prefix!));
      return p.name.startsWith(record.source_prefix!) && (!policy || policy.group_id === record.id) &&
        (policy?.group_id === record.id && policy.kind === 'manual' || !longerRule);
    }).map(p => p.id) : [];
    const first = state.products.find(p => memberIds.includes(p.id));
    groups.push({ key: groupKey, id: record.id || null, kind: record.kind, prefix: record.source_prefix,
      internalName: record.internal_name, name: record.internal_name || (record.kind === 'automatic' ? record.source_prefix! : first ? `Grupa — ${first.name}` : 'Nova grupa'),
      followAuto: record.follow_auto, customized: record.customized, createdBy: record.created_by_user_id,
      revision: state.revision, catalogRevision: state.catalogRevision, memberIds, automaticMemberIds,
      manualMemberIds: state.policies.filter(p => p.group_id === record.id && p.kind === 'manual').map(p => p.product_id),
      excludedIds: state.policies.filter(p => p.origin_group_id === record.id && p.kind === 'detached').map(p => p.product_id)
    });
  }
  const assignments: Record<string,string> = {};
  for (const p of state.products) {
    if (owners.has(p.id)) {
      const owner = state.groups.find(g => g.id === owners.get(p.id));
      if (owner) assignments[p.id] = key(owner);
    } else {
      const base = prefix(p.name);
      if (base !== null) assignments[p.id] = `auto:${base}`;
    }
  }
  return { groups: groups.sort((a,b) => a.name.localeCompare(b.name)), products: state.products,
    assignments, ungroupedIds: state.products.filter(p => !assignments[p.id]).map(p => p.id), revision: state.revision, catalogRevision: state.catalogRevision };
}

export function resolveGroupMembers(state: GroupState, productId: string): string[] {
  const product = state.products.find(p => p.id === productId);
  if (!product) return [];
  const { owners } = ownership(state);
  if (owners.has(productId)) {
    const owner = owners.get(productId);
    return owner ? state.products.filter(p => owners.get(p.id) === owner).map(p => p.id) : [productId];
  }
  const base = prefix(product.name);
  if (base === null) return [productId];
  return state.products.filter(p => p.name.startsWith(base) && !owners.has(p.id)).map(p => p.id);
}

export async function mutateGroups(db: Database['pool'], ctx: RequestContext,
  action: 'save' | 'reset' | 'delete' | 'product-reset', input: z.infer<typeof groupSaveSchema> | ({key: string} & z.infer<typeof groupRevisionSchema>)
): Promise<GroupOverview> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`variant-groups:${ctx.organizationId}`]);
    const state = await loadGroupState(client, ctx.organizationId);
    if (state.revision !== input.expectedRevision) throw new ResourceConflictError('Grupe su u međuvremenu promenjene. Osveži podatke i ponovi izmenu.');
    if (state.catalogRevision !== input.expectedCatalogRevision) throw new ResourceConflictError('Katalog je u međuvremenu promenjen. Osveži podatke i ponovi izmenu.');
    const overview = groupOverview(state);
    let group = state.groups.find(g => key(g) === input.key);
    if (action === 'product-reset') {
      const id = z.string().uuid().parse(input.key);
      if (!state.products.some(p => p.id === id)) throw new ResourceNotFoundError('Product');
      await client.query('DELETE FROM catalog_variant_group_products WHERE organization_id=$1 AND product_id=$2', [ctx.organizationId,id]);
    } else if (action === 'save') {
      const save = groupSaveSchema.parse(input);
      const ids = [...new Set(save.memberIds)];
      if (save.editMembers && ids.some(id => !state.products.some(p => p.id === id))) throw new ValidationFailedError('Proizvod je obrisan ili ne pripada organizaciji.');
      const before = overview.groups.find(g => g.key === save.key);
      if (save.key !== null && !before) throw new ResourceNotFoundError('Variant group');
      if (!before && !save.editMembers) throw new ValidationFailedError('Nova grupa zahteva izbor članstva.');
      if (!group) {
        const automatic = before?.kind === 'automatic';
        const created = await client.query<GroupRecord>(`INSERT INTO catalog_variant_groups
          (organization_id,kind,source_prefix,follow_auto,created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [ctx.organizationId,automatic ? 'automatic' : 'custom',automatic ? before!.prefix : null,automatic,ctx.userId]);
        group = created.rows[0]!;
      }
      // Naming is a metadata operation, even when the live catalog changed since opening the editor.
      const customize = group.customized || save.editMembers;
      const follow = group.kind === 'automatic' && (save.editMembers ? save.followAuto : group.follow_auto);
      if (save.editMembers) {
        // Include natural candidates on a live rule so omitted candidates remain excluded.
        const removed = new Set([...(before?.memberIds || []), ...(follow ? before?.automaticMemberIds || [] : [])].filter(id => !ids.includes(id)));
        for (const id of removed) {
          const policy = state.policies.find(p => p.product_id === id);
          if (policy?.group_id && policy.group_id !== group.id) continue;
          if (follow && policy?.kind === 'snapshot' && !save.removedIds.includes(id)) {
            // Unfreezing releases historical snapshots, including renamed products.
            await client.query('DELETE FROM catalog_variant_group_products WHERE organization_id=$1 AND product_id=$2 AND group_id=$3', [ctx.organizationId,id,group.id]);
            continue;
          }
          await client.query(`INSERT INTO catalog_variant_group_products (organization_id,product_id,kind,origin_group_id)
            VALUES ($1,$2,'detached',$3) ON CONFLICT (organization_id,product_id) DO UPDATE
            SET group_id=NULL,kind='detached',origin_group_id=EXCLUDED.origin_group_id`, [ctx.organizationId,id,group.id]);
        }
        for (const id of ids) {
          const product = state.products.find(p => p.id === id)!;
          const policy = state.policies.find(p => p.product_id === id);
          const belongsElsewhere = !before?.memberIds.includes(id) && Boolean(overview.assignments[id] && overview.assignments[id] !== key(group));
          const manual = group.kind === 'custom' || !product.name.startsWith(group.source_prefix!) ||
            policy?.kind === 'manual' || belongsElsewhere || policy?.kind === 'detached';
          if (follow && !manual) {
            await client.query('DELETE FROM catalog_variant_group_products WHERE organization_id=$1 AND product_id=$2 AND group_id=$3', [ctx.organizationId,id,group.id]);
          } else {
            await client.query(`INSERT INTO catalog_variant_group_products (organization_id,product_id,group_id,kind)
              VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,product_id) DO UPDATE
              SET group_id=EXCLUDED.group_id,kind=EXCLUDED.kind,origin_group_id=NULL`, [ctx.organizationId,id,group.id,manual ? 'manual' : 'snapshot']);
          }
        }
      }
      await client.query(`UPDATE catalog_variant_groups SET internal_name=$3,follow_auto=$4,customized=$5,
        updated_by_user_id=$6,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [ctx.organizationId,group.id,save.internalName || null,follow,customize,ctx.userId]);
    } else {
      if (!group) throw new ResourceNotFoundError('Variant group');
      if (action === 'reset') {
        if (group.kind !== 'automatic') throw new ValidationFailedError('Sopstvena grupa nema automatsko pravilo.');
        await client.query(`DELETE FROM catalog_variant_group_products WHERE organization_id=$1 AND
          (group_id=$2 OR (kind='detached' AND origin_group_id=$2))`, [ctx.organizationId,group.id]);
        await client.query(`UPDATE catalog_variant_groups SET follow_auto=true,customized=false,updated_at=now(),updated_by_user_id=$3
          WHERE organization_id=$1 AND id=$2`, [ctx.organizationId,group.id,ctx.userId]);
      } else {
        if (group.kind !== 'custom') throw new ValidationFailedError('Automatska grupa se vraća na automatiku, ne briše se.');
        await client.query('DELETE FROM catalog_variant_group_products WHERE organization_id=$1 AND group_id=$2', [ctx.organizationId,group.id]);
        await client.query('DELETE FROM catalog_variant_groups WHERE organization_id=$1 AND id=$2', [ctx.organizationId,group.id]);
      }
    }
    await client.query(`INSERT INTO catalog_variant_group_versions(organization_id,revision) VALUES ($1,1)
      ON CONFLICT (organization_id) DO UPDATE SET revision=catalog_variant_group_versions.revision+1`, [ctx.organizationId]);
    const result = groupOverview(await loadGroupState(client, ctx.organizationId));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
