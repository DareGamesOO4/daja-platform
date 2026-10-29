/** Apply the individually reviewed battery plan through the existing staff API.
 * Does not write prices, stock, media, identifiers or publication state.
 * Resume reconciles each product and variant independently after uncertain responses.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run({planPath,reportPath,pool,token,apiBase,organizationId,apply=false}){
  if(!pool.listenerCount('error'))pool.on('error',()=>console.warn('Database connection closed.'));
  const bytes=await fs.readFile(planPath),plan=JSON.parse(bytes),hash=createHash('sha256').update(bytes).digest('hex');
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  if(claims.org!==organizationId||plan.organizationId!==organizationId||new URL(apiBase).protocol!=='https:')throw Error('Tenant/HTTPS mismatch');
  if(plan.schemaVersion!==1||plan.products.length!==49||plan.review.images!==88||new Set(plan.products.map(p=>p.variantId)).size!==49)throw Error('Incomplete review');
  const keys=new Set(plan.definitions.map(d=>d.key));
  for(const p of plan.products){if(!p.descriptionEn||!p.description||Object.keys(p.specs).some(k=>!keys.has(k))||!p.evidence.photoUrls.length)throw Error('Missing evidence/translation');}
  const api=async(endpoint,body,method=body===undefined?'GET':'POST')=>{
    const r=await fetch(apiBase.replace(/\/$/,'')+endpoint,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    const raw=await r.text();if(!r.ok){const e=Error(`${endpoint}: HTTP ${r.status} ${raw.slice(0,200)}`);e.status=r.status;throw e;}
    if(raw&&!r.headers.get('content-type')?.includes('json')){const e=Error('Non JSON API response');e.status=502;throw e;}
    const d=raw?JSON.parse(raw):{};return d&&typeof d==='object'&&'data'in d?d.data:d;
  };
  const retry=async fn=>{for(let n=0;;n++){try{return await fn();}catch(e){if(n>=5||!([409,429,500,502,503,504].includes(e.status)||['57P01','57P03'].includes(e.code)||e instanceof TypeError||e.name==='TimeoutError'||/ECONNRESET|connection terminated|recovery mode/i.test(e.message)))throw e;await delay(Math.min(8000,500*2**n));}}};
  const current=async p=>{
    const r=await pool.query(`SELECT p.id,p.name,p.description,p.version AS product_version,p.external_id,p.department_id,v.id AS variant_id,v.attributes,v.version,v.current_price_amount,
      COALESCE((SELECT sum(i.quantity) FROM inventory_balances i WHERE i.organization_id=p.organization_id AND i.variant_id=v.id),0)::int AS quantity
      FROM products p JOIN product_variants v ON v.organization_id=p.organization_id AND v.product_id=p.id
      WHERE p.organization_id=$1 AND p.id=$2 AND v.id=$3 AND p.deleted_at IS NULL AND v.deleted_at IS NULL`,[organizationId,p.productId,p.variantId]);
    const row=r.rows[0];if(!row||row.external_id!==p.externalId||row.department_id!==plan.departmentId)throw Error('Identity changed: '+p.externalId);
    if(Number(row.current_price_amount)!==p.expectedPrice||row.quantity!==p.expectedQuantity)throw Error('Price/stock changed: '+p.externalId);
    return row;
  };
  const assertBaseline=(p,row)=>{
    const applied=row.attributes._catalog_import?.batteryReview?.planHash===hash;
    if(!applied&&!equal(row.attributes,p.expectedAttributes))throw Error('Concurrent attributes edit: '+p.externalId);
    if(!((row.name===p.expectedName&&row.description===p.expectedDescription)||(row.name===p.name&&row.description===p.description)))throw Error('Concurrent description edit: '+p.externalId);
    return applied;
  };
  for(const p of plan.products)assertBaseline(p,await retry(()=>current(p)));
  const report={planHash:hash,startedAt:new Date().toISOString(),apply,review:plan.review,definitions:[],completed:[],failures:[]};
  const save=async()=>{await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));await fs.rename(reportPath+'.tmp',reportPath);};
  await save();if(!apply)return report;
  for(const def of plan.definitions){
    const found=await retry(async()=>{
      let defs=await api('/spec_keys');let d=defs.find(d=>d.slug===def.slug||d.name===def.name);
      if(d&&d.departmentId!==plan.departmentId)throw Error('Definition belongs to another department');
      if(!d){try{await api('/spec_keys',{name:def.name,slug:def.slug,departmentId:plan.departmentId,dataType:'text',optionValues:def.optionValues,active:true});}catch(e){defs=await api('/spec_keys');if(!defs.some(d=>d.slug===def.slug))throw e;}
        defs=await api('/spec_keys');d=defs.find(d=>d.slug===def.slug);}
      if(!d||!equal(d.optionValues,def.optionValues))throw Error('Unexpected answer values: '+def.key);return d;
    });report.definitions.push({...def,id:found.id});
  }
  await retry(async()=>{
    let editor=await api('/specification-editor',{action:'get',departmentId:plan.departmentId});
    if(!editor.version){const def=report.definitions[0];editor=await api('/specification-editor',{action:'option',departmentId:plan.departmentId,specId:def.id,value:def.optionValues[0]});}
    const configuration={groups:plan.groups,fields:report.definitions.map((d,order)=>({specId:d.id,groupId:d.group,order,visibility:[],options:d.optionValues.map(value=>({value,rules:[]}))}))};
    if(!equal(editor.configuration,configuration))await api('/specification-editor',{action:'configure',departmentId:plan.departmentId,version:editor.version,configuration});
  });await save();
  for(const p of plan.products){try{
    await retry(async()=>{
      let row=await current(p);const applied=assertBaseline(p,row);
      if(!applied){const attributes={...row.attributes,...p.specs,_translations:{...row.attributes._translations,en:{...row.attributes._translations?.en,name:p.nameEn,description:p.descriptionEn,metaDescription:p.descriptionEn.split('\n')[0].slice(0,160)}},_catalog_import:{...row.attributes._catalog_import,batteryReview:{planHash:hash,reviewedAt:new Date().toISOString(),manualReview:p.manualReview,evidence:p.evidence}}};
        // The original supplier category is preserved internally; replace the generic visible field.
        if(attributes.tip===p.expectedAttributes.tip)delete attributes.tip;
        await api('/variants/'+p.variantId,{attributes,expectedVersion:Number(row.version)},'PATCH');
      }else if(Object.entries(p.specs).some(([k,v])=>row.attributes[k]!==v)||row.attributes._translations?.en?.description!==p.descriptionEn)throw Error('Saved review edited: '+p.externalId);
      row=await current(p);
      if(row.name!==p.name||row.description!==p.description){assertBaseline(p,row);await api('/products/'+p.productId,{name:p.name,description:p.description,expectedVersion:Number(row.product_version)},'PATCH');}
    });
    report.completed.push({externalId:p.externalId,sku:p.sku,specifications:Object.keys(p.specs).length,manualReview:p.manualReview});
  }catch(e){report.failures.push({externalId:p.externalId,error:e.message});}
  await save();console.log(`Batteries saved ${report.completed.length}/${plan.products.length}; failures ${report.failures.length}`);}
  // Read-only persistence verification, not a deployment check or test suite.
  for(const p of plan.products){const row=await retry(()=>current(p));if(row.name!==p.name||row.description!==p.description||row.attributes._translations?.en?.description!==p.descriptionEn||Object.entries(p.specs).some(([k,v])=>row.attributes[k]!==v))throw Error('Persistence verification failed: '+p.externalId);}
  report.success=report.completed.length===49&&report.failures.length===0;report.finishedAt=new Date().toISOString();report.priceAndStockUnchanged=true;await save();return report;
}
module.exports={run};
