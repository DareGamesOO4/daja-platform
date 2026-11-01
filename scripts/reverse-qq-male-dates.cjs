/* One-off, guarded catalog maintenance. Never runs a write without --apply. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require(require.resolve('pg',{paths:[__dirname,process.cwd()]}));
const organizationId = '00000000-0000-4000-8000-000000000101';
const brandId = '43726b8b-cf63-459e-a360-8ce7ef92a678';
const departmentId = '0570a9bd-f20e-44da-bacc-b76f5a6db499';
const runId = 'qq-male-date-reversal-20261101';
const scope = `p.organization_id='${organizationId}'::uuid AND p.brand_id='${brandId}'::uuid
 AND p.department_id='${departmentId}'::uuid AND p.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.organization_id=p.organization_id AND v.deleted_at IS NULL AND translate(upper(v.gender),'ŠŽ','SZ')='MUSKI')`;
const productsSql = `SELECT p.id,p.name,p.created_at::text AS created_at,p.updated_at::text AS updated_at,p.version::text AS version FROM products p WHERE ${scope} ORDER BY p.created_at,p.id`;
const variantsSql = `SELECT v.id,v.product_id,v.created_at::text AS created_at,v.updated_at::text AS updated_at,v.version::text AS version FROM product_variants v JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id WHERE ${scope} AND v.deleted_at IS NULL ORDER BY v.id`;
const hash = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function inspect(c) {
 const products=(await c.query(productsSql)).rows, variants=(await c.query(variantsSql)).rows;
 return {runId,organizationId,brandId,departmentId,products,variants,fingerprint:hash({products,variants})};
}
async function run() {
 const mode=process.argv[2]||'--inspect';
 if(!['--inspect','--backup','--apply','--verify','--rollback'].includes(mode))throw Error('Unknown mode');
 const file=process.argv[3]||'/tmp/qq-male-dates-20261101.json';
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query("SET TIME ZONE 'UTC'");
  if(mode==='--inspect'||mode==='--backup') {
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const b=await inspect(c);await c.query('COMMIT');
   if(mode==='--backup'){if(fs.existsSync(file))throw Error('Backup already exists');fs.writeFileSync(file,JSON.stringify(b,null,2),{mode:0o600,flag:'wx'});}
   console.log(JSON.stringify({mode,count:b.products.length,variants:b.variants.length,fingerprint:b.fingerprint,first:b.products.slice(0,3),last:b.products.slice(-3)}));return;
  }
  const b=JSON.parse(fs.readFileSync(file,'utf8'));if(b.runId!==runId||b.organizationId!==organizationId||b.fingerprint!==hash({products:b.products,variants:b.variants}))throw Error('Invalid backup');
  const expected=process.env.QQ_DATES_EXPECTED_FINGERPRINT;
  if(!expected||expected!==b.fingerprint)throw Error('Expected fingerprint must match a reviewed, saved backup');
  if(b.products.length!==655||b.variants.length!==655)throw Error('Unexpected scope count; inspect first');
  const planned=b.products.map((p,i)=>({...p,target:b.products[b.products.length-1-i].created_at}));
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='30s'");
  await c.query(`SELECT p.id FROM products p WHERE ${scope} ORDER BY p.id FOR UPDATE OF p`);
  await c.query('SELECT id FROM product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[b.variants.map(v=>v.id)]);
  const live=await inspect(c);
  const mixed=await c.query(`SELECT v.id FROM product_variants v WHERE v.product_id=ANY($1::uuid[]) AND v.deleted_at IS NULL AND COALESCE(translate(upper(v.gender),'ŠŽ','SZ'),'')<>'MUSKI'`,[b.products.map(p=>p.id)]);
  if(mixed.rowCount)throw Error('Mixed-gender variants: abort');
  const applied=await c.query('SELECT id FROM audit_events WHERE organization_id=$1 AND request_id=$2 AND operation=$3',[organizationId,runId,'catalog.timestamps.reverse']);
  if(mode==='--apply' && applied.rowCount)throw Error('This operation was already applied');
  if(mode==='--apply' && live.fingerprint!==b.fingerprint)throw Error('Catalog changed after backup');
  await c.query('CREATE TEMP TABLE qq_date_map(id uuid PRIMARY KEY,target timestamptz NOT NULL) ON COMMIT DROP');
  await c.query('INSERT INTO qq_date_map SELECT id::uuid,target::timestamptz FROM jsonb_to_recordset($1::jsonb) AS x(id text,target text)',[JSON.stringify(planned.map(p=>({id:p.id,target:p.target})))]);
  if(mode==='--verify'||mode==='--rollback') {
   const bad=await c.query(`SELECT p.id FROM products p JOIN qq_date_map m ON m.id=p.id WHERE p.created_at<>m.target OR p.updated_at<>m.target
    UNION ALL SELECT v.id FROM product_variants v JOIN qq_date_map m ON m.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND (v.created_at<>m.target OR v.updated_at<>m.target)`,[b.variants.map(v=>v.id)]);
   if(bad.rowCount)throw Error('Applied dates differ; do not overwrite concurrent changes');
   if(mode==='--verify'){await c.query('ROLLBACK');console.log(JSON.stringify({verified:true,products:b.products.length,variants:b.variants.length,first:live.products.slice(-3).reverse()}));return;}
  }
  const beforeOther=(await c.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'')) AS hash FROM products p WHERE NOT(p.id=ANY($1::uuid[]))`,[b.products.map(p=>p.id)])).rows[0].hash;
  const beforeOtherVariants=(await c.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id)::text,'')) AS hash FROM product_variants v WHERE NOT(v.id=ANY($1::uuid[]))`,[b.variants.map(v=>v.id)])).rows[0].hash;
  let pc,vc;
  if(mode==='--apply') {
   pc=await c.query('UPDATE products p SET created_at=m.target,updated_at=m.target,version=p.version+1 FROM qq_date_map m WHERE p.id=m.id');
   vc=await c.query('UPDATE product_variants v SET created_at=m.target,updated_at=m.target,version=v.version+1 FROM qq_date_map m WHERE v.product_id=m.id AND v.id=ANY($1::uuid[])',[b.variants.map(v=>v.id)]);
  } else {
   pc=await c.query('UPDATE products p SET created_at=x.created_at::timestamptz,updated_at=x.updated_at::timestamptz,version=p.version+1 FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,created_at text,updated_at text) WHERE p.id=x.id',[JSON.stringify(b.products)]);
   vc=await c.query('UPDATE product_variants v SET created_at=x.created_at::timestamptz,updated_at=x.updated_at::timestamptz,version=v.version+1 FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,created_at text,updated_at text) WHERE v.id=x.id',[JSON.stringify(b.variants)]);
  }
  if(pc.rowCount!==b.products.length||vc.rowCount!==b.variants.length)throw Error('Wrong update count');
  const afterOther=(await c.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text,'')) AS hash FROM products p WHERE NOT(p.id=ANY($1::uuid[]))`,[b.products.map(p=>p.id)])).rows[0].hash;
  const afterOtherVariants=(await c.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id)::text,'')) AS hash FROM product_variants v WHERE NOT(v.id=ANY($1::uuid[]))`,[b.variants.map(v=>v.id)])).rows[0].hash;
  if(beforeOther!==afterOther||beforeOtherVariants!==afterOtherVariants)throw Error('Unexpected change outside target scope');
  if(mode==='--apply'){
   const bad=await c.query(`SELECT p.id FROM products p JOIN qq_date_map m ON m.id=p.id WHERE p.created_at<>m.target OR p.updated_at<>m.target
    UNION ALL SELECT v.id FROM product_variants v JOIN qq_date_map m ON m.id=v.product_id WHERE v.id=ANY($1::uuid[]) AND (v.created_at<>m.target OR v.updated_at<>m.target)`,[b.variants.map(v=>v.id)]);
   if(bad.rowCount)throw Error('Final dates do not match the planned reversal');
  }
  const after=await inspect(c);
  const {OperationalSyncProjector}=await import(require('node:url').pathToFileURL(require('node:path').resolve('apps/api/dist/operational-sync-projector.js')));
  const ctx={organizationId,requestId:crypto.randomUUID(),correlationId:crypto.randomUUID(),userId:null,deviceId:null};
  const projector=new OperationalSyncProjector(c);
  for(const v of b.variants)await projector.publishProductChange(ctx,v.product_id,v.id,'update');
  await c.query(`INSERT INTO audit_events(organization_id,aggregate_type,aggregate_id,operation,before_payload,after_payload,reason,correlation_id,request_id) VALUES($1,'catalog_brand',$2,$3,$4::jsonb,$5::jsonb,$6,$7,$7)`,[organizationId,brandId,mode==='--apply'?'catalog.timestamps.reverse':'catalog.timestamps.restore',JSON.stringify(b),JSON.stringify(after),'Owner requested reversal of Q&Q male original creation dates; created_at and updated_at synchronized',runId]);
  await c.query('COMMIT');
  let cacheCleared=false;
  try {
   const Redis=require(require.resolve('ioredis',{paths:[__dirname,process.cwd()]}));const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1,lazyConnect:true});await redis.connect();
   const slugs=(await c.query('SELECT slug FROM products WHERE id=ANY($1::uuid[])',[b.products.map(p=>p.id)])).rows;
   await redis.del(...['catalog:sitemap:','catalog:sitemap:v2:','catalog:sitemap:v3:','catalog:sitemap:v4:','catalog:merchant-feed:','catalog:merchant-feed:v2:'].map(k=>k+organizationId),...slugs.map(p=>'catalog:slug:'+organizationId+':'+p.slug));await redis.quit();cacheCleared=true;
  } catch { console.log('Catalog timestamps committed; shared-cache cleanup needs retry'); }
  console.log(JSON.stringify({committed:true,mode,products:pc.rowCount,variants:vc.rowCount,otherProductsUnchanged:true,otherVariantsUnchanged:true,syncEvents:b.variants.length,cacheCleared,backupFingerprint:b.fingerprint,afterFingerprint:after.fingerprint}));
 } catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={inspect,run,runId};
