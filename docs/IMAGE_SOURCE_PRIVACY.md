# Provera javnog otkrivanja izvora fotografija — 01.11.2026.

## Rezultat pre ispravke

Izvor fotografije može da se otkrije za deo kataloga. Prethodna tvrdnja da je izvor samo u internim metapodacima slike bila je previše uska: taj metadata.sourceUrl nije vraćen, ali postoje drugi javni putevi.

- Pročitan ceo javni spisak: 1.740 artikala kroz 35 stranica. Svih 3.027 navedenih glavnih/galerijskih URL-ova slika koriste cdn.dajashop.rs.
- 558 artikala vraća `_catalog_import`: 509 daljinskih i 49 baterija. Sadrži dobavljačke URL-ove, izvorne fotografije i interne podatke o uvozu. Kod baterija je vidljiv konkretan izvorni URL fotografije.
- Detalji: uzorak od 98 odeljaka/brendova; 93 odgovora sadrže dobavljačke linkove. Detalj proizvoda dodatno vraća external_id (npr. prefiks LINKEL), kao i nepotrebna interna operativna polja.
- HTML: 10 stranica, 8 sadrži dobavljačke linkove u javno ugrađenim podacima. Google ili korisnik mogu da ih pročitaju i bez admin naloga.
- Slike: uzorak od 100 javnih fajlova, svi HTTP 200. Nema EXIF/IPTC/XMP blokova ni prepoznatih dobavljačkih linkova u njihovim HTTP zaglavljima. Nije vizuelno pregledana svaka fotografija niti potvrđeno da nigde nema vodenog žiga.
- Sitemap: HTTP 200, bez prepoznatih dobavljačkih linkova. Merchant feed: HTTP 200, tri opisa sadrže Bultime. Robots: bez dobavljačkih linkova.
- Četiri proverene admin/API rute za dobavljače, katalog i medije vraćaju 401 bez prijave.
- Pregledan CDN worker: služi sopstvene R2 objekte i HTTP metapodatke; ne dodaje DB metadata.sourceUrl niti R2 customMetadata u javna zaglavlja. Server preuzima original kod uvoza, kupac ne ide na originalni URL.

## Ispravka izvornog koda

Javni katalog izbacuje `_catalog_import`, `supplier_sku` i eksplicitna source/supplier URL polja iz atributa i varijanti. Detalj artikla koristi izričit spisak javnih polja umesto p.*, pa external_id i interni podaci o osoblju/odobrenjima ne izlaze u odgovor. Nova verzija ključa keša detalja zaobilazi stare odgovore; invalidacija obuhvata oba ključa.

Ova ispravka ne menja interne podatke u bazi niti briše trag uvoza. Ne uklanja ranije preuzete ili indeksirane podatke. Push koda nije potvrda izvršenog produkcijskog deploy-a; završetak deploy-a se po uputstvu ne proverava. Tri opisa ispod nisu menjana u produkciji.

## Preostali sadržaj u opisima

- DANIEL KLEIN DK12640-6: https://dajashop.rs/product/dk12640-6
- DANIEL KLEIN DK12322-5: https://dajashop.rs/product/dk12322-5
- DANIEL KLEIN DK12253-4: https://dajashop.rs/product/dk12253-4

DK12640-6 ima zaostali tekst sa Google favicon URL-om za bultime.bg i nazivom domena. DK12322-5 i DK12253-4 u rečenici eksplicitno navode Bultime. To je sadržaj opisa, odvojeno od curenja internih metapodataka.

## Šta se ne može garantovati

Google Lens i druge vizuelne pretrage mogu pronaći druge sajtove sa istom ili sličnom fotografijom. To ne dokazuje sa kog sajta je konkretno preuzeta, ali omogućava povezivanje. Dobavljač takođe može imati sopstveni zapis preuzimanja; ovi zapisi nisu proveravani. Ne može se garantovati da niko ne može zaključiti poreklo javno objavljene fotografije.

## Obim i validacija

Provera je read-only nad produkcijom i statički pregled odgovarajućeg koda. TypeScript provera je prošla; testovi nisu pokretani. Ceo javni katalog i feed su obuhvaćeni, detalji, HTML i binarni fajlovi su uzorak navedenog obima. Ne predstavlja dokaz da je proverena svaka stara kopija fajla, privatno skladište ili Google-ov raniji indeks.

## Dopuna: četiri formata i interni prikaz izvora

Za javne odgovore uvedeno je rekurzivno čišćenje privatnih atributa i tekstova,
uključujući prevode i merchant feed. Tri ranije navedena opisa sada se čiste pri
javnom prikazu; original je očuvan u bazi. Nova verzija ključeva keša zaobilazi
stare odgovore. URL sourceUrl i originalFilename ostaju samo u internoj bazi; po naknadnoj
korisnikovoj instrukciji nije dodat novi admin prikaz ni endpoint polje za izvor.

Proširena read-only provera obuhvatila je svih 6.054 URL-a slika iz javnog
kataloga: svi HTTP 200, bez EXIF/IPTC/XMP blokova ili prepoznatih dobavljačkih
URL-ova u HTTP zaglavljima. Ovo ne tvrdi da je pregledan svaki napušteni R2
objekat ili ranije preuzeta/indeksirana kopija. Deploy nije proveravan.
