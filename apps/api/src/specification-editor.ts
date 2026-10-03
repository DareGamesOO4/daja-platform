import { z } from 'zod';
import type { Database } from '@daja/database';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';

const condition = z.object({ specId: z.string().uuid().optional(), brand: z.boolean().optional(), value: z.string().trim().min(1).max(160), operator: z.enum(['equals', 'notEquals']) }).refine(v => Boolean(v.specId) !== Boolean(v.brand));
const rules = z.array(z.array(condition).min(1).max(20)).max(30);
const field = z.object({ specId: z.string().uuid(), groupId: z.string().max(80), order: z.number().int().min(0), visibility: rules, options: z.array(z.object({ value: z.string().trim().min(1).max(160), rules })).max(100) });
export const specificationConfigurationSchema = z.object({ groups: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(100) })).max(40), fields: z.array(field).max(400) });
export const specificationEditorRequestSchema = z.object({
  action: z.enum(['get', 'configure', 'option']), departmentId: z.string().uuid(), brand: z.string().max(240).optional(),
  specs: z.record(z.string(), z.string()).optional(), version: z.number().int().min(0).optional(),
  configuration: specificationConfigurationSchema.optional(), specId: z.string().uuid().optional(),
  value: z.string().trim().min(1).max(160).optional(), linkType: z.string().trim().max(160).optional()
});
type Configuration = z.infer<typeof specificationConfigurationSchema>;
type Specification = { id: string; name: string; slug: string; unit: string | null; optionValues: string[] };
const norm = (v: string) => v.trim().toLocaleLowerCase('sr-RS').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-\s]+/g, '_');
const groups = [
  ['general', 'Opšti podaci', ['serija', 'garancija']],
  ['mechanism', 'Mehanizam', ['tip_mehanizma', 'mehanizam', 'rezerva_snage']],
  ['functions', 'Funkcije', ['datum', 'dan_u_nedelji']],
  ['design', 'Dizajn', ['stil', 'oblik', 'prikaz', 'boja_brojcanika', 'boja_kucista']],
  ['case', 'Kućište i otpornost', ['precnik_kucista', 'debljina_kucista', 'staklo', 'vodootpornost']],
  ['strap', 'Narukvica', ['materijal_narukvice', 'stil_narukvice', 'boja_narukvice']]
] as const;

function defaults(specs: Specification[], watch: boolean): Configuration {
  const type = specs.find(s => norm(s.slug) === 'tip_mehanizma');
  return {
    groups: watch ? groups.map(g => ({ id: g[0], name: g[1] })) : [],
    fields: specs.map(s => {
      const group = watch ? groups.find(g => (g[2] as readonly string[]).includes(norm(s.slug))) : undefined;
      return { specId: s.id, groupId: group?.[0] || 'other', order: group ? (group[2] as readonly string[]).indexOf(norm(s.slug)) : 0,
        visibility: watch && norm(s.slug) === 'rezerva_snage' && type ? [[{ specId: type.id, operator: 'notEquals' as const, value: 'Kvarc' }]] : [], options: [] };
    })
  };
}

function validateConfiguration(config: Configuration, specs: Specification[]) {
  const ids = new Set(specs.map(s => s.id));
  const groupIds = new Set(config.groups.map(g => g.id));
  if (groupIds.size !== config.groups.length || groupIds.has('other') || new Set(config.fields.map(f => f.specId)).size !== config.fields.length) throw new BadRequestException('Kategorije ili polja su duplirani.');
  const graph = new Map<string, Set<string>>();
  for (const f of config.fields) {
    if (!ids.has(f.specId) || (f.groupId !== 'other' && !groupIds.has(f.groupId))) throw new BadRequestException('Nepoznata specifikacija ili kategorija.');
    const deps = [...f.visibility, ...f.options.flatMap(o => o.rules)].flat().flatMap(c => c.specId ? [c.specId] : []);
    if (deps.some(id => !ids.has(id))) throw new BadRequestException('Pravilo koristi nepoznatu specifikaciju.');
    if (new Set(f.options.map(o => norm(o.value))).size !== f.options.length) throw new BadRequestException('Ponuđena vrednost ima više konfiguracija.');
    graph.set(f.specId, new Set(deps));
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new BadRequestException('Kružne zavisnosti nisu dozvoljene.');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of graph.get(id) || []) visit(dep); visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export async function specificationEditor(database: Database, organizationId: string, input: z.infer<typeof specificationEditorRequestSchema>) {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const department = (await client.query('SELECT slug FROM departments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.departmentId, organizationId])).rows[0];
    if (!department) throw new NotFoundException('Odeljenje nije pronađeno.');
    const specs: Specification[] = (await client.query(`SELECT id,name,slug,unit,option_values AS "optionValues" FROM spec_keys WHERE organization_id=$1 AND department_id=$2 AND deleted_at IS NULL AND active=true ORDER BY name`, [organizationId, input.departmentId])).rows;
    let stored = (await client.query('SELECT version,configuration FROM specification_editor_configurations WHERE organization_id=$1 AND department_id=$2', [organizationId, input.departmentId])).rows[0];
    let configuration: Configuration = stored?.configuration ?? defaults(specs, norm(department.slug) === 'satovi');
    // New taxonomy fields always remain visible, even with an older saved layout.
    configuration = { ...configuration, fields: configuration.fields.filter(f => specs.some(s => s.id === f.specId)) };
    for (const s of specs) if (!configuration.fields.some(f => f.specId === s.id)) configuration.fields.push({ specId: s.id, groupId: 'other', order: 999, visibility: [], options: [] });
    const products = (await client.query(`SELECT v.attributes,b.name AS brand FROM product_variants v JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id LEFT JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id WHERE v.organization_id=$1 AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.department_id=$2`, [organizationId,input.departmentId])).rows;
    const typeSpec = specs.find(s => norm(s.slug) === 'tip_mehanizma');
    const caliberSpec = specs.find(s => norm(s.slug) === 'mehanizam');
    const get = (attributes: Record<string,unknown>, spec: Specification | undefined): string | undefined => {
      if (!spec) return undefined;
      const value = Object.entries(attributes || {}).find(([k]) => norm(k) === norm(spec.slug) || norm(k) === norm(spec.name))?.[1];
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
    };
    if (caliberSpec && typeSpec) {
      const f = configuration.fields.find(f => f.specId === caliberSpec.id)!;
      for (const value of caliberSpec.optionValues) {
        if (f.options.some(o => norm(o.value) === norm(value))) continue;
        const types = [...new Set(products.filter(p => norm(String(get(p.attributes, caliberSpec) || '')) === norm(value)).map(p => String(get(p.attributes, typeSpec) || '').trim()).filter(Boolean).map(norm))];
        if (types.length === 1) {
          const type = typeSpec.optionValues.find(v => norm(v) === types[0]);
          if (type) f.options.push({ value, rules: [[{ specId: typeSpec.id, operator: 'equals', value: type }]] });
        }
      }
    }
    if (input.action !== 'get') {
      await client.query(`INSERT INTO specification_editor_configurations(organization_id,department_id,configuration) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [organizationId,input.departmentId,JSON.stringify(configuration)]);
      stored = (await client.query('SELECT version,configuration FROM specification_editor_configurations WHERE organization_id=$1 AND department_id=$2 FOR UPDATE', [organizationId,input.departmentId])).rows[0];
      if (input.action === 'configure') {
        if (input.version !== stored.version) throw new ConflictException('Podešavanja su promenjena na drugom uređaju. Ponovo učitaj pre čuvanja.');
        if (!input.configuration) throw new BadRequestException('Nedostaju podešavanja.');
        validateConfiguration(input.configuration, specs); configuration = input.configuration;
      } else {
        // Re-read under the configuration lock; simultaneous additions cannot overwrite one another.
        const inferred = configuration;
        configuration = stored.configuration;
        configuration.fields = configuration.fields.filter(f => specs.some(s => s.id === f.specId));
        for (const original of inferred.fields) {
          const current = configuration.fields.find(f => f.specId === original.specId);
          if (!current) configuration.fields.push(original);
          else for (const option of original.options) if (!current.options.some(o => norm(o.value) === norm(option.value))) current.options.push(option);
        }
        const spec = specs.find(s => s.id === input.specId);
        if (!spec || !input.value) throw new BadRequestException('Nedostaje specifikacija ili vrednost.');
        const row = (await client.query('SELECT option_values FROM spec_keys WHERE id=$1 AND organization_id=$2 FOR UPDATE', [spec.id, organizationId])).rows[0];
        if (!row) throw new NotFoundException('Specifikacija je u međuvremenu obrisana. Ponovo učitaj.');
        const values: string[] = row.option_values || [];
        const existing = values.find(v => norm(v) === norm(input.value!));
        if (!existing && values.length >= 100) throw new BadRequestException('Specifikacija već ima 100 ponuđenih vrednosti.');
        const value = existing || input.value;
        spec.optionValues = existing ? values : [...values, value];
        await client.query('UPDATE spec_keys SET option_values=$3::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND organization_id=$2', [spec.id, organizationId,JSON.stringify(spec.optionValues)]);
        if (input.linkType) {
          if (spec.id !== caliberSpec?.id || !typeSpec || !typeSpec.optionValues.some(v => norm(v) === norm(input.linkType!))) throw new BadRequestException('Izaberi važeći tip mehanizma.');
          let f = configuration.fields.find(f => f.specId === spec.id);
          if (!f) { f = {specId:spec.id,groupId:'other',order:999,visibility:[],options:[]}; configuration.fields.push(f); }
          const previous = f.options.find(o => norm(o.value) === norm(value));
          const linkedTypes = previous?.rules.flat().filter(c => c.specId === typeSpec.id && c.operator === 'equals').map(c => norm(c.value)) || [];
          if (linkedTypes.length && !linkedTypes.includes(norm(input.linkType))) throw new ConflictException('Kalibar je već povezan sa drugim tipom. Ponovo učitaj; vezu možeš menjati u podešavanjima.');
          f.options = f.options.filter(o => norm(o.value) !== norm(value));
          f.options.push({value,rules:[[{specId:typeSpec.id,operator:'equals',value:input.linkType}]]});
        }
        validateConfiguration(configuration,specs);
      }
      stored = (await client.query(`UPDATE specification_editor_configurations SET configuration=$3::jsonb,version=version+1,updated_at=now() WHERE organization_id=$1 AND department_id=$2 RETURNING version`, [organizationId,input.departmentId,JSON.stringify(configuration)])).rows[0];
    }
    const ranking = Object.fromEntries(specs.map(s => [s.id, Object.fromEntries(s.optionValues.map(value => {
      let score = 0;
      for (const p of products) if (norm(String(get(p.attributes,s) || '')) === norm(value)) {
        score += 1;
        if (input.brand && norm(String(p.brand || '')) === norm(input.brand)) score += 100;
        const selectedType = get(input.specs || {},typeSpec);
        if (selectedType && norm(String(get(p.attributes,typeSpec) || '')) === norm(selectedType)) score += 20;
      }
      return [value, score];
    }))]));
    await client.query('COMMIT');
    return { version: stored?.version || 0, configuration, specifications: specs, ranking };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
