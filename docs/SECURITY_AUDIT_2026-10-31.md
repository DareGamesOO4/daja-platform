# Bezbednosni pregled — 31.10.2026.

Ovo je dopuna prethodnoj dokumentaciji, ne potvrda produkcijskog deploya ili odsustva svih ranjivosti. Pregledani su sva tri DAJA repozitorijuma, dostupna Git istorija, zavisnosti i odabrane cloud mrežne/TLS postavke. Detaljan izveštaj sa svih 30 stavki i JSON prilozima isporučen je korisniku izvan repozitorijuma.

## Izmene u ovom pregledu

- Backend access kontrola proverava tenant ciljne uloge/korisnika, opseg i prava koja pozivalac sme da dodeli. Upsert ne prepisuje postojeći tuđi role/user ID. Postojeća owner uloga i poslednji aktivni vlasnik dobijaju zaštitu.
- Sync ponavlja poslovne dozvole i lokacijski opseg na serveru, ograničava lokacijske bootstrap/pull podatke i odbija nepoznate komande. Opšta `sync.write` dozvola nije dovoljna za svaku poslovnu promenu.
- Offline paket proverava korisnika, uređaj, lokaciju i zone; server određuje/proverava politiku i rok novih dozvola do osam sati. List/upload više ne vraćaju pakete svih korisnika organizacije.
- Novi desktop `user.invite` ne upisuje plaintext lozinku u audit/outbox: outbox koristi Argon2id hash sa fiksnim 64 MiB/3/1 parametrima. Nove audit/sync serijalizacije rediguju kredencijale; pregledani sync odgovori rediguju i ranije sadržaje. Backend zadržava podršku starim plaintext zahtevima uz hash-ovanje i redakciju pri čuvanju.
- Refresh replay opoziv sada opstaje posle rollbacka neuspešne transakcije. Novi access tokeni su ograničeni na 15 minuta. Browser staff exchange ne vraća dugovečni staff refresh token; novi staff access token zavisi od aktivne customer session family.
- Web logout pokušava da opozove staff i customer sesiju. Privatni realtime reconnect obnavlja sesiju; javni katalog ne pokreće taj tok. WebSocket proverava istek/opoziv, a razvojni trusted identitet je zabranjen van development/test režima.
- RFID stanica odbija obradu drugog uređaja; prodajni izveštaj i izmena organizacije zahtevaju odgovarajuća poslovna prava.
- Globalni native-plugin publisher zahteva javnu organizaciju i aktivnog korisnika sa serverske admin email liste, uz postojeće dozvole. Desktop loader ograničava transport, bajtove preuzimanja, ZIP veličinu/broj/duplikate/putanje pre raspakivanja. Dodaci ostaju privilegovan pouzdan kod, nisu sandbox.
- Publisher DB skripta više ne koristi `rejectUnauthorized:false`. Javni cloud URL-ovi klijenata zahtevaju HTTPS; loopback razvoj ostaje podržan. Zasebni RFID server ima TLS izbor za DB, HTTP rate limiter, strožu produkcijsku konfiguraciju, no-store i bezbednije greške/logove.
- Android isključuje backup/device transfer i cleartext, a FileProvider više ne izlaže ceo external storage. Git/Docker/Electron installer izostavljaju dodatne tajne, baze i backup-e.
- RFID zavisnosti zakrpljene su uključujući Capacitor 8.4.3, Electron 42.11.16, Zod 4.6.7, Vitest 4.1.12, Vite 7.3.7 i Multer 2.5.0. Uklonjen je nekorišćeni concurrently. Nisu forsirani nekompatibilni downgrades radi zelenog npm broja.

## Važne otvorene stavke

1. **Obavezan admin MFA nije uveden.** Potrebni su serverski enrollment/recovery i provera u svim web/native/password/Google/NFC putevima. Ranije povezivanje Google naloga samo po sebi nije dokaz MFA u trenutnoj sesiji.
2. **Browser tokeni ostaju u localStorage.** Potrebna je usklađena HttpOnly/Secure cookie ili BFF migracija sa CSRF zaštitom, OAuth-om, realtime-om i obnovom. Bearer model ne treba pogrešno opisivati kao već potvrđen cookie-CSRF propust.
3. **Istorijski kredencijali nisu fizički očišćeni.** Proveriti da li je `user.invite` put korišćen, resetovati pogođene naloge i obuhvatiti lokalne audit/outbox baze, serverske događaje i backup-e. Novi redaktor ne menja postojeće fajlove na disku. Nije potvrđen podatak o stvarnoj produkcijskoj eksploataciji.
4. **DB runtime/migrator i cloud IAM najmanje privilegije nisu operativno završeni.** Raniji dokument navodi vlasnički runtime nalog; današnja prava nisu SQL-om potvrđena. Render read-only SQL konektor je blokiran praznom javnom IP listom. Ne otvarati bazu svetu radi pregleda.
5. **Potpuna offline verifikacija u klijentu nije potvrđena.** Mobile adapter preuzima/prenosi potpise, ali prisustvo zajedničkog verifier-a nije dokaz da je povezan sa svim import/reload putevima. Uvesti unapred pouzdan javni ključ i validaciju manifesta/lease-a/sadržaja, proveriti ranije izdate pakete. Signing ključevi nisu rotirani.
6. **Nezavisno potpisivanje native dodataka i distribuiranih aplikacija ostaje operativna stavka.** Checksum prema preuzetom manifestu nije nezavisna potvrda izdavača.
7. **Preostali npm moderate nalazi:** RFIDDaja 32, daja-platform 19, dajashopweb 6. Završni audit je pokazao 0 critical i 0 high u sva tri lockfile-a; to nije odsustvo svih softverskih rizika. Deo nalaza je u minimatch/glob podstablima alata, uključujući ExcelJS na backendu.
8. **Distribuirani limiti, centralni alarmi i aktuelni backup/restore dokaz nisu uvedeni/potvrđeni.** Raniji restore dokaz u dokumentaciji je od 30.10, nije nova današnja proba. Native klienti i stari tokeni nisu retroaktivno ažurirani source commit-om.

## Obavljena provera i granice

Backend build paketa/API-ja/worker-a, RFID node/server/mobile TypeScript, Electron Vite build, web client/SSR build, ciljani ESLint i diff whitespace provera prolaze. Nisu pokretani testovi niti restore prema korisnikovom uputstvu. Provere prevoda/builda nisu funkcionalna ili penetraciona potvrda ponašanja.

Posle Git fetch-a namenski scanner je pregledao 6.489 dostupnih istorijskih blob verzija do 4 MiB, uz izostavljen jedan veći blob i binarni sadržaj bez tekstualne analize. Nije pronašao odabrane stvarne lokalne privatne env vrednosti; jedan Google browser ključ je prepoznat u više starih frontend verzija. Ovaj rezultat ne obuhvata sve moguće formate tajni, nedostupne ref-ove, fork-ove, logove ili backup-e. Nije izvršena rotacija cloud API ključeva; Google API/referrer ograničenja nisu proverena u Google Cloud Console.

Cloudflare read-only metadata potvrđuje Full(strict), minimum TLS 1.2, Always Use HTTPS i HSTS 30 dana. Render metadata potvrđuje PostgreSQL `ipAllowList=[]`. Nisu menjana cloud podešavanja u ovom zadatku, otvarana baza niti proveravan deploy završetak.

`adb devices` nije prikazao uređaj; nova Android instalacija je preskočena. APK nije građen/instaliran. Zatečene RFID IDE cache i web `.env.example` promene nisu deo ovih bezbednosnih commit-a.

Izmene mogu namerno odbiti ranije preširoke admin/sync zahteve ili javni HTTP backend. Potrebna je usklađena distribucija i naknadna funkcionalna verifikacija kada bude dozvoljena. Ovaj zapis ne označava svih 30 stavki kao završenih.
