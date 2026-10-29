// Human-edited Serbian introductions. Retain each source limitation in the lead.
function firstParagraph(product,specs,count){
  const id=product.externalId.replace('LINKEL-',''),s=specs,model=s.model_baterije,capacity=s.kapacitet_baterije;
  const silver={7822:['SR927SW','395','SR57','AG7/LR927'],7828:['SR41W','392','SR41','AG3/LR41'],7829:['SR626SW','377','SR66','AG4/LR626'],7830:['SR920SW','371','SR69','AG6/LR920'],7831:['SR621SW','364','SR60','AG1/LR621']}[id];
  if(silver){const[m,n,short]=silver;return `NEXcell ${m} / ${n} srebro-oksidne baterije za satove, 1,55 V. Pakovanje: ${count} komada. Zamenska oznaka: ${short}. Proveriti oznaku i zahteve uređaja pre zamene.`;}
  if(/^CR\d{4}$/.test(model||''))return `NEXcell ${model} litijumske dugmaste baterije od 3 V za kompatibilne ključeve, daljinske i elektroniku. Pakovanje: ${count} komada. Proveriti tačnu CR oznaku.`;
  if(id==='8197')return 'NEXcell CR11108 / CR1/3N / 2L76 litijumske baterije od 3 V za kompatibilnu elektroniku, format 1/3N. Pakovanje: 5 komada. Proveriti oznaku i kontakte.';
  if(['7841','7842','7843','7844','7845','7846','7847','7851'].includes(id)){
    const names={LR03:['AAA','MN2400, E92 i LR03N'],LR6:['AA','MN1500, E91 i LR6N'],LR14:['C','MN1400, E93 i LR14N'],LR20:['D','MN1300, E95 i LR20N']}[model];
    return `NEXcell ${model} ${names[0]} alkalne baterije od 1,5 V za uređaje koji koriste ovaj format. Pakovanje: ${count} komada. Druge oznake: ${names[1]}. Proveriti polaritet.`;
  }
  if(['8192','8193','8195','8432'].includes(id)){
    const [size,color]={8192:['13 / A13','Narandžasta'],8193:['10 / A10','Žuta'],8195:['675 / A675','Plava'],8432:['312 / A312','Braon']}[id];
    return `NEXcell ${model} / ${size} cink-vazduh baterije za slušne aparate, 1,4 V. Pakovanje: 6 komada. ${color} oznaka za izbor odgovarajuće veličine baterije.`;
  }
  if(['7848','7850'].includes(id))return `NEXcell ${s.format_baterije} punjive Ni-MH baterije od 1,2 V i ${capacity} za kompatibilne uređaje. Pakovanje: 2 komada. Koristiti odgovarajući Ni-MH punjač za baterije.`;
  if(['8203','8204'].includes(id))return `NEXcell punjiva Ni-MH baterija formata 9V, nominalno 8,4 V, kapacitet ${capacity}. Cena za jedan komad. Za kompatibilne uređaje i odgovarajući Ni-MH punjač.`;
  if(['8198','8199'].includes(id))return `NEXcell ${model} Li-SOCl₂ baterija od 3,6 V i ${capacity}, format ${s.format_baterije}. Za kompatibilnu industrijsku elektroniku. Cena za jedan komad. Baterija nije punjiva.`;
  if(['7824','7825'].includes(id))return `NEXcell ICR18650 punjiva Li-ion baterija, 3,6 V, ${capacity}. Ćelija formata 18650 za kompatibilne uređaje. Cena za jedan komad. Proveriti kontakte i punjač.`;
  if(['8205','8206','8207'].includes(id))return `NEXcell ${model} olovni VRLA AGM akumulator, ${s.napon_baterije}, ${capacity}, bez dolivanja elektrolita. Cena za jedan komad. Proveriti napon, dimenzije i priključke pre zamene.`;
  const custom={
    7819:'NEXcell 6LR61 alkalna baterija od 9 V za kompatibilne uređaje. Zamenske oznake: 6LF22, MN1604, 522 i A1604. Cena za jedan komad. Baterija nije punjiva.',
    7820:'NEXcell 23A / A23 alkalna baterija od 12 V za kompatibilne daljinske upravljače. Druge oznake: LR23A, MN21 i V23GA. Cena za jedan komad. Nije punjiva.',
    7821:'NEXcell 27A / A27 alkalna baterija od 12 V za kompatibilne daljinske upravljače. Druge oznake: LR27A, MN27 i GP27A. Cena za jedan komad. Nije punjiva.',
    7823:'NEXcell 14500 punjiva Li-ion baterija od 800 mAh za kompatibilne uređaje. Na ćeliji piše 3,7 V. Cena za jedan komad. Nije zamena za običnu AA bateriju.',
    7826:'Punjiva Li-Po baterija 702030 za kompatibilnu elektroniku. Cena za jedan komad. Kapacitet i napon proveriti pre kupovine: oznake dobavljača se razlikuju.',
    7827:'Punjiva litijumska baterija, šifra 852657, za ugradnju u kompatibilnu elektroniku. Cena za jedan komad. Model i kapacitet potrebno je potvrditi pre kupovine.',
    7832:'NEXcell LR44 / AG13 / A76 alkalne dugmaste baterije od 1,5 V za kompatibilne male uređaje. Pakovanje: 5 komada. Druge oznake: V13GA, LR1154 i SB-F9.',
    7849:'NEXcell AA punjive Ni-MH baterije od 1,2 V za kompatibilne uređaje. Pakovanje: 2 komada. Tačan kapacitet proveriti pre kupovine jer se podaci razlikuju.',
    8196:'NEXcell 3R12 Heavy Duty cink-ugljenična baterija od 4,5 V, pljosnatog oblika, za kompatibilne uređaje. Cena za jedan komad. Nije predviđena za punjenje.',
    8200:'NEXcell ER17505 Li-SOCl₂ baterija od 3,6 V za kompatibilnu industrijsku elektroniku. Cena za jedan komad. Kapacitet potvrditi pre kupovine. Nije punjiva.',
    8201:'Punjiva Li-Po baterija 752540 od 750 mAh za kompatibilnu elektroniku. Na ćeliji piše 3,7 V / 2,775 Wh. Cena za jedan komad. Proveriti izvode i punjač.',
    8202:'Punjiva Li-Po baterija, šifra 903050/3.6, kapacitet 1200 mAh. Cena za jedan komad. Tačan model i napon potvrditi pre kupovine zbog razlike u oznakama.',
  }[id];
  if(!custom)throw Error('Missing reviewed introduction '+id);return custom;
}
module.exports={firstParagraph};
