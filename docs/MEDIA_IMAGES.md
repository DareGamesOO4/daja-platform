# Slike proizvoda — AVIF i WebP

## Dopuna: admin obavestenja o slikama, 03.11.2026.

- Admin dashboard ima sklopivi panel Slike i obavestenja na svim svojim karticama.
  Nova poruka otvara i plutajuce obavestenje sa dugmetom Pogledaj poruke.
  Brojac novih poruka, problemi, nocni red i istorija prikazuju proizvod/sliku,
  bezbedan opis greske, vreme, pokusaje i stanje. Velika AVIF ostaje preview dok
  nocni posao ceka. Panel osvezava podatke na 30 s samo dok je stranica vidljiva.
- Migracija 100_media_processing_alerts cuva greske i oznake procitanog po korisniku.
  Nova greska iste slike ponovo postaje neprocitana. I automatski resene greske
  ostaju u istoriji i broje se kao nove dok ih korisnik ne procita. Istekao lease
  posle restarta se prijavljuje pri sledecem otvaranju/osvezavanju admina.
- API /admin/media-processing: summary/list/read, zakazivanje ponovnog pokusaja,
  prijava neuspelog prenosa i zatvaranje poruke za neuspesan pocetni upload.
  Citanje zahteva catalog.read; retry/close/report zahtevaju media.upload.
  Sve je ograniceno na organizaciju; retry i zatvaranje beleze se u auditu.
- Retry samo vraca sacuvani nocni posao u red za 03:00-07:00 Europe/Belgrade;
  ne uvodi paralelne enkodere niti obradu dodatnih verzija usred dana.
  Ako pocetni prenos nema sacuvan izvor, poruka vodi na proizvod za novo dodavanje.
- Pune exception poruke, potpisani R2 URL-ovi, izvorni URL i tajne ne izlaze u inbox.
  Uspeh/uklanjanje zatvara nocnu gresku; neuspesan privremeni upload ostavlja
  obavestenje i posle cleanup-a dok ga korisnik ne zatvori. Zatvaranje poruke
  ne oznacava sliku kao uspesno obradjenu. Slanje email/SMS/WhatsApp poruka nije dodato.
- Provera: TypeScript API/worker i web build; bez testova i provere deploy-a.

## Dopuna: velika AVIF odmah, preostala tri fajla nocu, 03.11.2026.

- Ova dopuna zamenjuje prethodnu sinhronu izradu cetiri verzije za nove slike.
  Upload/link uvoz odmah generise samo veliki AVIF (do 2048 px, quality 65,
  effort 4). Taj URL se koristi i za preview/thumbnail dok ostatak nije spreman.
- Migracija 099_media_derivative_jobs dodaje trajan posao po media asset-u.
  Izvorni fajl ostaje u R2 do zavrsetka reda, bez blob-ova u PostgreSQL-u.
- API MediaDerivativesService radi svakog dana od 03:00 do 07:00 u vremenskoj
  zoni Europe/Belgrade (automatski letnje/zimsko vreme). Generise tacno tri
  preostala fajla: veliki WebP, mali WebP i mali AVIF. Ne kodira ponovo veliki AVIF.
- Jedan globalni Redis lease deli se sa interaktivnim uploadom; jedan posao
  odjednom, bez cekanja/konverzije u DB transakciji i bez novog placenog servisa.
  U 07:00 prekida se aktivno kodiranje; nezavrseni posao nastavlja sledece noci.
- SQL lease/ponavljanje obnavljaju red posle restarta/greske. Brisanje slike uklanja
  i njen posao/izvor. Naknadni worker ne vraca obrisane slike u katalog.
- Tek kada su tri fajla upisana u R2, kratka transakcija objavljuje komplet,
  osvezava korpu/listu zelja i upisuje trajno osvezavanje kataloga/sync-a.
  Originalni AVIF URL ostaje validan; privremeni izvor brise postojeci cleanup red.
- Kompresija ostaje WebP 75 / AVIF 65, effort 4 i WebP smartSubsample=true.
  Ne koristi se brze kodiranje koje bi povecalo izlazne fajlove. Postojece slike
  nisu masovno ponovo kodirane. Privremeno se zadrzava vise izvornih fajlova u R2.
- Provera: API/worker TypeScript i web build; bez testova ili provere deploy-a.

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
