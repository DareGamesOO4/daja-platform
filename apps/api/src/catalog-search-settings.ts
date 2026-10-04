import type { Pool } from 'pg';
import { z } from 'zod';
import { ConflictException } from '@nestjs/common';
export interface SearchSynonym { alias: string; target: string }
export interface SearchSettingsResult { version: number; synonyms: SearchSynonym[] }
export const searchSettingsSchema = z.object({version:z.number().int().min(0),synonyms:z.array(z.object({alias:z.string().trim().min(2).max(80),target:z.string().trim().min(2).max(80)})).max(400)}).superRefine((v,ctx)=>{
  const seen=new Set<string>();
  for(const item of v.synonyms){if(/\d/.test(item.alias)||/\d/.test(item.target))ctx.addIssue({code:'custom',message:'Sinonimi ne smeju preusmeravati brojčane oznake modela, dimenzije ili cene.'});const key=item.alias.toLocaleLowerCase('sr').replace(/\s+/g,' ');if(seen.has(key))ctx.addIssue({code:'custom',message:'Sinonim je dupliran.'});seen.add(key);}
});
export async function readSearchSettings(pool:Pool, organizationId:string):Promise<SearchSettingsResult>{
  const settings=await pool.query<{version:number;synonyms:SearchSynonym[]}>('SELECT version,synonyms FROM catalog_search_settings WHERE organization_id=$1',[organizationId]);
  return {version:settings.rows[0]?.version||0,synonyms:settings.rows[0]?.synonyms||[]};
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
