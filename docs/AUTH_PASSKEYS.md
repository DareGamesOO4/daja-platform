# Passkey prijava i uklanjanje prethodnog provajdera

Izvorni kod od 31.10.2026. Ovo nije potvrda završenog produkcijskog deploy-a.

## Korisnički tok

1. Prijaviti se Google nalogom ili emailom/lozinkom i potvrditi email ako nije potvrđen.
2. U roku od 10 minuta od stvarne prijave otvoriti Nalog → Bezbednost → Dodaj Passkey. Sesije nastale pre authTime dopune zahtevaju novu prijavu; obnova tokena ne osvežava vreme stvarne prijave.
3. Potvrditi Windows Hello, PIN, otisak prsta, lice ili ponuđeni drugi uređaj. Privatni ključ/biometrija se ne šalju backendu.
4. Pri sledećoj poseti izabrati Prijavi se Passkey-om. Dodavanje novih ključeva dostupno je u profilu, ne kroz anonimnu registraciju email adrese.

Podržano je najviše 10 ključeva po nalogu/RP-u. Profil prikazuje stvarne registrovane ključeve i omogućava njihovo uklanjanje. Uklanjanje ključa odjavljuje sve customer sesije tog naloga. Uspešan reset lozinke takođe uklanja passkey ključeve i opoziva sesije, radi oporavka kompromitovanog naloga.

Passkey sesija sama NE daje admin/staff prava. Postojeća serverska Google provera, aktivni Google identitet i admin/contributor pravila ostaju. Native Android/desktop prijava ne dobija novu passkey implementaciju; njeni Google/bearer tokovi ostaju.

## Bezbednosne granice

- SimpleWebAuthn server 13.3.3 je tačno zaključan; koristi se biblioteka za COSE/CBOR, potpis, RP ID hash, očekivani tip, challenge, origin, UP/UV i brojač. Ne uvodi se sopstvena kriptografija.
- RP i očekivani HTTPS origin potiču iz STOREFRONT_PUBLIC_BASE_URL; ne iz Host/X-Forwarded/body vrednosti. Cross-origin iframe/topOrigin odgovori se odbijaju.
- Resident/discoverable ključ i userVerification required; pri proveri je requireUserVerification true. userHandle mora odgovarati sačuvanom vlasniku ključa.
- Izazov živi najviše 300 sekundi u Redis-u. HttpOnly/Secure/SameSite=Lax host-only nonce cookie vezuje ga za browser; Redis ključ čuva hash nonce-a. GETDEL ga atomarno troši PRE DB transakcije, pa neuspeh/rollback ne vraća mogućnost ponavljanja.
- Registracija je dodatno vezana za customer ID i session family. Proverava se trenutno važenje sesije i nedavna stvarna prijava, uz zaključavanje naloga i limit broja ključeva.
- Prijava zaključava nalog i credential pre ažuriranja brojača. Neispravan potpis, regresija nenultog brojača, drugi RP/origin, promenjen vlasnik i promenjena backup eligibility se odbijaju. Standardni zero counter ostaje podržan za sinhronizovane ključeve.
- POST/DELETE koriste postojeće Origin/CSRF kontrole; HTTP endpoint-i imaju zasebne limite, a poznati credential deli postojeći account login budget. Redis greške su fail-closed 503.
- Browser dobija HttpOnly customer/refresh sesiju; JWT nije deo JS JSON odgovora. Nova prijava uklanja prethodni staff cookie i nedovršene OAuth/passkey nonce kolačiće. Obnova čuva authTime i authMethod.
- Lista ključeva ne izlaže credential ID, javni ključ ili userHandle. ID za brisanje je scoped na organizaciju i vlasnika. Vraćaju se samo naziv, interni ID i datumi.

## Penzionisani provajder

Iz aktivnog web koda uklonjeni su Facebook dugme, ikonica/profil, poslednji korišćeni provajder, app metadata, javna env podešavanja i njihove dozvoljene build promenljive. Cloudflare production VITE_FACEBOOK_APP_ID je uklonjen uz proveru očuvanja svih drugih env varijabli.

Migracija 091 opoziva sesije naloga vezanih za uklonjeni provajder, briše njegove identity/OAuth veze i sužava DB CHECK ograničenja. Kupci i porudžbine ostaju. Istorijska migracija 006 ostaje neizmenjena zbog checksum istorije; reference u njoj nisu aktivna podrška prijavi. Postojeći neverifikovani webauthn redovi bez eksplicitnog rp_id nisu prihvaćeni za prijavu.

## Provera i ograničenja

35 ciljanih izolovanih provera prolazi: pravi Chrome virtuelni autentikator, stvarni kriptografski potpisi, kompajlirani servisi/validacija, lokalni PGlite PostgreSQL mehanizam, postojeći session/JWT kod, cookie interceptor i gateway. U tom okruženju Redis state i account budget su simulirani; nije dokazana stvarna višestruka instanca/Redis mreža ili performanse produkcijskog PostgreSQL-a. GETDEL/TTL/row-lock mehanizmi su pregledani u izvorima. Test skupovi projekta nisu pokretani; ciljane provere sprovedene su po izričitom zahtevu za proveru passkey bezbednosti.

Backend build/TypeScript i web browser/SSR build prolaze. Ciljani ESLint za auth/passkey web fajlove prolazi. npm audit nakon nove server biblioteke i dalje ima 17 moderate nalaza i 0 high/critical; prethodni legacy dependency nalazi ostaju otvoreni.

Nije korišćen pravi korisnički nalog, kreirana porudžbina, poslat email/SMS, potvrđen fizički Windows Hello/telefon, proveravan završetak deploy-a niti izvršen DDoS test. Bezbednost servera, uređaja, recovery emaila i cloud naloga i dalje utiče na zaštitu; nema tvrdnje o neprobojnosti.

## Vidljive izmene

U prijavi nema prethodnog provajdera. Anonimna registracija više ne prikazuje nedovršeno kreiranje passkey naloga; kratka napomena upućuje na profil. Profil prikazuje stvarni status, listu, dodavanje još jednog i uklanjanje ključa. Dodate su razumljive poruke za otkazivanje/nepodržan uređaj, sa srpskim/engleskim prevodima. Nije menjan ostatak kataloga, raspored stranica, fontovi, boje ili prethodno podešene veličine pretrage/slajdera.

## Povratak

Prethodni backend commit: ecda7f3; prethodni web commit: 50749e7. Promene vraćati novim reverzibilnim commit-om, bez force push-a. Primenjenu migraciju 091 zadržati neizmenjenu u istoriji; dodatne kolone ne smetaju starijem kodu. Brisanje prethodnih provider veza ili ključeva pri recovery-u ne može se poništiti samo Git-om: za njih je potrebna odgovarajuća kopija baze. Google/email fallback ostaje dostupan. Cloudflare uklonjena app promenljiva nije potrebna za te tokove.

Izvori: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server), [passkey smernice](https://simplewebauthn.dev/docs/advanced/passkeys), stvarni zaključani izvori biblioteke i DAJA koda.

Dodatna UI provera: lokalni produkcijski build sa simuliranim API odgovorima prikazuje passkey prijavu na desktopu i mobilnom viewport-u, nema Facebook dugme, a anonimna registracija prikazuje uputstvo umesto nedovršenog passkey kreiranja. Nisu zabeležene pageerror greške u tom toku. To nije provera stvarne produkcijske prijave.
