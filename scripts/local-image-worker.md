# DAJA lokalni worker za slike

Paket koristi instalirani Node.js 22.12 ili noviji i uključuje Sharp za Windows x64.

Raspakuj paket u folder u kom će aplikacija ostati i otvori DAJA Worker.exe. Iz prozora biraš sliku, folder za rezultate i kvalitet velikog lokalnog AVIF-a. Kada zatvoriš prozor, ikonica ostaje pored sata. Desni klik otvara meni, a levi vraća prozor. Opcija za automatsko pokretanje dodaje ikonicu pri prijavi u Windows.

Status u prozoru prikazuje vezu i poslednju obradu kada se pozadinski worker poveže sa serverom. Podešavanje kvaliteta u prozoru važi za slike koje obradiš ručno. Za poslove sa servera koristi se profil avif95-v1.

U raspakovanom folderu otvori PowerShell i pokreni lokalnu obradu. Izlazni folder mora da bude nov.

~~~powershell
node .\worker.mjs local 'C:\putanja\original.jpg' 'C:\putanja\nove-verzije'
~~~

Dobijaš veliki AVIF (kvalitet 95), mali AVIF (65) i dve WebP verzije (75). Velika slika ima do 2048 px, sličica do 512 px. Obrada čuva proporcije i manje originale ostavlja u njihovoj rezoluciji.

Kad backend dobije rute za lokalni worker i izda ključ, iz raspakovanog foldera u PowerShell-u otvorenom kao administrator pokreni instalaciju. Unesi ključ kad se pojavi upit.

~~~powershell
.\install-local-image-worker.ps1 -ApiBaseUrl 'https://api.dajashop.rs/api/v1'
~~~

Instalater registruje zadatak koji radi kao Windows Local Service od paljenja računara i pokreće ga odmah. Program i ključ čuva u folderu DajaImageWorker u ProgramData. Pristup folderu imaju Local Service, SYSTEM i administratori.

## Ugovor za backend

Worker poziva HTTPS rute uz Authorization Bearer sa namenskim ključem. Na serveru ove rute tek treba implementirati. Kad radnik unese URL u web admin, backend treba da preuzme izvor sa tog URL-a, sačuva ga u R2 i preda ga istom redu kao i lokalno otpremljeni fajl. Radnik koristi postojeći unos linka na svom uređaju.

- POST /media/local-worker/claim prima JSON sa poljem profile jednakim avif95-v1. Vraća 204 kad nema posla. Za posao vraća id i leaseToken kao UUID, expiresAt kao ISO UTC, source sa url i sha256, i uploads sa potpisanim R2 PUT linkovima za avif, webp, avifThumb i webpThumb.
- Worker koristi potpisan HTTPS R2 GET za original i proverava SHA-256. PUT šalje Content-Type formata i Cache-Control public, max-age=31536000, immutable. Backend treba da izdaje jedinstvene ključeve objekata za svaki pokušaj.
- POST /media/local-worker/complete prima id, leaseToken i files. Svaki element files ima variant, width, height, bytes i sha256. Backend treba da proveri rezultate u R2, potvrdi isti pokušaj bez dupliranja i tek onda objavi slike.
- Ako posao ne bude potvrđen, backend ga po isteku rezervacije može vratiti u red ili kodirati na Renderu. Ključ treba da bude ograničen na ovaj red i organizaciju.

Za pakovanje iz izvora pokreni scripts/package-local-image-worker.ps1 iz Windows x64 checkouta sa instaliranim zavisnostima.
