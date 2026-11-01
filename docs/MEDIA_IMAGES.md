# Slike proizvoda — AVIF i WebP

Od 01.11.2026. svaki novi unos fotografije pravi četiri fajla iz istog ulaza:

| Format | Velika | Mala | Kvalitet |
|---|---|---|---|
| AVIF | do 2048 × 2048 px | do 512 px širine | 65 za obe |
| WebP | do 2048 × 2048 px | do 512 px širine | 75 za obe |

Proporcije ostaju iste, manje slike se ne uvećavaju. Sharp effort je 4; WebP
koristi smartSubsample. EXIF, IPTC, XMP i ostali izvorni metapodaci ne kopiraju se.
`prepareProductImageVariants` je zajednički ulaz u `packages/database/src/media-images.ts`.
Svaki format nastaje iz istog ulaza, bez konverzije AVIF-a nazad u WebP.

## Načini dodavanja

- `POST /media/external`: server preuzima izvorni fajl i registruje sve četiri verzije.
- Potpisani upload sa računara: PUT originala, zatim `POST /media/uploads/:id/complete`.
  Odgovor stiže kada su četiri verzije spremne; nema zavisnosti od pozadinskog worker-a.
- XLSX i Firestore execute: svaki URL fotografije ide kroz isti bezbedni downloader i procesor.
  Ako uvoz ne uspe, novo registrovane nevezane slike uklanjaju se posle rollback-a.
- Priprema kataloških paketa: `scripts/prepare-catalog-media.ts` podrazumevano pravi AVIF65
  i WebP75 parove i navodi sve četiri datoteke u manifestu. Linkel uvoznici preuzimaju
  polazni fajl iz manifesta i koriste zajednički procesor umesto starih AVIF60/65 parova.
- Worker za ranije zakazane poslove koristi isti procesor. PDF ostaje dokument.

## Adrese i prikaz

Kanonijska adresa u bazi ostaje velika WebP slika, radi kompatibilnosti postojećih
klijenata, računa, mailova i aplikacije. Novi nazivi završavaju se sa
`-avif65-webp75-main.webp`, `-avif65-webp75-thumb.webp` i odgovarajućim `.avif`
imenima. Marker je ugovor da postoji komplet od četiri fajla; stari URL-ovi bez
markera ne dobijaju izmišljene AVIF adrese.

Web koristi `<picture><source type="image/avif">…<img …webp></picture>`, pa browser
bira format bez kolačića ili prepoznavanja korisnika. Katalog koristi mali par,
galerija veliki, a povezani proizvodi, pretraga, korpa i početni prikazi koriste isti
mehanizam. U slučaju neispravnog AVIF odgovora UI prelazi na odgovarajući WebP.
Pozadinsko preuzimanje takođe koristi picture izbor da ne zagreva pogrešan format.

Sva tri izvedena fajla evidentirana su u `media_derivatives`, velika WebP u
`media_assets`. Migracija 094 dopušta više formata iste širine i male izvore gde
su dimenzije velike i male verzije jednake. Brisanje i premeštanje obuhvataju sva
četiri fajla. Originalni privremeni upload briše se tek posle DB commit-a; pri
rollback-u brišu se novonastali objekti. Neuspeh naknadnog brisanja beleži se u logu.

## Privatnost izvora

`metadata.sourceUrl`, originalni naziv i trag uvoza ostaju u internoj bazi.
Po korisnikovom izboru nije dodat novi prikaz izvora u adminu niti API polje
za njegovo lako otvaranje. Javni odgovori
uklanjaju podatke o poreklu, interne `_` atribute osim prevoda i dobavljačke URL-ove
u javnom tekstu. Opisi tri ranije pronađena DK artikla čiste se pri javnom prikazu,
uključujući merchant feed; izvorni tekst ostaje sačuvan u internoj bazi.
CDN prosleđuje samo potrebna zaglavlja generisanog sadržaja, bez originalnog naziva
ili custom metapodataka. Promene keša detalja i merchant feed-a zaobilaze stare
serverske odgovore. Ranije sačuvane kopije ili Google-ov istorijski indeks ne mogu
se opozvati ovom izmenom. Vizuelno prepoznavanje iste fotografije ostaje moguće.

Postojeći katalog nije masovno prekodiran. Novi URL-ovi i uvozi koriste ovu politiku;
prelazak starih slika zahteva zasebnu migraciju sa popisom, rezervnom kopijom i
invalidacijom odgovora koji čuvaju stare adrese.

Pregled starih javnih fajlova 01.11.2026: svih 6.054 URL-a (3.027 velikih i njihovih malih verzija) iz javnog kataloga uspešno je preuzeto; nijedan nema EXIF/IPTC/XMP blokove niti prepoznat dobavljački URL u HTTP zaglavljima. Pregled ne uključuje napuštene fajlove koji nisu navedeni u javnom katalogu.
