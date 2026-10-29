/** Explicit pack migration through the authorized staff API. No stock writes.
 * Uses existing 4-piece and 40-piece products for choices, not duplicated SKUs.
 * Price is stored as the final pack total, including the owner's permanent box discount.
 */
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{isDeepStrictEqual:equal}=require('node:util');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run({planPath,reportPath,pool,token,apiBase,organizationId,apply=false}){
  if(!pool.listenerCount('error'))pool.on('error',()=>console.warn('Database connection closed.'));
  const bytes=await fs.readFile(planPath),plan=JSON.parse(bytes),hash=createHash('sha256').update(bytes).digest('hex');
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  if(claims.org!==organizationId||plan.organizationId!==organizationId||new URL(apiBase).protocol!=='https:'||plan.products.length!==49||new Set(plan.products.map(p=>p.variantId)).size!==49)throw Error('Tenant/plan mismatch');
  for(const p of plan.products){const pack=p.packaging;if(!p.firstParagraph||p.firstParagraph.length>160||p.firstParagraphEn.length>160||pack.regularPriceAmount!==pack.listUnitPriceAmount*pack.quantity||pack.priceAmount!==Math.round(pack.regularPriceAmount*(100-pack.discountPercent)/100)||pack.discountPercent!==(pack.quantity===40?20:0))throw Error('Invalid pack calculation');}
  const api=async(endpoint,body,method=body===undefined?'GET':'POST')=>{
    const r=await fetch(apiBase.replace(/\/$/,'')+endpoint,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)}),raw=await r.text();
    if(!r.ok){const e=Error(`${endpoint}: HTTP ${r.status}`);e.status=r.status;throw e;}
    if(raw&&!r.headers.get('content-type')?.includes('json')){const e=Error('Non JSON response');e.status=502;throw e;}const d=raw?JSON.parse(raw):{};return d&&typeof d==='object'&&'data'in d?d.data:d;
  };
  const retry=async fn=>{for(let n=0;;n++){try{return await fn();}catch(e){if(n>=5||!([409,429,500,502,503,504].includes(e.status)||['57P01','57P03'].includes(e.code)||e instanceof TypeError||e.name==='TimeoutError'||/connection terminated|ECONNRESET|recovery mode/i.test(e.message)))throw e;await wait(Math.min(8000,500*2**n));}}};
  const current=async p=>{const row=(await pool.query(`SELECT p.id,p.external_id,p.department_id,p.name,p.description,p.seo,p.version AS product_version,v.id AS variant_id,v.attributes,v.current_price_amount,v.version,COALESCE((SELECT sum(i.quantity) FROM inventory_balances i WHERE i.organization_id=p.organization_id AND i.variant_id=v.id),0)::int AS quantity FROM products p JOIN product_variants v ON v.organization_id=p.organization_id AND v.product_id=p.id WHERE p.organization_id=$1 AND p.id=$2 AND v.id=$3 AND p.deleted_at IS NULL AND v.deleted_at IS NULL`,[organizationId,p.productId,p.variantId])).rows[0];
    if(!row||row.external_id!==p.externalId||row.department_id!==plan.departmentId||row.quantity!==p.expectedQuantity)throw Error('Identity/stock changed '+p.externalId);return row;};
  const seo=p=>({...p.expectedSeo,metaDescription:p.firstParagraph});
  const baseline=(p,r)=>{
    const applied=r.attributes._catalog_import?.packagingReview?.planHash===hash;
    if(applied){if(Number(r.current_price_amount)!==p.packaging.priceAmount||!equal(r.attributes._catalog_import.packaging,p.packaging)||Object.entries(p.specs).some(([k,v])=>r.attributes[k]!==v))throw Error('Saved packaging edited '+p.externalId);}
    else if(Number(r.current_price_amount)!==p.expectedPrice||!equal(r.attributes,p.expectedAttributes))throw Error('Concurrent price/attribute edit '+p.externalId);
    const old=r.name===p.expectedName&&r.description===p.expectedDescription&&equal(r.seo,p.expectedSeo),next=r.name===p.name&&r.description===p.description&&equal(r.seo,seo(p));
    if(!old&&!next)throw Error('Concurrent content edit '+p.externalId);return applied;
  };
  for(const p of plan.products)baseline(p,await retry(()=>current(p)));
  const report={planHash:hash,apply,startedAt:new Date().toISOString(),definitions:[],groups:[],completed:[],failures:[]};
  const save=async()=>{await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));await fs.rename(reportPath+'.tmp',reportPath);};
  await save();if(!apply)return report;
  for(const def of plan.definitions){
    const d=await retry(async()=>{let defs=await api('/spec_keys'),d=defs.find(x=>x.slug===def.slug||x.name===def.name);
      if(d&&d.departmentId!==plan.departmentId)throw Error('Wrong definition department');
      if(!d){try{await api('/spec_keys',{name:def.name,slug:def.slug,departmentId:plan.departmentId,dataType:'text',optionValues:def.optionValues,active:true});}catch(e){defs=await api('/spec_keys');if(!defs.some(x=>x.slug===def.slug))throw e;}defs=await api('/spec_keys');d=defs.find(x=>x.slug===def.slug);}
      const answers=[...new Set([...d.optionValues,...def.optionValues])];
      if(!equal(d.optionValues,answers)){await api('/spec_keys/'+d.id,{optionValues:answers},'PATCH');d={...d,optionValues:answers};}return d;});
    report.definitions.push({...def,id:d.id,optionValues:d.optionValues});
  }
  await retry(async()=>{const editor=await api('/specification-editor',{action:'get',departmentId:plan.departmentId});
    if(!editor.version)throw Error('Missing existing battery editor');
    const configuration={...editor.configuration,fields:[...editor.configuration.fields]};
    for(const[order,def]of report.definitions.entries()){
      const found=configuration.fields.find(f=>f.specId===def.id);
      if(found){for(const value of def.optionValues)if(!found.options.some(x=>x.value===value))found.options.push({value,rules:[]});}
      else configuration.fields.push({specId:def.id,groupId:def.group,order,visibility:[],options:def.optionValues.map(value=>({value,rules:[]}))});
    }
    await api('/specification-editor',{action:'configure',departmentId:plan.departmentId,version:editor.version,configuration});
  });
  for(const p of plan.products){try{await retry(async()=>{
    let row=await current(p);const applied=baseline(p,row);
    if(!applied){const attributes={...row.attributes,...p.specs,_translations:{...row.attributes._translations,en:{...row.attributes._translations?.en,name:p.nameEn,description:p.descriptionEn,metaDescription:p.firstParagraphEn}},_catalog_import:{...row.attributes._catalog_import,packaging:p.packaging,packagingReview:{planHash:hash,reviewedAt:new Date().toISOString(),previousPriceAmount:p.expectedPrice,photoUrls:p.evidence.photoUrls,referenceUrls:p.evidence.referenceUrls,boxDiscountBasis:p.packaging.quantity===40?'ten_4_piece_packs':null}}};
      await api('/variants/'+p.variantId,{attributes,currentPriceAmount:p.packaging.priceAmount,expectedVersion:Number(row.version)},'PATCH');
    }
    row=await current(p);baseline(p,row);
    if(row.name!==p.name||row.description!==p.description||!equal(row.seo,seo(p)))await api('/products/'+p.productId,{name:p.name,description:p.description,seo:seo(p),expectedVersion:Number(row.product_version)},'PATCH');
  });report.completed.push({externalId:p.externalId,sku:p.sku,quantity:p.packaging.quantity,previousPerCellPriceAmount:p.expectedPrice,packPriceAmount:p.packaging.priceAmount,regularPackPriceAmount:p.packaging.regularPriceAmount,discountPercent:p.packaging.discountPercent,firstParagraphLength:p.firstParagraph.length});}
  catch(e){report.failures.push({externalId:p.externalId,error:e.message});}await save();console.log(`Pack saved ${report.completed.length}/49; failures ${report.failures.length}`);}
  if(report.failures.length)throw Error('Some pack records require reconciliation');
  for(const group of plan.groups){const saved=await retry(async()=>{
    let overview=await api('/admin/variant-groups');const exact=overview.groups.find(g=>g.kind==='custom'&&g.memberIds.length===2&&group.memberIds.every(id=>g.memberIds.includes(id)));
    if(exact)return {key:exact.key,memberIds:exact.memberIds};
    const body={key:null,expectedRevision:overview.revision,expectedCatalogRevision:overview.catalogRevision,internalName:group.name,followAuto:false,editMembers:true,memberIds:group.memberIds,removedIds:[]};
    try{await api('/admin/variant-groups',body);}catch(e){overview=await api('/admin/variant-groups');if(!overview.groups.some(g=>g.kind==='custom'&&g.memberIds.length===2&&group.memberIds.every(id=>g.memberIds.includes(id))))throw e;}
    overview=await api('/admin/variant-groups');const found=overview.groups.find(g=>g.kind==='custom'&&g.memberIds.length===2&&group.memberIds.every(id=>g.memberIds.includes(id)));if(!found)throw Error('Group was not saved');return {key:found.key,memberIds:found.memberIds};
  });report.groups.push({...group,...saved});await save();}
  // Read-only saved-data verification; no test suite or deployment polling.
  for(const p of plan.products){const r=await retry(()=>current(p));baseline(p,r);if(r.name!==p.name||r.description!==p.description||!equal(r.seo,seo(p))||r.attributes._translations?.en?.description!==p.descriptionEn||r.attributes._translations?.en?.metaDescription!==p.firstParagraphEn)throw Error('Persistence mismatch '+p.externalId);}
  report.success=report.completed.length===49&&report.groups.length===2;report.stockUnchanged=true;report.finishedAt=new Date().toISOString();await save();return report;
}
module.exports={run};
