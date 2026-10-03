import type { Pool } from 'pg';
import { z } from 'zod';
import { ConflictException } from '@nestjs/common';
export interface SearchSynonym { alias: string; target: string }
export interface SearchSettingsResult { version: number; synonyms: SearchSynonym[]; misses: Array<{query:string;department:string;count:number}> }
export const searchSettingsSchema = z.object({version:z.number().int().min(0),synonyms:z.array(z.object({alias:z.string().trim().min(2).max(80),target:z.string().trim().min(2).max(80)})).max(400)}).superRefine((v,ctx)=>{
  const seen=new Set<string>();
  for(const item of v.synonyms){if(/\d/.test(item.alias)||/\d/.test(item.target))ctx.addIssue({code:'custom',message:'Sinonimi ne smeju preusmeravati brojčane oznake modela, dimenzije ili cene.'});const key=item.alias.toLocaleLowerCase('sr').replace(/\s+/g,' ');if(seen.has(key))ctx.addIssue({code:'custom',message:'Sinonim je dupliran.'});seen.add(key);}
});
export async function readSearchSettings(pool:Pool, organizationId:string):Promise<SearchSettingsResult>{
  const settings=await pool.query<{version:number;synonyms:SearchSynonym[]}>('SELECT version,synonyms FROM catalog_search_settings WHERE organization_id=$1',[organizationId]);
  const misses=await pool.query<{query:string;department:string;count:number}>(`SELECT query,department,SUM(count)::int AS count FROM catalog_search_misses WHERE organization_id=$1 AND day>=CURRENT_DATE-30 GROUP BY query,department ORDER BY SUM(count) DESC,query LIMIT 100`,[organizationId]);
  return {version:settings.rows[0]?.version||0,synonyms:settings.rows[0]?.synonyms||[],misses:misses.rows};
}
export async function saveSearchSettings(pool:Pool,organizationId:string,input:z.infer<typeof searchSettingsSchema>):Promise<SearchSettingsResult>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('INSERT INTO catalog_search_settings(organization_id) VALUES($1) ON CONFLICT DO NOTHING',[organizationId]);
    const result=await client.query('UPDATE catalog_search_settings SET synonyms=$3::jsonb,version=version+1,updated_at=now() WHERE organization_id=$1 AND version=$2 RETURNING version',[organizationId,input.version,JSON.stringify(input.synonyms)]);
    if(!result.rowCount)throw new ConflictException('Sinonimi su promenjeni na drugom uređaju. Ponovo učitaj podešavanja.');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return readSearchSettings(pool,organizationId);
}
// Aggregate only deliberately submitted, consented searches. No user/IP/session identifiers.
export async function recordSearchMiss(pool:Pool,organizationId:string,query:string,department:string){
  if(query.length<2||query.length>120||/@|https?:|\d{9,}/i.test(query))return;
  // Keep only a short-lived bounded aggregate; discard contact details and long free-form inputs.
  if(query.split(/\s+/).length>12||/\b(?:moje ime|zovem se|telefon|email|adresa)\b/i.test(query))return;
  query=query.toLocaleLowerCase('sr').trim().replace(/\s+/g,' ');
  await pool.query('DELETE FROM catalog_search_misses WHERE organization_id=$1 AND day<CURRENT_DATE-30',[organizationId]);
  await pool.query(`INSERT INTO catalog_search_misses(organization_id,query,department) SELECT $1,$2,$3 WHERE (SELECT COUNT(*) FROM catalog_search_misses WHERE organization_id=$1 AND day=CURRENT_DATE)<2000 ON CONFLICT(organization_id,query,department,day) DO UPDATE SET count=LEAST(catalog_search_misses.count+1,1000000)`,[organizationId,query,department]);
}
