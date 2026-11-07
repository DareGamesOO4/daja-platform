# DAJA lokalni worker za slike

Paket koristi instalirani Node.js 22.12 ili noviji i uključuje Sharp za Windows x64.

Raspakuj paket u folder u kom će aplikacija ostati i otvori DAJA Worker.exe. Kada zatvoriš prozor, ikonica ostaje pored sata. Desni klik otvara meni, a levi vraća prozor. Opcija za automatsko pokretanje dodaje ikonicu pri prijavi u Windows.

DAJA Studio prikazuje status veze i red poslova sa sličicama. U profilu podešavaš kvalitet, effort, maksimalnu dimenziju, lossless i obradu boje za svaki od četiri izlaza. Lokalna proba koristi trenutna podešavanja i prikazuje dimenzije, veličinu fajla, uštedu i trajanje obrade. Dugme „Sačuvaj profil” primenjuje podešavanja na naredne poslove Windows workera pokrenutog iz aplikacije, a pauza mu dozvoljava da završi trenutni posao pre nego što prestane da preuzima nove. Zaseban Windows servis koristi podrazumevani profil.

U raspakovanom folderu otvori PowerShell i pokreni lokalnu obradu. Izlazni folder mora da bude nov.

~~~powershell
node .\worker.mjs local 'C:\putanja\original.jpg' 'C:\putanja\nove-verzije'
~~~

Dobijaš veliki AVIF (kvalitet 95), mali AVIF (65) i dve WebP verzije (75). Velika slika ima do 2048 px, sličica do 512 px. Obrada čuva proporcije i manje originale ostavlja u njihovoj rezoluciji.

Za pokretanje pre prijave u Windows otvori PowerShell kao administrator i pokreni instalaciju iz raspakovanog foldera. Unesi ključ kad se pojavi upit.

~~~powershell
.\install-local-image-worker.ps1 -ApiBaseUrl 'https://api.dajashop.rs/api/v1'
~~~

Instalater registruje zadatak koji radi kao Windows Local Service od paljenja računara i pokreće ga odmah. Program i ključ čuva u folderu DajaImageWorker u ProgramData. Pristup folderu imaju Local Service, SYSTEM i administratori.

## Ugovor za backend

Worker poziva HTTPS rute uz Authorization Bearer sa namenskim ključem. Backend aktivira lokalni red za javnu organizaciju kada je podešen MEDIA_LOCAL_WORKER_TOKEN_HASH kao SHA-256 ključa u heksadecimalnom formatu. Kad radnik unese URL u web admin, backend preuzima izvor, čuva ga u R2 i stavlja u isti red kao i otpremljeni fajl proizvoda.

- POST /media/local-worker/claim prima JSON sa poljem profile jednakim avif95-v1. Vraća 204 kad nema posla. Za posao vraća id i leaseToken kao UUID, expiresAt kao ISO UTC, source sa url i sha256, i uploads sa potpisanim R2 PUT linkovima za avif, webp, avifThumb i webpThumb.
- POST /media/local-worker/queue prima page počevši od 0. Vraća do osam poslova, njihov status i kratkotrajne R2 linkove iz kojih Windows aplikacija pravi sličice.
- Worker koristi potpisan HTTPS R2 GET za original i proverava SHA-256. PUT šalje Content-Type formata, If-None-Match sa vrednošću * i Cache-Control public, max-age=31536000, immutable. Server zadržava postojeći format ključeva proizvoda sa jedinstvenom revizijom po pokušaju.
- POST /media/local-worker/complete prima id, leaseToken i files. Svaki element files ima variant, width, height, bytes i sha256. Kad claim vrati customSizes, element može da sadrži i maxSize koji backend koristi pri proveri proporcija i dimenzija. Backend proverava rezultate u R2 i objavljuje ih zajedno.
- Ako posao ne bude potvrđen, ostaje u redu. Posle sedam dana isti posao može da preuzme postojeća Render obrada od 03:00 do 07:00 po vremenu u Srbiji. Lokalni komp ima prednost dok se javlja i može da preuzme posao.

Za pakovanje iz izvora pokreni scripts/package-local-image-worker.ps1 iz Windows x64 checkouta sa instaliranim zavisnostima.
