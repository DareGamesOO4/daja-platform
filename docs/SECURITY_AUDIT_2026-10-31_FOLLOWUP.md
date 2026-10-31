# Dodatni bezbednosni pregled — 31.10.2026.

Dopuna `docs/SECURITY_AUDIT_2026-10-31.md`. Statički pregled i nezavisna kritika otkrili su dodatne putanje; ne predstavlja runtime dokaz eksploatacije ili potvrdu produkcijske primene.

## Kodne ispravke

- Google prijava više ne spaja naloge samo po email-u. Izričito povezivanje zahteva autentifikovanog kupca, potpisan state vezan za konkretnu živu sesiju i odgovarajući verifikovan Google identitet. Povezivanje zamenjuje stare password/phone kredencijale i opoziva prethodne sesije. Web upozorava korisnika na srpskom i engleskom.
- Potpisano poreklo customer sesije čuva se kroz refresh; admin zamena zahteva Google sesiju. Istorijski spojeni, neverifikovani nalozi imaju dodatni oporavak i ograničenja. Credential login/refresh i oporavak zaključavaju isti customer red; promene kredencijala ponovo proveravaju sesiju posle zaključavanja. Customer logout opoziva porodicu.
- NFC pogrešan PIN potvrđuje brojač/blokadu pre vraćanja greške. IP throttle i zaključavanje kartice ostaju.
- Desktop renderer ne prima raw sync inbox. Sync issue i resolve biraju samo događaje aktivne organizacije, korisnika i uređaja. Ne predstavlja zaštitu lokalne baze od vlasnika OS naloga.
- Stavke porudžbine koriste serverski naziv, brend, SKU i slike. Klijent ne može menjati prikaz proizvoda proizvoljnim item poljima; cena je i ranije bila serverska.
- Gravure imaju atomske kvote: 200 nacrta/organizacija, 20/kupac, 4 MiB/nacrt, 64 MiB/organizacija; nove IP limite i potpuno dekodiranje/normalizaciju PNG-a. Zbirni engraving snapshot po porudžbini ograničen je na 8 MiB, uključujući ponovljene reference.
- Migracija `089_engraving_retention.sql` dodaje vreme nastanka i indekse. Guest nacrti važe 24 sata, customer nacrti 30 dana od poslednje izmene; postojeći dobijaju početni period pri migraciji. Cleanup se potvrđuje uz uspešne upise. Potvrđene porudžbine zadržavaju ugrađenu gravuru. Kvota nije ukupan disk/WAL/backup limit.

## Cloud i otvoreno

Read-only Cloudflare pregled potvrdio je strict TLS, minimum 1.2, HTTPS i HSTS30d, isključen development i direktni javni R2 domen. Jedan od dva Super Administrator člana nema uključen Cloudflare 2FA; account enforcement je isključen. Potrebno je korisničko uključivanje faktora i recovery kodova, zatim pravilo članova. MFA spoljnog identity providera nije potvrđena.

Render PostgreSQL i Redis imaju prazne javne IP liste. Nisu otvarane radi audita. Stvarna runtime DB/IAM prava, tajne i operativni restore nisu potvrđeni. Cloud nije menjan. Puna moderna WAF primena nije zaključena samo iz legacy flag-a ili inventara.

Ranije otvoreno ostaje: obavezan aplikacijski admin MFA, localStorage tokeni, istorijski invite kredencijali/kopije, najmanje DB/IAM privilegije, offline verifier, nezavisno plugin potpisivanje, preostale moderate zavisnosti i operativni monitoring/backup provera.

Backend i web build, RFID node typecheck i ciljani lint prolaze bez grešaka; web ima postojeća hook upozorenja. Testovi, aktivni napadi, restore i provera deploy završetka nisu pokretani. Migracija se isporučuje u kodu; produkcijska primena nije potvrđena. Android uređaj nije povezan, instalacija preskočena. Zatečeni IDE cache i `.env.example` ostaju izvan commit-a.
