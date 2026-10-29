const fs=require('node:fs'),path=require('node:path');
function build(snapshotPath,outputPath){
 const snapshot=JSON.parse(fs.readFileSync(snapshotPath));if(snapshot.products.length!==49||snapshot.items.length)throw Error('Unexpected inventory; review serialized items first');
 const products=snapshot.products.map(row=>{
  const old=row.attributes._catalog_import?.packaging;if(!old||old.schemaVersion!==1)throw Error('Missing pack baseline');
  const selectable=row.attributes.format_baterije==='Dugmasta'||old.quantity===5;
  const unitPrice=Math.max(1000,Math.round(Number(old.listUnitPriceAmount)/1000)*1000);
  const quantity=selectable?1:old.quantity,regularPriceAmount=unitPrice*quantity,priceAmount=regularPriceAmount*(old.discountPercent===20?0.8:1);
  if(!Number.isInteger(priceAmount)||priceAmount%1000)throw Error('Price not a whole ten RSD');
  const packaging={...old,quantity,kind:selectable?'single':old.kind,listUnitPriceAmount:unitPrice,regularPriceAmount,priceAmount,rounding:'cell_price_to_nearest_10_RSD',...(selectable?{selectableQuantities:[1,5],sourcePackQuantity:old.quantity,stockUnit:'cell'}:{})};
  let description=row.description,name=row.name,en={...row.attributes._translations.en};
  const specs={};
  if(selectable){
   name=row.name.replace(/ — (?:pakovanje|kutija) \d+ komada$/,'')+' — 1 ili 5 komada';
   en.name=en.name.replace(/ — \d+ piece (?:pack|box)$/,'')+' — 1 or 5 batteries';
   let paragraphs=description.split('\n').filter(Boolean);
   paragraphs[0]=paragraphs[0].replace(/Pakovanje: \d+ komada\./,'Izbor: 1 ili 5 komada.');
   if(paragraphs[0].length>160)paragraphs[0]=paragraphs[0].replace('Izbor: 1 ili 5 komada.','1 ili 5 komada.');
   paragraphs=paragraphs.filter(p=>!p.startsWith('Cena se odnosi na pakovanje od'));
   paragraphs.push('Možete kupiti jednu bateriju ili 5 komada. Cena uz izbor 1 odnosi se na jednu bateriju, a uz izbor 5 na svih pet. Broj ćelija u fabričkom pakovanju na fotografiji odvojen je od izabrane količine.');
   description=paragraphs.join('\n');
   let english=en.description.split('\n').filter(Boolean);english[0]=english[0].replace(/Pack of \d+ batteries\./,'Choose 1 or 5 batteries.');
   while(english[0].length>160){const sentences=english[0].match(/[^.!?]+[.!?]+(?:\s|$)/g);if(!sentences||sentences.length<2)throw Error('English intro too long');english[0]=sentences.slice(0,-1).join('').trim();}
   english=english.filter(p=>!p.startsWith('Price is for one pack of'));
   english.push('Buy one battery or 5 batteries. With 1 selected, the price is for one cell; with 5 selected, the price covers all five. The factory pack shown in the photo is separate from the quantity selected.');
   en.description=english.join('\n');en.metaDescription=english[0];
   specs.broj_baterija_u_pakovanju='1 ili 5';specs.prodajno_pakovanje='Po komadu ili 5 komada';
  }
  const first=description.split('\n')[0];if(first.length>160)throw Error('Intro exceeds 160');
  const balances=snapshot.balances.filter(b=>b.variant_id===row.variant_id);
  if(balances.length!==1||!Number.isInteger(balances[0].quantity))throw Error('Review multi-location inventory first');
  const conversion=selectable?{locationId:balances[0].location_id,previousQuantity:balances[0].quantity,packSize:old.quantity,quantity:balances[0].quantity*old.quantity,delta:balances[0].quantity*(old.quantity-1)}:null;
  return {productId:row.id,variantId:row.variant_id,externalId:row.external_id,sku:row.sku,expectedName:row.name,expectedDescription:row.description,expectedSeo:row.seo,expectedAttributes:row.attributes,expectedPrice:Number(row.current_price_amount),name,description,seo:{...row.seo,metaDescription:first},english:en,specs,packaging,selectable,conversion};
 });
 const plan={schemaVersion:1,organizationId:snapshot.organizationId,departmentId:snapshot.products[0].department_id,products};
 fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify(plan,null,2));console.log(JSON.stringify({products:products.length,selectable:products.filter(p=>p.selectable).length,convertedCells:products.filter(p=>p.selectable).reduce((n,p)=>n+p.conversion.quantity,0),prices:products.filter(p=>p.packaging.quantity===40).map(p=>({sku:p.sku,price:p.packaging.priceAmount/100}))}));
}
module.exports={build};if(require.main===module)build(process.argv[2],process.argv[3]);
