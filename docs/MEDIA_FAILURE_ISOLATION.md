# Dodavanje slika: uzrok incidenta i ograničavanje posledica

## Oporavak prekinutih upload-a i konačan retry, 03.11.2026.

- Red izabranih fajlova i njihovi File blob-ovi čuvaju se u IndexedDB pregledača,
  odvojeno po admin korisniku i ID-u artikla/nacrta. Posle restarta taba upload se
  nastavlja istim media ID-jem; API izdaje novi kratkotrajan PUT URL. Bez mreže red
  čeka `online` događaj. Ako IndexedDB nije dostupan, upload se ne pokreće.
- Nezavršeni `pending_upload`, `uploaded` i `failed` image asset-i bez veze/noćnog
  posla čiste se nakon 24 h. Link-import šalje stabilan ID zahteva, pa ponavljanje
  posle izgubljenog odgovora vraća postojeću sliku umesto novog duplikata.
- Ako je API već završio upload, a tab se sruši, asset ostaje spreman, a IndexedDB
  zapis vraća ga u nacrt po media ID-ju. Njegov noćni posao ostaje trajan. Lease
  ističe posle prekida API procesa; sledeći tick ga ponovo preuzima.
- Brisanje artikla uklanja product-media reference i poziva `discardUnreferenced`
  u istoj SQL transakciji. Ako noćni enkoder već radi, završna transakcija zahteva
  važeći lease, postojeći ready asset i isti AVIF ključ, pa ne može oživeti obrisanu
  sliku.
- Derivative queue ima najviše 8 pokušaja. Posle osmog neuspeha posao je pauziran,
  ostaje vidljiv kao problem u admin kartici i čeka ručni retry. Taj retry resetuje
  brojač. Neuspeh zbog privremenog zauzeća/cutoff-a se i dalje odlaže bez lažne
  poruke; procesni crash se otkriva kroz istek lease-a.
- Svaki noćni pokušaj piše WebP fajlove pod jedinstvenim ključevima. Cleanup
  ponovo proverava DB reference i neuspeh R2 brisanja stavlja u trajni red.
  Migracije 101/102 dodaju retry limit i zaštitu od duplog URL importa. Provera je
  iz izvornog koda; testovi i deploy nisu pokretani.

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

## Dopuna: serijska obrada slika, 03.11.2026.

- Radnik moze da izabere/prevuce sve slike ili nalepi vise linkova; web salje
  samo jednu sliku do kraja obrade, ostale cekaju lokalno. Redosled, glavna slika,
  alt tekst, ponavljanje i blokada cuvanja dok postoje nezavrseni poslovi ostaju.
- API/worker koriste zajednicki Redis lease za ceo media postupak pre preuzimanja
  izvora. Jedan posao globalno; lokalno do cetiri cekajuca callback-a, najvise 20 s
  cekanja, pa 503 za ponavljanje. Nema cekanja u otvorenoj DB transakciji.
- Izvor se dekodira jednom u raster do 2048 px. WebP i AVIF ostaju na effort=4,
  WebP smartSubsample=true, kvalitet 75/65 i thumbnail 512 px. Po zahtevu korisnika
  nije uvedeno brze kodiranje koje bi uvecalo fajlove.
- Izolovani Linux enkoder radi u vremenskim prozorima 40/200 ms i sa nizim
  prioritetom, jednim threadom, bez Sharp cache-a. To nije cgroup/hard CPU limit.
  Gubitak lease-a prekida enkoder. BullMQ media concurrency je 1.
- Pozadinski catalog/bulk/supplier dispatcher ustupa API dok traje media posao.
  Catalog delivery cuva SQL projekciju migracijom 098, pa poziva Redis van
  transakcije i ponavlja preostali deo bez dupliranja DB projekcije.
- Logovi pokazuju 25P03 prekide idle transakcija; nije dokazano restartovanje
  samog PostgreSQL servera. CPU prosek od 5 minuta ne dokazuje niti iskljucuje
  kratki vrh od 90%. Nisu menjani Render planovi niti dodavani placeni servisi.
- Provera: TypeScript API/worker i web build; bez testova i provere deploy-a.

Istorijski pregled prethodne ispravke (02.11.2026):

Pregled izvornog koda: 02.11.2026. Prethodno pročitani Render logovi beleže
`Uncaught exception` sa kodom `25P03`; default `idle_in_transaction_session_timeout`
je 10 s. Ovo je izveštaj o izmenama koda, ne potvrda novog produkcijskog deploya.

## Uzrok

`BEGIN` i zaključavanje media_assets reda prethodili su Sharp/AVIF konverziji i
R2 pozivima. To nije SQL rad, pa je PostgreSQL mogao da prekine neaktivnu
transakciju usred konverzije. pg emituje `error` i na zauzetoj konekciji;
prethodni pool handler pokrivao je samo konekcije vraćene u pool. Neobrađeni
EventEmitter error stizao je do globalnog uncaughtException handlera koji
ispravno prekida proces umesto da nastavi rad u nepoznatom stanju. Propust je
bio opseg transakcije i neobrađen lokalni događaj, a ne sama zaštita PostgreSQL-a.

Hitni commit bc3266a skratio je transakcije i dodao obradu grešaka konekcije.
Dodatni pregled obuhvatio je upload, link import, glavnu sličicu, worker,
čuvanje proizvoda, promenu sluga, uklanjanje slike, rollback i web red fajlova.

## Dodatna zaštita

- Sharp/WebP/AVIF za ovaj tok radi u zasebnom Node procesu bez DB/R2 tajni.
  Abort, crash ili prekoračenje 45 s postaje greška konkretnog zahteva. Potproces
  ima JS heap limit 128 MB, jedan native thread i isključen Sharp cache.
- Najviše jedan enkoder i dva čekajuća posla po procesu; čekanje najviše 15 s.
  Najviše tri teška media HTTP zahteva pre preuzimanja buffer-a. Zauzetost vraća
  503 i Retry-After, bez zadržavanja konekcije baze.
- Najviše 25 MiB izvora, 24 miliona piksela i 12000 px po strani; animacije se
  odbijaju. Dimenzije se proveravaju pre dekodiranja. WebP i AVIF potiču direktno
  iz izvora; main ostaje do 2048 px, thumbnail do 512 x 512 uz očuvanje odnosa.
- Konverzija, R2 prenos i priprema glavne sličice obavljaju se pre BEGIN.
  Završne repository metode odbijaju nepripremljen upload, umesto sporog fallbacka
  unutar transakcije. Isto važi za PDF validaciju i pozadinski worker.
- R2 ima ograničene pokušaje, connection/request timeout i deadline za čitanje;
  direktan link ima i apsolutni deadline po preuzimanju uz postojeće SSRF provere.
- Ponovljeni complete za isti završen mediaId vraća isti rezultat. Web ponavlja
  taj korak najviše dvaput kod prolaznih grešaka, bez stvaranja nove slike.
- Cleanup posle neuspelog/ambivalentnog COMMIT-a proverava stvarne reference u
  bazi i ne briše potvrđene objekte. Ako baza nije dostupna, prednost ima čuvanje
  objekata; mogu ostati privremeni orphan objekti za naknadno čišćenje.
- Brisanje slike unutar transakcije samo upisuje tombstone i trajan R2 delete
  posao. MediaCleanupService obavlja mrežno brisanje izvan transakcije, sa leaseom
  i ponavljanjem posle prekida. Potrebna je migracija 097_media_storage_cleanup.
- Promena sluga više ne kopira R2 objekte tokom čuvanja proizvoda. Postojeći
  immutable URL-ovi ostaju ispravni; nove slike koriste novi slug prefiks.
- Greške i rollback kvarovi izbacuju oštećenu konekciju iz poola. Globalno gašenje
  na nepoznatom uncaughtException ostaje; namerno nije uvedeno ignorisanje svih
  izuzetaka koje bi moglo da prikrije oštećeno stanje aplikacije.

## Web

Dve slike mogu se otpremati paralelno i može se dodavati još fajlova dok to traje.
CPU konverzije se kontrolišu na serveru. Red čuva originalni raspored i glavnu
sliku, pokazuje neuspeh i omogućava ponovni pokušaj/uklanjanje. Save ostaje
blokiran dok postoje nezavršene slike. Prethodno ograničenje paralelizma na jedan
bilo je hitna mera; uklonjeno je nakon izdvajanja enkodera. Ne postoji limit od
dve slike po proizvodu. Prethodna ispravka refs sprečava da lokalni status render
prepiše novu listu slika starim roditeljskim props-ima.

## Granice provere

Pokrenuta je TypeScript kompilacija API-ja i workera i web produkcijski build.
Testovi i simulacije kvarova nisu pokretani prema korisnikovom uputstvu.
Nije čekan završetak deploya niti potvrđen upload na novoj produkcijskoj verziji.
Zaseban proces deli host/container RAM i bazu sa API-jem: ovo nije potpuna izolacija
posebnim Render servisom i ne garantuje odsustvo svih infrastrukturnih kvarova.
Za dodatnu izolaciju od ukupnog container OOM-a potreban je zaseban media servis
sa sopstvenim resursima i trajnim asinhronim protokolom. Time se ovde nisu menjali
cloud planovi niti dodavali troškovi.
