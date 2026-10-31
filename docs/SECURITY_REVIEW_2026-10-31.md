# DAJA — bezbednosni pregled i izmene, 31.10.2026.

## Rezultat i granice

Pregledani su bezbednosno važni tokovi u RFIDDaja, daja-platform i dajashopweb, uz pretragu izvora, kontrolu zavisnosti i read-only pregled odabranih Cloudflare podešavanja. Ugrađene su konkretne zaštite opisane ispod. Ovo nije potvrda da je svaki red koda, svaki endpoint i svaka cloud dozvola detaljno proverena, niti garancija otpornosti na svaki napad.

Po zahtevu korisnika nisu pokretani testovi, pentest, napadi, opterećenje produkcije ni provera završetka deploya. Kompilacija i build navedeni su zasebno od funkcionalne provere. Produkcijsko ponašanje novih izmena nije potvrđeno. Android uređaj nije povezan (`adb devices` je vratio prazan spisak); instalacija je preskočena.

## Model pretnji

Štite se nalozi, prava zaposlenih, podaci kupaca i porudžbina, katalog/zalihe, tokeni i resursi servera/uređaja. Napadač može da šalje HTTP/WebSocket zahteve, menja zaglavlja i tela zahteva, koristi više IP adresa ili običan nalog. Granice poverenja su browser/native bridge → API, kupac → zaposleni, organizacija/lokacija → tuđi podaci i internet → obrada medija/pluginova.

Osnovni zahtevi: identitet i dozvole određuje server; klijent ne određuje konačnu cenu ili tuđeg vlasnika podataka; ponovljeni i paralelni zahtevi ne smeju nekontrolisano trošiti memoriju, računarske resurse ili jednokratne kodove.

## Ugrađene izmene

| Oblast / izvor | Nalaz i promena |
|---|---|
| Platform `runtime/configure-app.ts`, `auth.middleware.ts` | Postojeći Nest limiter radi posle middleware autentikacije. Dodata je ranija kontrola pre parsiranja tela i pristupa bazi: ukupno 6.000 zahteva/min po procesu, 1.200/min po IP/IPv6 /64, najviše 64 aktivna HTTP odgovora i 16 po mrežnoj adresi. Brojači imaju ograničen kapacitet. Health ima zaseban budžet 300/min po procesu i 60/min po mrežnoj adresi. Ovo su lokalne zaštite, ne zamena za mrežni DDoS sloj. |
| Platform `health.controller.ts` | Javni readiness je za svaki poziv pristupao bazi/Redis-u. Sada deli rezultat između paralelnih provera, pamti ga 2 s i ima rok odgovora 2 s. Dok prethodna provera čeka Redis, ne dodaje novi isti posao. Health ne obrađuje nepotreban bearer token kroz staff autentikaciju. |
| Platform `app.module.ts` | Uklonjena je mogućnost dobijanja dodatnog staff budžeta promenom registrovanog uređaja. Staff limiter prati organizaciju i korisnika; anonimne IPv6 adrese grupišu se po /64. |
| Platform `login-attempts.ts`, oba auth servisa | IP limiter nije štitio isti nalog od zahteva sa više adresa. Dodat je atomski Redis budžet od 20 pokušaja lozinke za nalog u 15 minuta, zajednički za API instance i sve identitete koji se razreše na isti nalog. Broje se i uspešni pokušaji. Redis ključevi koriste sažetak identifikatora. Pri nedostupnom Redis-u prijava vraća 503; zaštita se ne isključuje. |
| Platform `password-work.ts` | Najviše dve paralelne Argon2 operacije po API procesu; višak dobija 503 bez neograničenog reda. Obuhvaćeni su staff/customer auth i heširanje kroz sync projektor. |
| Platform `phone-otp.service.ts` | Potvrđen race: odvojeni GET/SET/DEL mogao je izgubiti broj pogrešnih pokušaja ili dvaput prihvatiti isti SMS kod. Lua operacija sada atomarno proverava HMAC, povećava broj pokušaja i troši kod. Posle pet grešaka kod se briše; preostalo trajanje se ne produžava. |
| Platform `realtime.gateway.ts` | HTTP guard ne ograničava Engine.IO/WebSocket. Dodati su budžet 600 novih transporta/min, najviše 320 otvorenih transporta, 256 prihvaćenih namespace veza, 16 paralelnih autentikacija, 60 ulaznih aplikativnih poruka/min po vezi, ulazna poruka do 16 KiB i vreme povezivanja 10 s. Postojeće provere prava i revokacije sesija ostaju. |
| Platform `main.ts`, DB `pool.ts`, security `jwt.ts` | Dodati su HTTP request/header/keep-alive rokovi 30/15/5 s, najviše 60 zaglavlja, čekanje DB konekcije do 5 s i odbijanje JWT dužeg od 8 KiB pre obrade. Postojeći statement/transaction rokovi su zadržani. |
| Platform `storefront.controller.ts` | Kreiranje porudžbina i recenzija dodatno ograničeno na pet zahteva/min po postojećem tracker-u, radi smanjenja automatizovanog upisa i email opterećenja. To ne potvrđuje da je korisnik čovek. |
| Web `src/ssr/worker.js`, `loadPage.js` | SSR odbija URL duži od 4.096 znakova i više od 40 query parametara pre poziva API-ju. Dodato kratko keširanje uspešnih anonimnih listing/filter/variant odgovora, najviše 30 s, uz skraćivanje za poznat istek akcijskih cena. Keš ključ sadrži celu API putanju i query. Privatni podaci se ne učitavaju ovim putem. |
| Web OAuth proxy | Ka Google callback API-ju više se ne prosleđuju browser cookies/Authorization i ne prati se backend redirect u Worker-u. Browser dobija originalni redirect. Callback i XML proxy pozivi imaju rok od 10 s. |
| RFID `packages/contracts/src/api-url.ts`, sync klijenti | Mobile/PWA sync je ranije normalizovao adresu bez iste HTTPS provere koju je imao glavni mobile klijent. Sada koriste zajedničku proveru: HTTPS van lokalnog razvoja, bez ugrađenih kredencijala, query-ja i fragmenta. HTTP ostaje dozvoljen samo za navedene loopback hostove. |
| RFID desktop i Android Google bridge | Adresa dobijena od servisa pre otvaranja sada mora biti tačna Google HTTPS autorizaciona putanja, bez userinfo i nestandardnog porta. Desktop više ne prosleđuje proizvoljnu šemu iz servisnog odgovora u `shell.openExternal`. Ovo je dodatna kontrola granice poverenja; nije dokaz da je napadač već kontrolisao taj odgovor. |
| RFID mobile build | Dodata produkcijska CSP politika koja ograničava izvršavanje skripti na sopstvene resurse i zabranjuje objekte/iframe-ove. Razvojni Vite režim je izuzet. Native bridge zahteva sopstvene provere jer browser CSP ne kontroliše native mrežne pozive. |
| RFID Android `DajaHttpPlugin.java` | Odgovor se čita u ograničenim blokovima umesto neograničenog `readLine()`: najviše 32 MiB, sa dodatnom proverom proteklog vremena čitanja. TLS URL odbija userinfo/fragment. Postojeći connect/read timeout i zabrana automatskih redirect-a ostaju. |
| RFID zaseban server | Brojači neuspelih prijava sada ističu i imaju kapacitet 10.000 identiteta; ranije su i pojedinačne greške mogle ostati trajno u memoriji. Argon2 rad ograničen na dve paralelne operacije. `/events` dobija ulazni limit poruke 16 KiB i vreme povezivanja 10 s. To nije potvrda da se ovaj zaseban server izvršava u produkciji. |

## Pregled postojećih kontrola i odbačene sumnje

| Kandidat | Rezultat izvornog pregleda |
|---|---|
| Lažni organization/user/permission HTTP header-i | Pregledani `resolveRequestContext` i middleware zahtevaju autentikovan kontekst van izričito dozvoljenog development/test režima. Nije potvrđen novi bypass tim putem. |
| Cene i popusti koje pošalje browser | Pregledani `createOrder` tok ponovo određuje korpu kroz `priceCart`/promocije i računa dostavu na serveru. Sam unos proizvoljnog subtotal-a nije potvrđena manipulacija konačnom cenom. |
| Pristup reader scan/find/station sobama | Pregledani handler-i proveravaju organizaciju i vlasnika sesije/uređaja u bazi. UUID sam nije jedina kontrola. |
| Staff privilegije preko storefront Google prijave | Pregledani tok traži Google auth metod, aktivan Google identitet i server-side pravila. Frontend spisak email adresa nije samostalna dozvola. |
| SSRF preko udaljenih slika | Pregledani downloader proverava javne adrese i redirect-e, vezuje mrežni zahtev za proverenu DNS adresu i ima granice veličine/piksela. Nije potvrđen novi SSRF u tom toku. |
| Prevelik R2 objekat | Postojeći `readObjectBody` već ograničava čitanje na 25 MiB; sumnja da je potpuno neograničen odbačena je posle čitanja implementacije. |
| ZIP traversal / osnovni ZIP bomb scenario pri instalaciji plugina | Postoje provere putanja, broja fajlova, prijavljenih i raspakovanih veličina i checksum-a. Ovo nije puna revizija dekompresora niti zamena za kriptografski potpis izdavača. |
| Electron IPC / Android skladište | Pregledani IPC sender guard zahteva glavni pouzdani okvir; prozori koriste sandbox/context isolation bez Node integracije. Android sesije koriste Keystore/AES-GCM i backup je zabranjen u manifestu. Nisu potvrđeni svi runtime scenariji. |
| HTML opisi proizvoda | Pregledani web sanitizer rekonstruiše dozvoljene tagove bez atributa/URL-ova. Nije potvrđen novi XSS u tom toku. Ovo nije dokaz da ne postoji XSS na drugom mestu. |

## Zavisnosti

`npm audit --package-lock-only --json` je tokom pregleda prijavio:

| Projekat | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| daja-platform | 0 | 0 | 19 | 0 |
| dajashopweb | 0 | 0 | 6 | 0 |
| RFIDDaja | 0 | 0 | 32 | 0 |

Ovi brojevi su broj pogođenih paketa, ne broj nezavisno potvrđenih propusta aplikacije. Prijavljeni lanac uključuje novi `minimatch` DoS advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), za koji je naveden patch 11.0.1. Opis se odnosi na napadački glob obrazac i obradu sa `optimizationLevel >= 2`. Nije potvrđena HTTP putanja kojom bi javni posetilac davao takav glob tim zavisnostima.

Nalazi ostaju otvoreni. Nije primenjen `npm audit fix --force`, downgrade alatki niti globalna zamena različitih generacija minimatch-a verzijom 11, jer bi to moglo pokvariti njihove različite API-je. Potreban je zaseban kompatibilan dependency upgrade i funkcionalna validacija, posebno za ESLint/Electron/Capacitor i ExcelJS putanje. Nema tvrdnje da je dependency audit čist.

## Trenutno pročitano Cloudflare stanje

Read-only API pozivi za zonu dajashop.rs: minimum TLS 1.2, SSL `strict`, Browser Integrity Check uključen i Bot Fight Mode uključen. U inventaru ruleset-ova postoje managed Free i DDoS L7 ruleset-ovi; samo prisustvo u inventaru nije provera svih efektivnih pravila. Nije menjana cloud konfiguracija.

Klijenti prema pregledanim izvorima direktno koriste javni Render API. Cloudflare podešavanja za dajashop.rs zato nisu dokaz da štite direktne zahteve ka `daja-platform-api.onrender.com`. Novi lokalni limiti ograničavaju rad aplikacije, ali napadač i dalje može napuniti dozvoljeni kapacitet. Za jaču zaštitu treba pokriti javni API edge slojem i sprečiti zaobilaženje origin zaštite, uz očuvanje native pristupa.

## Šta ostaje otvoreno

- Funkcionalna, regresiona i load validacija svih novih granica; pragovi nisu dimenzionisani merenjem realnog saobraćaja. Pri dostizanju limita legitimni korisnici takođe mogu dobiti 429/503. Account budžet uvodi privremenu blokadu prijave i zavisnost od Redis-a; to je vidljiva promena ponašanja.
- Zaštita od distribuiranih botova: ograničenje zahteva nije dokaz ljudskog korisnika. Nije uveden Turnstile niti potpuno rešena zloupotreba javnog checkout-a, recenzija i troškova email/SMS sistema.
- Web refresh/access tokeni ostaju dostupni JavaScript-u u browser skladištu. Prelazak na HttpOnly sesije zahteva koordinisanu promenu autentikacije/CSRF i cross-origin ponašanja.
- Obavezna višefaktorska autentikacija administratora nije uvedena. Google prijava sama ne dokazuje da korisnik ima uključen MFA.
- Nisu provereni svi cloud IAM/R2/SES/Render privilegijski odnosi, produkcijske tajne i rotacija ključeva, Google key restrictions, prava DB naloga, stanje kompromitacije računara, Git istorija ili svi CI supply-chain rizici.
- Nije potvrđen potpun object-level authorization pregled svih API ruta. Pretragom platform controller izvora evidentirano je 247 route dekoratora; detaljno su praćeni samo tokovi navedeni u ovom izveštaju. Pretraga fajlova nije potpuna revizija svakog handler-a.
- Nisu proveravani rad fizičkog RFID hardvera, rootovanog telefona, ponašanje svih pluginova, oporavak backupa ili izvršena verzija u produkciji.

## Izvršene provere bez testova

- Platform: `npx tsc -b apps/api --pretty false` — uspešno.
- RFID: TypeScript kompilacija mobile, PWA, desktop main i zasebnog servera — uspešno; `npm run build:mobile` — uspešno, produkcijski HTML sadrži CSP.
- Android: Gradle `:app:compileOperationalDebugJavaWithJavac` i `:app:compileStationDebugJavaWithJavac` — uspešno; native Java izmene kompajlirane za obe varijante. Nisu pokrenuti testovi niti instalacija.
- Web: `node --check` za oba izmenjena SSR fajla i `npm run build` — uspešno, uključujući browser i SSR Worker build.
- Build upozorenja o veličini bundle-a/fontovima i anotacijama zavisnosti nisu predstavljena kao bezbednosni nalazi.
- `git diff --check` za izmene; zatečene korisničke promene u RFID `.idea` i web `.env.example` nisu deo ovih izmena.
- Testovi nisu pokretani. Uspešna kompilacija ne dokazuje odsustvo ranjivosti niti ponašanje pod napadom.

Tehničke reference: [Nest rate limiting](https://docs.nestjs.com/security/rate-limiting), [Socket.IO server options](https://socket.io/docs/v4/server-options).
