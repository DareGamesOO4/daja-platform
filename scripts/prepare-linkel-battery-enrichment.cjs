/** Reviewed source facts. Build from a fresh tenant inventory and saved supplier/photos.
 * No capacities/weights borrowed from another manufacturer's cell, or a different series.
 * Run: node prepare-linkel-battery-enrichment.cjs <research-dir> <output-plan>
 */
const fs = require('node:fs');
const path = require('node:path');
const sources = {
  nexcell: 'https://www.nexcell-battery.com/en/',
  alkaline: 'https://www.nexcellglobal.com/Alkaline.htm',
  er: 'https://www.nexcellglobal.com/Lisocl2.htm',
  nimh: 'https://www.nexcellglobal.com/consumer.htm',
  zinc: 'https://www.nexcell-battery.com/en/product-105158/Zinc-Air-Battery-Hearing-Aid-Battery-More-Product-click-here.html',
  silver: 'https://solution.murata.com/en-eu/products/microbatteries_watch/asset/top/files/CrossReference_en.pdf',
  ag: 'https://tianqiubattery.com/products/alkaline-button-cells/',
  cross: 'https://energizer.com/wp-content/uploads/2023/12/ENR_BATTERY-CROSS-REFERENCE-GUIDE.pdf',
  cr: 'https://www.panasonic.com/global/energy/products/battery/coin_lithium_technologies.html',
  carbon: 'https://www.varta-ag.com/uk/consumer/product-categories/batteries/zinc/super-heavy-duty-45-v',
};
const facts = {};
function add(id, data) { facts[id] = data; }
// All five silver-oxide packs explicitly state 1.55 V; the supplier's 1.5 V is wrong.
for (const [id,model,short,number,ag,lr,d,h] of [
  [7822,'SR927SW','SR57','395','AG7','LR927','9,5','2,7'],
  [7828,'SR41W','SR41','392','AG3','LR41','7,9','3,6'],
  [7829,'SR626SW','SR66','377','AG4','LR626','6,8','2,6'],
  [7830,'SR920SW','SR69','371','AG6','LR920','9,5','2,05'],
  [7831,'SR621SW','SR60','364','AG1','LR621','6,8','2,15'],
]) add(id,{kind:'silver',model,voltage:'1,55 V',format:'Dugmasta',chem:'Srebro-oksidna',recharge:false,aliases:[model,short,number],conditional:[ag,lr],diameter:d+' mm',height:h+' mm',pack:'5',refs:['silver','ag'],name:`Baterija ${model} / ${number} 1,55 V`,nameEn:`${model} / ${number} 1.55 V silver oxide battery`});
add(7832,{kind:'alkaline-button',model:'LR44',format:'Dugmasta',voltage:'1,5 V',chem:'Alkalna',recharge:false,aliases:['LR44','AG13','A76','V13GA'],diameter:'11,6 mm',height:'5,4 mm',pack:'5',refs:['ag','cross','silver']});
for (const [id,model,d,h,aliases] of [
  [7833,'CR1220','12,5','2',['ECR1220','DL1220']], [7834,'CR1616','16','1,6',['ECR1616','DL1616']],
  [7835,'CR1620','16','2',['ECR1620','DL1620']], [7836,'CR2016','20','1,6',['ECR2016','DL2016','KECR2016']],
  [7837,'CR2025','20','2,5',['ECR2025','DL2025','KECR2025']], [7838,'CR2032','20','3,2',['ECR2032','DL2032','KECR2032']],
  [7839,'CR2430',null,null,['LF12W']], [7840,'CR2450','24,5','5',['KECR2450']],
]) add(id,{kind:'cr',model,format:'Dugmasta',voltage:'3 V',chem:'Litijumska (CR)',recharge:false,aliases:[model,...aliases],...(d?{diameter:d+' mm',height:h+' mm'}:{}),pack:'5',refs:['cr','cross']});
for (const [id,model,format,voltage,aliases,pack,d,h] of [
  [7819,'6LR61','9V','9 V',['6LR61','6LF22','MN1604','522'],'1',null,null],
  [7820,'23A','23A','12 V',['23A','A23','LR23A','MN21','V23GA'],'1','10','28'],
  [7821,'27A','27A','12 V',['27A','A27','LR27A','MN27'],'1','7,7','28'],
  [7841,'LR03','AAA','1,5 V',['AAA','LR03','MN2400','E92'],'2','10,5','44,4'],
  [7842,'LR03','AAA','1,5 V',['AAA','LR03','MN2400','E92'],'40','10,5','44,4'],
  [7843,'LR6','AA','1,5 V',['AA','LR6','MN1500','E91'],'2','14,5','50,4'],
  [7844,'LR6','AA','1,5 V',['AA','LR6','MN1500','E91'],'4','14,5','50,4'],
  [7845,'LR6','AA','1,5 V',['AA','LR6','MN1500','E91'],'40','14,5','50,4'],
  [7846,'LR20','D','1,5 V',['D','LR20','MN1300','E95'],'2','34,2','61,5'],
  [7847,'LR14','C','1,5 V',['C','LR14','MN1400','E93'],'2','26,2','50'],
  [7851,'LR03','AAA','1,5 V',['AAA','LR03','MN2400','E92'],'4','10,5','44,4'],
]) add(id,{kind:'alkaline',model,format,voltage,aliases,pack,chem:'Alkalna',recharge:false,...(d?{diameter:d+' mm',height:h+' mm'}:{}),refs:['alkaline','cross']});
for(const [id,format,capacity]of[[7848,'AAA','1100 mAh'],[7849,'AA',null],[7850,'AA','2700 mAh'],[8203,'9V','200 mAh'],[8204,'9V','220 mAh']]) add(id,{kind:'nimh',model:format==='9V'?`Ni-MH ${capacity}`:`Ni-MH ${format}`,format,voltage:format==='9V'?'8,4 V':'1,2 V',chem:'Ni-MH',recharge:true,capacity,pack:format==='9V'?'1':'2',refs:['nimh'],aliases:[],...(id===7849?{conflict:'Linkel navodi 1200 (1300) mAh, dok na fotografiji piše 1300 mAh. Potvrditi kapacitet stvarne zalihe.',name:'Punjiva Ni-MH baterija AA 1,2 V',nameEn:'AA 1.2 V Ni-MH rechargeable battery'}:{})});
for(const[id,model,size,color,colorEn,cap]of[[8192,'PR48','13','Narandžasta','Orange','300 mAh'],[8193,'PR536','10','Žuta','Yellow','100 mAh'],[8195,'PR44','675','Plava','Blue','630 mAh'],[8432,'PR41','312','Braon','Brown','180 mAh']])add(id,{kind:'zinc',model,format:'Dugmasta',voltage:'1,4 V',chem:'Cink-vazduh',recharge:false,aliases:[model,size,'A'+size],color,colorEn,capacity:cap,pack:'6',refs:['zinc','cross']});
add(8196,{kind:'carbon',model:'3R12',format:'Pljosnata 4,5V',voltage:'4,5 V',chem:'Cink-ugljenična',recharge:false,aliases:['3R12'],pack:'1',refs:['carbon'],name:'Baterija 3R12 Heavy Duty 4,5 V',nameEn:'3R12 Heavy Duty 4.5 V zinc carbon battery'});
add(8197,{kind:'cr-cylinder',model:'CR11108',format:'1/3N',voltage:'3 V',chem:'Litijumska (CR)',recharge:false,aliases:['CR11108','CR1/3N','1/3N','2L76'],pack:'5',refs:['cross']});
for(const[id,model,capacity,format,d,h]of[[8198,'ER14250','1200 mAh','1/2AA','14,5','25'],[8199,'ER14505','2400 mAh','AA','14,5','50,5'],[8200,'ER17505',null,'A','17','50,5']])add(id,{kind:'er',model,capacity,format,voltage:'3,6 V',chem:'Li-SOCl₂',recharge:false,aliases:[model],diameter:d+' mm',height:h+' mm',pack:'1',refs:['er'],...(id===8200?{conflict:'Naslov i zvanični NEXcell katalog navode 3300 mAh; fotografija ćelije prikazuje 3400 mAh. Potvrditi seriju i kapacitet stvarne zalihe.',name:'Litijumska baterija ER17505 3,6 V',nameEn:'ER17505 3.6 V lithium thionyl chloride battery'}:{})});
for(const[id,model,capacity,format]of[[7823,'14500','800 mAh','14500'],[7824,'ICR18650','2600 mAh','18650'],[7825,'ICR18650','3500 mAh','18650']])add(id,{kind:'liion',model,capacity,format,chem:'Li-ion',recharge:true,pack:'1',refs:[],photoVoltage:id===7823?'3,7 V':null,voltage:id===7823?null:'3,6 V',aliases:[model],...(id===7823?{note:'Na ćeliji piše 3,7 V, a na Linkel nalepnici i u naslovu 3,6 V. Za izbor punjača i uređaja merodavna je oznaka stvarne ćelije.',name:'Punjiva Li-ion baterija 14500 800 mAh',nameEn:'14500 800 mAh Li-ion rechargeable cell'}:{})});
for(const[id,model,capacity,conflict,name]of[
  [7826,'702030',null,'Nalepnica: 702030, 200 mAh, 3,6 V. Fotografija ćelije: Powercome 702030, 300 mAh, 3,7 V, 1,11 Wh.','Punjiva Li-Po baterija 702030'],
  [7827,null,null,'Nalepnica: 852657, 1000 mAh, 3,6 V. Fotografija ćelije: HJ 752560, 900 mAh, 3,7 V, 3,33 Wh, 25C. Model, kapacitet i proizvođač nisu usaglašeni.','Punjiva litijumska baterija — šifra 852657'],
  [8201,'752540','750 mAh',null,'Punjiva Li-Po baterija 752540 750 mAh'],
  [8202,null,'1200 mAh','Nalepnica: 903050, 1200 mAh, 3,6 V. Fotografija ćelije: Powercome 903052, 1200 mAh, 3,7 V, 4,44 Wh. Potvrditi stvarni model i dimenzije.','Punjiva Li-Po baterija — šifra 903050/3.6'],
])add(id,{kind:'lipo',model,capacity,format:'Pločasta sa izvodima',chem:id===7827?'Punjiva litijumska':'Li-Po',recharge:true,aliases:[],pack:'1',refs:[],conflict,name,nameEn:id===7827?'Rechargeable lithium cell — item code 852657':id===8202?'Rechargeable Li-Po cell — item code 903050/3.6':`${model} ${capacity||''} Li-Po rechargeable cell`.replace(/  /g,' '),...(id===8201?{photoVoltage:'3,7 V',energy:'2,775 Wh',note:'Na ćeliji Powercome piše 3,7 V / 2,775 Wh, dok dobavljačeva nalepnica navodi 3,6 V. Proveriti oznaku ćelije i zahteve uređaja pre ugradnje.'}:{})});
for(const[id,model,voltage,capacity,float,cycle,current]of[[8205,'TN4-4.5','4 V','4,5 Ah','4,5–4,6 V','4,8–5 V','≤ 1,35 A'],[8206,'TN6-4.5','6 V','4,5 Ah','6,75–6,9 V','7,2–7,5 V','≤ 1,85 A'],[8207,'TN12-7.0','12 V','7 Ah','13,5–13,8 V','14,4–15 V','≤ 2,1 A']])add(id,{kind:'agm',model,voltage,capacity,format:'Akumulator',chem:'Olovna VRLA AGM',recharge:true,float,cycle,current,pack:'1',refs:[],aliases:[model],name:`Olovni AGM akumulator ${model} ${voltage} ${capacity}`,nameEn:`${model} ${voltage} ${capacity} VRLA AGM rechargeable battery`});
const fields=[
  ['model_baterije','Model baterije','Battery model','general'],['format_baterije','Format baterije','Battery size / format','general'],['hemijski_sastav_baterije','Hemijski sastav baterije','Battery chemistry','electrical'],
  ['napon_baterije','Napon baterije','Nominal voltage','electrical'],['napon_na_celiji','Napon na ćeliji','Voltage printed on the cell','electrical'],['kapacitet_baterije','Kapacitet baterije','Battery capacity','electrical'],['energija_baterije','Energija baterije','Battery energy','electrical'],
  ['punjiva_baterija','Punjiva baterija','Rechargeable','electrical'],['zamenske_oznake_baterije','Zamenske oznake baterije','Equivalent designations','compatibility'],['boja_oznake_baterije','Boja oznake baterije','Hearing aid colour code','compatibility'],
  ['precnik_baterije','Prečnik baterije','Cell diameter','dimensions'],['visina_baterije','Visina baterije','Cell height / thickness','dimensions'],['pakovanje_na_fotografiji','Pakovanje na fotografiji','Factory pack shown in photo','general'],
  ['napon_odrzavanja_baterije','Napon održavanja baterije','Standby charge voltage','charging'],['ciklicni_napon_baterije','Ciklični napon baterije','Cycle charge voltage','charging'],['pocetna_struja_baterije','Početna struja baterije','Initial charge current limit','charging'],['odrzavanje_akumulatora','Održavanje akumulatora','Battery maintenance','charging'],
];
const chemistryEn={'Srebro-oksidna':'Silver oxide','Alkalna':'Alkaline','Litijumska (CR)':'Lithium (CR)','Ni-MH':'Ni-MH','Cink-vazduh':'Zinc air','Cink-ugljenična':'Zinc carbon','Li-SOCl₂':'Li-SOCl₂','Li-ion':'Li-ion','Li-Po':'Li-Po','Punjiva litijumska':'Rechargeable lithium','Olovna VRLA AGM':'Lead acid VRLA AGM'};
const formatEn={'Dugmasta':'button / coin cell','Pljosnata 4,5V':'flat 4.5 V','Pločasta sa izvodima':'flat cell with wire leads','Akumulator':'rechargeable battery'};
function build(root,output){
  const before=JSON.parse(fs.readFileSync(path.join(root,'before.json'))),details=JSON.parse(fs.readFileSync(path.join(root,'linkel-details.json'))),photos=JSON.parse(fs.readFileSync(path.join(root,'photo-index.json')));
  if(before.products.length!==49||details.length!==49||photos.length!==88)throw Error('Incomplete inventory/source review');
  const products=before.products.map(p=>{
    const f=facts[Number(p.external_id.replace('LINKEL-',''))];if(!f)throw Error('Unreviewed product');
    const supplier=details.find(d=>d.externalId===p.external_id),images=photos.filter(im=>im.externalId===p.external_id);
    const specs={format_baterije:f.format,hemijski_sastav_baterije:f.chem,punjiva_baterija:f.recharge?'Da':'Ne',pakovanje_na_fotografiji:f.pack+' kom.'};
    for(const[prop,key]of[['model','model_baterije'],['voltage','napon_baterije'],['photoVoltage','napon_na_celiji'],['capacity','kapacitet_baterije'],['energy','energija_baterije'],['color','boja_oznake_baterije'],['diameter','precnik_baterije'],['height','visina_baterije'],['float','napon_odrzavanja_baterije'],['cycle','ciklicni_napon_baterije'],['current','pocetna_struja_baterije']])if(f[prop])specs[key]=f[prop];
    if(f.aliases.length)specs.zamenske_oznake_baterije=f.aliases.join(' / ');
    if(f.kind==='agm')specs.odrzavanje_akumulatora='Bez dolivanja elektrolita';
    let sr=[`${f.model||'Punjiva litijumska ćelija'} je ${f.recharge?'punjiva':'nepunjiva'} ${f.chem.toLowerCase()} baterija, format ${f.format}${f.voltage?', nominalnog napona '+f.voltage:''}${f.capacity?', kapaciteta '+f.capacity:''}.`];
    let en=[`${f.model||'This lithium cell'} is a ${f.recharge?'rechargeable':'non-rechargeable'} ${chemistryEn[f.chem].toLowerCase()} battery in ${formatEn[f.format]||f.format} format${f.voltage?', with a nominal voltage of '+f.voltage.replaceAll(',','.'):''}${f.capacity?' and a capacity of '+f.capacity.replaceAll(',','.'):''}.`];
    const uses={silver:['Za satove i male elektronske uređaje koji zahtevaju ovu tačnu oznaku. SW označava varijantu za malu potrošnju; W varijantu za veću potrošnju. Pratiti oznaku propisanu za uređaj.','For watches and small electronic devices requiring this exact designation. SW denotes the low drain version and W the high drain version. Follow the device specification.'],
      'alkaline-button':['Za male elektronske uređaje koji koriste LR44.','For small electronic devices specified for LR44.'],cr:['Za kompatibilne satove, ključeve, daljinske upravljače i drugu elektroniku sa odgovarajućim ležištem. Proveriti celu CR oznaku: isti prečnik ne znači i istu debljinu. Nije zamena za punjive LIR ćelije.','For compatible watches, key fobs, remotes and electronics with the correct holder. Match the complete CR code: cells with the same diameter may differ in thickness. Not a replacement for rechargeable LIR cells.'],
      alkaline:['Za uređaje predviđene za ovaj format i napon. Kod 23A i 27A obavezno proveriti tačnu oznaku jer njihove dimenzije nisu iste.','For devices specified for this size and voltage. Match 23A and 27A exactly because their dimensions differ.'],
      nimh:['Višekratna upotreba uz odgovarajući Ni-MH punjač. AA i AAA Ni-MH ćelije imaju nominalno 1,2 V; zamenjuju alkalne AA/AAA samo kada uređaj podržava Ni-MH. Kod formata 9V nominalni napon ove ćelije je 8,4 V, prema natpisu na ćeliji.','Reusable with a compatible Ni-MH charger. AA and AAA Ni-MH cells are nominally 1.2 V; they replace alkaline AA/AAA only when the device supports Ni-MH. The cell in the 9V format is labelled with a nominal voltage of 8.4 V.'],
      zinc:['Za slušne aparate koji koriste ovu veličinu cink-vazduh baterije. Zaštitnu nalepnicu skinuti tek pred upotrebu; vazduh aktivira ćeliju. Broj i boju oznake uporediti sa starom baterijom.','For hearing aids requiring this zinc air size. Remove the protective tab only when ready to use; air activates the cell. Match both the number and colour code to the old battery.'],
      carbon:['Pljosnata Heavy Duty baterija za uređaje predviđene za 3R12 od 4,5 V. Oznaka 3R12 pripada cink-ugljeničnoj hemiji.','Flat Heavy Duty battery for devices specified for 4.5 V 3R12. The 3R12 designation refers to zinc carbon chemistry.'],
      'cr-cylinder':['Litijumska ćelija formata 1/3N za kompatibilnu elektroniku. Pre zamene uporediti oznaku, napon i kontakte.','Lithium cell in 1/3N format for compatible electronics. Match the designation, voltage and contacts before replacing.'],
      er:['Primarna litijum-tionil-hloridna ćelija za kompatibilnu industrijsku elektroniku i rezervno napajanje. Nije punjiva. ER14505 se ne sme ubacivati umesto obične AA baterije od 1,5 V samo zato što je slične veličine.','Primary lithium thionyl chloride cell for compatible industrial electronics and backup power. Not rechargeable. ER14505 must not be substituted for a 1.5 V AA solely because of a similar size.'],
      liion:['Ćelija za ugradnju u uređaj predviđen za odgovarajući Li-ion model. Potrebno je proveriti kontakte, polaritet, dimenzije, zaštitu i punjač. 14500 nije neposredna zamena za običnu AA bateriju od 1,5 V. Prisustvo zaštitne elektronike nije potvrđeno.','Cell for installation in equipment specified for the correct Li-ion model. Check contacts, polarity, dimensions, protection requirements and charger. A 14500 is not a direct substitute for an ordinary 1.5 V AA. Protection circuitry has not been confirmed.'],
      lipo:['Pločasta punjiva ćelija sa izvodima za ugradnju u kompatibilan uređaj. Pre zamene proveriti stvarni model, dimenzije, polaritet izvoda, zaštitnu elektroniku i profil punjenja. Sama sličnost oznake nije potvrda kompatibilnosti.','Flat rechargeable cell with wire leads for installation in compatible equipment. Match the actual model, dimensions, lead polarity, protection circuitry and charge profile. Similar model numbers alone do not establish compatibility.'],
      agm:['Zatvoreni olovni VRLA AGM akumulator bez dolivanja elektrolita, sa pljosnatim priključcima i označenim polaritetom. Za zamenu uskladiti napon, kapacitet, dimenzije kućišta i priključke.','Sealed lead acid VRLA AGM battery requiring no electrolyte top up, with flat terminals and marked polarity. Match voltage, capacity, case dimensions and terminals when replacing.']};
    sr.push(uses[f.kind][0]);en.push(uses[f.kind][1]);
    if(f.aliases.length){sr.push('Zamena za oznake: '+f.aliases.join(', ')+'. Koristiti kada se podudaraju tip, napon i zahtevi uređaja.');en.push('Replacement for designations: '+f.aliases.join(', ')+'. Use when chemistry, voltage and device requirements match.');}
    if(f.conditional){sr.push(`Isti format alkalne baterije se označava kao ${f.conditional.join(' / ')} (1,5 V). Ova srebro-oksidna ćelija od 1,55 V može se koristiti umesto nje samo ako uređaj podržava taj tip; hemija i kriva napona se razlikuju.`);en.push(`The same size alkaline cell is labelled ${f.conditional.join(' / ')} (1.5 V). This 1.55 V silver oxide cell can replace it only if the device supports that chemistry; chemistry and voltage behaviour differ.`);}
    if(Number(p.external_id.replace('LINKEL-',''))===7831){sr.push('AG11 / LR721 nije odgovarajuća zamenska oznaka za SR621SW.');en.push('AG11 / LR721 is not an equivalent designation for SR621SW.');}
    if(f.kind==='alkaline-button'){sr.push('SR44 / 357 su srebro-oksidne ćelije od 1,55 V, a LR44 / AG13 alkalne od 1,5 V; nisu isti hemijski tip.');en.push('SR44 / 357 are 1.55 V silver oxide cells; LR44 / AG13 are 1.5 V alkaline cells. Their chemistry differs.');}
    if(f.diameter){sr.push(`Standardni format ćelije: prečnik ${f.diameter}, visina / debljina ${f.height}. Dimenzije su kataloške za navedeni format, nisu merenje konkretnog komada.`);en.push(`Catalogue size for this format: diameter ${f.diameter.replaceAll(',','.')}, height / thickness ${f.height.replaceAll(',','.')}. These are catalogue dimensions, not a measurement of the individual item.`);}
    if(f.photoVoltage){sr.push(`Napon na fotografisanoj ćeliji: ${f.photoVoltage}${f.energy?'; energija '+f.energy:''}. Dobavljačeva nalepnica navodi 3,6 V. Pre ugradnje uskladiti stvarnu ćeliju i punjač.`);en.push(`The photographed cell is marked ${f.photoVoltage.replaceAll(',','.')}${f.energy?' and '+f.energy.replaceAll(',','.'):''}. The supplier bag states 3.6 V. Match the actual cell and charger before installation.`);}
    if(f.conflict){sr.push('Pre poručivanja potvrditi tačan model i kapacitet sa prodavnicom: podaci dobavljača i fotografije se razlikuju. Sporne vrednosti nisu potvrđena specifikacija ovog artikla.');en.push('Before ordering, confirm the exact model and capacity with the shop: supplier details and photographs differ. Conflicting values are not confirmed specifications for this item.');}
    if(f.kind==='agm'){sr.push(`Prema oznaci na kućištu: napon održavanja ${f.float}; ciklično punjenje ${f.cycle}; početna struja ${f.current}. Ne zagrevati iznad 60 °C, ne rastavljati i ne spaljivati. Parametre proveriti na stvarnom akumulatoru pre punjenja.`);en.push(`Case label charging values: standby ${f.float.replaceAll(',','.')}; cyclic ${f.cycle.replaceAll(',','.')}; initial current ${f.current.replaceAll(',','.')}. Do not heat above 60 °C, dismantle or incinerate. Check the actual battery label before charging.`);}
    sr.push(`Cena je za jedan komad. Fabričko pakovanje na fotografiji prikazuje ${f.pack} kom.; broj ćelija na slici ne određuje količinu koja se poručuje.`);en.push(`Price is per single battery. The factory pack in the photo shows ${f.pack} pcs; the number of cells pictured does not determine the quantity ordered.`);
    if(!f.recharge){sr.push('Ne puniti. Poštovati polaritet, ne kratko spajati i čuvati van domašaja dece.');en.push('Do not recharge. Observe polarity, avoid short circuits and keep out of reach of children.');}
    const description=sr.join('\n\n'),descriptionEn=en.join('\n\n');
    const name=f.name||p.name.replaceAll('Nextcell','NEXcell');
    const nameEn=(f.nameEn||[f.model,formatEn[f.format]?'':f.model?.includes(f.format)?'':f.format,f.voltage,f.model?.includes(f.capacity)?'':f.capacity,f.recharge?'rechargeable battery':'battery'].filter(Boolean).join(' ')).replace(/(\d),(\d)/g,'$1.$2');
    const evidence={supplierUrl:p.attributes._catalog_import.source.url,photoUrls:images.map(im=>im.url),photoReview:images.map(im=>({index:im.index,url:im.url})),referenceUrls:f.refs.map(k=>sources[k]),conflict:f.conflict||null,note:f.note||null,measurementScope:'Catalogue format dimensions only; no direct physical measurements.',capacityScope:'Label or matching NEXcell model only; no other brand capacities copied.'};
    return {productId:p.id,variantId:p.variant_id,externalId:p.external_id,sku:p.sku,expectedName:p.name,expectedDescription:p.description,expectedAttributes:p.attributes,expectedPrice:Number(p.current_price_amount),expectedQuantity:p.quantity,name,nameEn,description,descriptionEn,specs,evidence,manualReview:Boolean(f.conflict)};
  });
  const definitions=fields.map(([key,name,en,group])=>({key,name,en,group,slug:key.replaceAll('_','-'),dataType:'text',optionValues:[...new Set(products.map(p=>p.specs[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'sr'))}));
  const plan={schemaVersion:1,organizationId:'00000000-0000-4000-8000-000000000101',departmentId:before.departments[0].id,review:{products:49,images:88,date:'2026-10-29',manualReview:products.filter(p=>p.manualReview).length},sources,groups:[{id:'general',name:'Opšti podaci'},{id:'electrical',name:'Električne karakteristike'},{id:'compatibility',name:'Oznake i kompatibilnost'},{id:'dimensions',name:'Dimenzije'},{id:'charging',name:'Punjenje i održavanje'}],definitions,products};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(plan,null,2));console.log(JSON.stringify({products:products.length,definitions:definitions.length,manual:plan.review.manualReview,specifications:products.reduce((n,p)=>n+Object.keys(p.specs).length,0)}));
}
if(require.main===module)build(process.argv[2],process.argv[3]);
module.exports={build};
