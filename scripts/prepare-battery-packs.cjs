/** Build explicit selling packs from the reviewed photos and fresh inventory.
 * Existing 4/40-piece products become two manually linked choices; no stock is created.
 * Box reference price is ten 4-piece packs; the owner authorized a 20% reduction.
 */
const fs=require('node:fs');const path=require('node:path');
const {firstParagraph}=require('./battery-first-paragraphs.cjs');
const extraAliases={
  '7822':['V395','D395','280-48','SB-AP'],'7828':['V392','280-13','SB-B1'],
  '7829':['V377','280-39','SB-AW','606','9933'],'7830':['V371','280-31','SB-AN','605','9929'],
  '7831':['V364','D364','280-34','SB-AG','602','9911'],
  '7832':['LR1154','280-904','SB-F9','KA76'],
  '7819':['A1604','A522','4722','4922'],
  '7820':['DL21','DL23','1181A','A23BP'], '7821':['A27BP','GP27A','L828','4227'],
  '7841':['LR03N','824','4703','4903'],'7842':['LR03N','824','4703','4903'],'7851':['LR03N','824','4703','4903'],
  '7843':['LR6N','815','4706','4906'],'7844':['LR6N','815','4706','4906'],'7845':['LR6N','815','4706','4906'],
  '7847':['LR14N','814','4714','4914'],'7846':['LR20N','813','4720','4920'],
  '8192':['AC13','PR13'],'8193':['AC10','PR10'],'8195':['AC675','PR675'],'8432':['AC312','PR312'],
};
const enNumeric=s=>String(s).replace(/(\d),(\d)/g,'$1.$2');
function intro(p,specs,count,en=false){
  const s=specs,model=s.model_baterije||p.sku,chem=s.hemijski_sastav_baterije,voltage=s.napon_baterije||s.napon_na_celiji,capacity=s.kapacitet_baterije;
  const aliases=s.zamenske_oznake_baterije?.split(' / ').filter(x=>x!==model)||[];
  const type=en?{'Srebro-oksidna':'silver oxide','Alkalna':'alkaline','Litijumska (CR)':'lithium','Ni-MH':'Ni-MH','Cink-vazduh':'zinc air','Cink-ugljenična':'zinc carbon','Li-SOCl₂':'Li-SOCl₂','Li-ion':'Li-ion','Li-Po':'Li-Po','Punjiva litijumska':'lithium','Olovna VRLA AGM':'VRLA AGM'}[chem]:chem?.toLowerCase();
  const usefulAliases=aliases.filter(x=>/^\d{3}$/.test(x)||/^A(?:10|13|312|675)$/.test(x)||['AA','AAA','C','D','A23','A27','AG13'].includes(x)).slice(0,2);
  let text=en?`${model}${usefulAliases.length?' / '+usefulAliases.join(' / '):''} ${type} ${s.punjiva_baterija==='Da'?'rechargeable battery':'battery'}${voltage?', '+enNumeric(voltage):''}${capacity?', '+enNumeric(capacity):''}.`:
    `${model}${usefulAliases.length?' / '+usefulAliases.join(' / '):''} ${type} ${s.punjiva_baterija==='Da'?'punjiva baterija':'baterija'}${voltage?', '+voltage:''}${capacity?', '+capacity:''}.`;
  const pack=en?(count===1?'Sold as one battery.':`Pack of ${count} batteries.`):(count===1?'Prodaja po komadu.':`Pakovanje od ${count} baterija.`);
  text+=' '+pack;
  const format=s.format_baterije;
  const options=en?[
    chem==='Srebro-oksidna'?'For watches and compatible small electronics.':chem==='Cink-vazduh'?'For hearing aids requiring this exact size.':chem==='Olovna VRLA AGM'?'Sealed lead acid battery without electrolyte top up.':`For compatible ${['AA','AAA','C','D','9V'].includes(format)?format+' ':''}devices.`,
    aliases.length?'Match the battery code before replacing.':'Check the model before installation.',
    'Observe the correct polarity.',
  ]:[
    chem==='Srebro-oksidna'?'Za satove i kompatibilne male elektronske uređaje.':chem==='Cink-vazduh'?'Za slušne aparate odgovarajućeg formata.':chem==='Olovna VRLA AGM'?'Zatvoreni olovni akumulator bez dolivanja elektrolita.':`Za kompatibilne ${['AA','AAA','C','D','9V'].includes(format)?format+' ':''}uređaje.`,
    aliases.length?'Proveriti oznaku baterije pre zamene.':'Proveriti model pre ugradnje.',
    'Poštovati polaritet pri postavljanju.',
  ];
  // Complete useful phrases, never cut a word or remove the compatibility condition.
  for(const phrase of options)if(text.length+1+phrase.length<=160)text+=' '+phrase;
  const size=String(format||'');
  const specific=en?[
    ...(s.punjiva_baterija==='Da'?['Rechargeable cell.']:['Non-rechargeable cell.']),
    'Check the cell code.','Match the voltage.',
  ]:[
    chem==='Srebro-oksidna'?'Baterija za ručne satove.':chem==='Litijumska (CR)'||chem==='Alkalna'&&format==='Dugmasta'?'Dugmasta baterija za elektroniku.':chem==='Ni-MH'?'Za Ni-MH punjače.':s.punjiva_baterija==='Da'?'Punjiva ćelija za ugradnju.':['AA','AAA','C','D'].includes(size)?`${size} baterije od 1,5 V.`:'Za kompatibilnu elektroniku.',
    s.punjiva_baterija==='Da'?'Punjiva ćelija.':'Ne puniti.',
  ];
  for(const phrase of specific)if(text.length<148&&text.length+1+phrase.length<=160)text+=' '+phrase;
  if(text.length>160)throw Error('Intro too long: '+p.externalId+' '+text.length);
  return text;
}
function build({snapshotPath,reviewPath,outputPath}){
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath)),review=JSON.parse(fs.readFileSync(reviewPath));
  if(snapshot.products.length!==49||review.products.length!==49)throw Error('Inventory mismatch');
  const byExternal=new Map(snapshot.products.map(p=>[p.external_id,p]));
  const products=snapshot.products.map(row=>{
    const p=review.products.find(p=>p.externalId===row.external_id),id=row.external_id.replace('LINKEL-','');
    if(!p||row.sale_count||Number(row.current_price_amount)!==p.expectedPrice)throw Error('Price changed or sale exists: '+row.external_id);
    const count=Number(p.specs.pakovanje_na_fotografiji.split(' ')[0]);
    if(!Number.isInteger(count)||![1,2,4,5,6,40].includes(count))throw Error('Unreviewed pack count');
    let unitPrice=Number(row.current_price_amount),referenceSku=row.sku;
    if(count===40){const small=byExternal.get(id==='7842'?'LINKEL-7851':'LINKEL-7844');unitPrice=Number(small.current_price_amount);referenceSku=small.sku;}
    const regularPrice=unitPrice*count,discount=count===40?20:0,price=Math.round(regularPrice*(100-discount)/100);
    const specs={...p.specs,broj_baterija_u_pakovanju:String(count),prodajno_pakovanje:count===40?'Kutija':count===1?'Jedan komad':'Pakovanje'};
    const aliases=[...new Set([...(specs.zamenske_oznake_baterije?.split(' / ')||[]),...(extraAliases[id]||[])])];
    if(aliases.length)specs.zamenske_oznake_baterije=aliases.join(' / ');
    let name=p.name.replace(/\/(?:2|4|40)$/,'');
    if(count>1)name=name.replace(/^Baterija /,'Baterije ')+` — ${count===40?'kutija':'pakovanje'} ${count} komada`;
    const nameEn=p.nameEn+(count>1?` — ${count} ${count===40?'piece box':'piece pack'}`:'');
    const first=firstParagraph(p,specs,count),firstEn=intro(p,specs,count,true);
    if(first.length>160)throw Error('Reviewed introduction exceeds 160: '+row.sku+' '+first.length);
    const rewrite=(source,en)=>source.split(/\n\s*\n/).slice(1).filter(x=>!x.startsWith(en?'Price is per single battery.':'Cena je za jedan komad.')&&!x.startsWith(en?'Replacement for designations:':'Zamena za oznake:')).map(x=>x.replace(en?'Catalogue size for this format:':'Standardni format ćelije:',en?'Standard cell format:':'Standardne dimenzije formata:').replace(en?' These are catalogue dimensions, not a measurement of the individual item.':' Dimenzije su kataloške za navedeni format, nisu merenje konkretnog komada.',''));
    const sr=[first,...rewrite(p.description,false)],en=[firstEn,...rewrite(p.descriptionEn,true)];
    if(aliases.length){sr.splice(2,0,'Zamenske oznake i drugi nazivi: '+aliases.join(', ')+'. Koristiti kada se podudaraju hemijski tip, napon, dimenzije i zahtevi uređaja.');en.splice(2,0,'Equivalent designations and alternative names: '+aliases.join(', ')+'. Match chemistry, voltage, dimensions and device requirements before replacing.');}
    sr.push(count===1?'Cena se odnosi na jednu bateriju.':`Cena se odnosi na ${count===40?'celu kutiju':'pakovanje'} od ${count} baterija. Prikazan obračun „${count} × cena po komadu” odnosi se na sadržaj jednog pakovanja.`);
    en.push(count===1?'Price is for one battery.':`Price is for ${count===40?'one complete box':'one pack'} of ${count} batteries. The “${count} × price per battery” breakdown refers to the contents of one pack.`);
    if(count===40){sr.push('Cela kutija ima 20% popusta u odnosu na cenu deset pakovanja po 4 baterije. Možete izabrati pakovanje od 4 komada ili celu kutiju od 40 komada.');en.push('The full box is 20% cheaper than ten 4-piece packs. Choose a pack of 4 or a full box of 40 batteries.');}
    const packaging={schemaVersion:1,quantity:count,kind:count===40?'box':count===1?'single':'pack',listUnitPriceAmount:unitPrice,regularPriceAmount:regularPrice,priceAmount:price,discountPercent:discount,referenceSku,originalPerCellPriceAmount:Number(row.current_price_amount)};
    return {productId:p.productId,variantId:p.variantId,externalId:p.externalId,sku:p.sku,name,nameEn,description:sr.join('\n'),descriptionEn:en.join('\n'),firstParagraph:first,firstParagraphEn:firstEn,specs,packaging,expectedPrice:Number(row.current_price_amount),expectedAttributes:row.attributes,expectedName:row.name,expectedDescription:row.description,expectedSeo:row.seo,expectedQuantity:row.quantity,evidence:p.evidence,manualReview:p.manualReview};
  });
  const existing=review.definitions.map(d=>({...d,optionValues:[...new Set(products.map(p=>p.specs[d.key]).filter(Boolean))]}));
  const definitions=[...existing,...[['broj_baterija_u_pakovanju','Broj baterija u pakovanju','Batteries per pack'],['prodajno_pakovanje','Prodajno pakovanje','Selling unit']].map(([key,name,en])=>({key,name,en,group:'general',slug:key.replaceAll('_','-'),dataType:'text',optionValues:[...new Set(products.map(p=>p.specs[key]))]}))];
  const groups=[['LINKEL-7851','LINKEL-7842','AAA — 4 ili 40 baterija'],['LINKEL-7844','LINKEL-7845','AA — 4 ili 40 baterija']].map(([small,box,name])=>({name,memberIds:[byExternal.get(small).id,byExternal.get(box).id]}));
  const plan={schemaVersion:1,organizationId:snapshot.organizationId,departmentId:review.departmentId,editorGroups:review.groups,definitions,groups,review:{products:49,images:88,boxDiscountPercent:20,manualReview:5},products};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify(plan,null,2));
  console.log(JSON.stringify({products:products.length,packs:products.filter(p=>p.packaging.quantity>1).length,firstParagraphLengths:products.map(p=>({sku:p.sku,sr:p.firstParagraph.length,en:p.firstParagraphEn.length})),boxes:products.filter(p=>p.packaging.quantity===40).map(p=>({sku:p.sku,...p.packaging}))}));
}
module.exports={build};
if(require.main===module)build({snapshotPath:process.argv[2],reviewPath:process.argv[3],outputPath:process.argv[4]});
