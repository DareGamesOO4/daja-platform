# Bezbednosne izmene — 30.10.2026.

## Završeno

- U produkciji i stagingu ne može se preuzeti staff identitet preko `X-User-Id`, `X-Organization-Id`, `X-Roles` ili `X-Permissions`, čak ni ako je `TRUSTED_IDENTITY_HEADERS=true` greškom podešen. Razvojni/test režim zadržava postojeći ugovor.
- Dodati su posebni limiti za staff/customer login, registraciju, NFC login, početak desktop/mobile Google prijave i customer→staff zamenu sesije. Postojeći globalni, OTP i password-reset limiti ostaju. Trenutni Nest limiter je u memoriji jedne API instance; više instanci zahteva zajedničko skladište limita.
- Staff access token mora da sadrži identifikator sesije da bi prošao proveru njenog opoziva. Stari token bez tog podatka dobija 401 i treba da se obnovi preko postojeće refresh putanje.
- HTTP i WebSocket koriste ograničena browser porekla; WebSocket handshake dobija zaseban `allowRequest` filter. Native klijenti bez Origin zaglavlja i dalje moraju da pošalju validan token. Produkcija ne dozvoljava razvojne localhost URL-ove sa portom; postojeća Capacitor porekla ostaju.
- Javne PostgreSQL veze proveravaju TLS sertifikat. SSL URL parametri više ne mogu da pregaze eksplicitnu proveru sertifikata. Lokalna i interna Render veza ostaju podržane. Ova implementacija koristi sistemski trust store; posebna infrastruktura sa sopstvenim CA/mTLS zahteva zasebnu konfiguraciju.
- Upload proverava dozvoljeni MIME i veličinu pri završetku, podudarnost sa zahtevom, potpis sadržaja i SHA-256, ako je zatražen. Čitanje R2 objekta je ograničeno na 25 MiB. SHA-256 za S3 potpisani URL pravilno se kodira kao base64; u bazi ostaje hex otisak stvarnog sadržaja.
- API odgovori podrazumevano imaju `Cache-Control: no-store`. Swagger nije objavljen u produkciji. Serverske greške ne vraćaju interne poruke ni detalje.
- Logovi koriste šablon rute, ne URL parametre ili identitet koji je poslao neautentifikovani pozivalac. Request ID je ograničen na bezbedan format i dužinu. Produkcijski `err` serializer izostavlja poruku, SQL detalje i stack; proširena je redakcija tokena, lozinki, PIN/OTP i servisnih tajni.
- `.dockerignore` sprečava ulazak lokalnih env/ključeva u build kontekst; `.gitignore` obuhvata dodatne lokalne tajne.
- Zakrpljene su npm zavisnosti. `sharp` 0.35.5; ciljane kompatibilne verzije za `multer`, `uuid` preko ExcelJS i `js-yaml`; Vitest 4.1.12 sa Vite 7.3.7 kompatibilnom granom. Uklonjen je nekorišćeni pino-http, a Nest test alat je premešten u devDependencies. Node minimum i CI su usklađeni sa postojećim Node 24 Docker runtimeom.
- Odvojeni `MIGRATION_DATABASE_URL` podržan je u konfiguraciji/CLI-ju. Ovo omogućava migrator i runtime nalog, ali **ne znači da su produkcijski DB korisnici već odvojeni**.
- Backup alat sada zaista radi dump i restore, proverava sve public tabele kroz konzistentan snapshot i odbija neprazan, udaljen ili nepropisno imenovan cilj. Lozinke nisu u argumentima procesa ni izlazu. Test reset baze proverava stvarno ime baze i loopback odredište iz pool opcija pre brisanja šeme; `NODE_ENV=test` sam nije dovoljan.

Google OAuth web prijava zahteva jednokratno nasumično browser stanje potpisano u state tokenu; web prihvata samo povratak započet u istom tabu u poslednjih 10 minuta. Podmetnuti ili ponovljeni povratak ne menja postojeću prijavu. Posle objave stari/in-flight web Google login treba ponoviti. Native desktop/mobile Google tok nije menjan.

## Cloud izmene i backup provera

Na Render API servisu sačuvani su `TRUSTED_IDENTITY_HEADERS=false` i `LOG_LEVEL=info` uz merge postojećih env vrednosti. Nije proveravan završetak deploya.

Pre blokade pristupa, metadata upit je potvrdio da su sve četiri aktivne `daja-platform` veze bile na privatnoj mreži. Zatim je uklonjeno PostgreSQL pravilo `0.0.0.0/0`. Render metadata je potvrdio `ipAllowList=[]`: javni pristup je blokiran.

Recovery ekran je potvrdio aktivan PITR prozor od 3 dana. Napravljen je i preuzet logički izvoz od 30.10.2026. 19:04 po Europe/Belgrade vremenu, sa Render zadržavanjem od najmanje 7 dana. On je vraćen u izolovani lokalni PostgreSQL 18.6 bez promene produkcije:

- `pg_restore --exit-on-error --single-transaction`: uspešan.
- 124 public tabele, svih 124 TABLE DATA zapisa iz manifesta provereno.
- 67.602 reda: broj redova svake tabele odgovara odgovarajućem backup data fajlu.
- SHA-256 arhive: `caeed6ae188c085e01b6c32555416a1224fe9258d1483a8a2662953e4223eb67`.
- Dodatne provere na lokalnoj kopiji: parameterizovan SQL sa injection sadržajem, odbijanje čitanja druge organizacije i prazan rezultat bez identiteta kupca. U kopiji nije bilo porudžbina, pa negativna provera tuđe postojeće porudžbine nije mogla da se izvrši nad realnim zapisom.
- Privremene SQL probe su vraćene rollbackom. Lokalni server je zatim ugašen, a radni direktorijum kopije ograničen Windows ACL-om na trenutnog korisnika i SYSTEM.

Ovaj izvoz nije zamena za PITR i nije uveden novi plaćeni servis ili promena plana. Dugoročna automatizovana arhiva van Render prozora nije podešena.

## Otvorene važne stavke

1. Browser access/refresh/staff tokeni u web projektu još koriste localStorage. Potrebna je usklađena migracija web/API/realtime/OAuth ugovora na HttpOnly/Secure sesije i odgovarajući CSRF mehanizam. To nije rešeno samim CORS ili CSP zaglavljem.
2. Obavezan administratorski 2FA nije uveden. Mora da se sprovede na backendu sa enrollment/recovery tokom i podrškom za postojeće web i RFID prijave; sam prekidač bi blokirao postojeće klijente. Google nalog sam po sebi nije dokaz drugog faktora u ovoj aplikaciji.
3. Produkcijski DB nalog `daja` još je vlasnik baze sa širim pravima. Migrator/runtime razdvajanje zahteva kreiranje ograničenog DB naloga, bezbedno postavljanje njegovog kredencijala i odvajanje privilegovanog migration izvršavanja od runtime servisa. Dostupni Render SQL konektor je read-only; ta promena nije izvršena.
4. Ograničenja Google browser ključa treba proveriti u Google Cloud Console. Render/Cloudflare pristup nije pristup Google Cloud IAM/API restrictions.

## Završene lokalne provere

- Produkcijski TypeScript build API-ja, worker-a i paketa: prolazi.
- 32 unit/HTTP testova kroz 10 fajlova: prolaze.
- Ciljani ESLint izmenjenih TS fajlova i `git diff --check`: prolaze.
- `npm audit --audit-level=low`: 0 poznatih ranjivosti u trenutnom lockfile-u.
- Stvarni lokalni dump→restore fixture i odbijanje nepraznog restore cilja: prolaze.
- Produkcijski backup restore i poređenje svih tabela: prolaze kako je opisano iznad.

Nisu pokretani svi stari integracioni testovi niti proveravan produkcijski deploy. Rezultat ne znači da je završen svaki nalaz ili da postoji garancija odsustva ranjivosti.

Reference: [Render env konfiguracija](https://render.com/docs/configure-environment-variables), [privatne veze baze](https://render.com/docs/postgresql-creating-connecting), [backup/restore](https://render.com/docs/postgresql-backups).

Postojeći temelji nisu zamena za ove izmene: Argon2id, Zod validacija, 1 MiB JSON/urlencoded granica, tenant parametri u repozitorijumima i parametrizovani SQL ostaju deo aplikacije. Registracija sada i na serveru zahteva postojeća UI pravila: najmanje 8 znakova, veliko slovo i broj. CI npm audit sada prijavljuje svaku težinu ranjivosti, a ne samo high/critical.
