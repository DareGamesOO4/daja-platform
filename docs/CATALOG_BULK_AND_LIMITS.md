# Masovne izmene kataloga i ograničenja API-ja

Implementacija: 02.11.2026. Ovaj dokument opisuje izvorni kod, ne potvrđuje
završetak deploya, izvršavanje produkcijske migracije ili rad fizičkog uređaja.

## Limiti

Redis Lua operacije atomski broje zahteve na svim API procesima. Identitet mreže
dolazi od pouzdanog gatewaya; identitet zaposlenog/uređaja dolazi iz autentifikacije.
Ključevi brojača su heširani i ističu. Redis greška vraća 503 umesto isključivanja
zaštite. Health provere su izuzete. Slike na CDN-u ne troše limit kataloga.

| Obuhvat                                                    | Ograničenje                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Sve `/public/catalog` rute, uključujući pretragu i filtere | Zajednička korpa po IP mreži: 30 tokena, dopuna 200/min (jedan token na 300 ms)            |
| Lozinka i OTP, po nalogu/OTP opsegu                        | 5/min, uz zadržan dodatni plafon 20/15 min                                                 |
| Lozinka, po IP mreži i login ruti                          | 10/min, nezavisno od limita naloga                                                         |
| Kontakt forma                                              | 3/10 min po IP mreži                                                                       |
| Zaposleni, čitanje                                         | 600/min po korisniku, zajedno za sve rute                                                  |
| Zaposleni, upis                                            | 120/min po korisniku, zajedno za sve rute                                                  |
| `/sync`                                                    | 120/min po verifikovanom uređaju (bez uređaja po korisniku)                                |
| Sync paket                                                 | Postojeće ograničenje: najviše 100 događaja; telo 1 MB                                     |
| Kreiranje masovnog posla                                   | 2/min po korisniku i 2 nova posla/min po organizaciji; jedan aktivan posao po organizaciji |
| Šira zaštita pre autentifikacije                           | 6.000/min globalno, 3.000/min po IP mreži                                                  |
| Istovremeni zahtevi                                        | 64 po procesu, najviše 32 sa iste IP mreže                                                 |

Stroži postojeći limiti pojedinačnih osetljivih ruta ostaju. IPv6 adrese se
grupišu po /64. Token korpa dozvoljava početni nalet od 30 i zatim kontinuiranu
dopunu: 200/min je brzina dopune, ne stroga granica svakog kliznog minuta.
Ostali brojači koriste vremenski prozor od prvog zahteva. `Retry-After` se računa
iz stvarnog isteka brojača ili vremena do sledećeg tokena; odbijeni zahtevi ne
produžavaju prozor. Ograničenje istovremenih zahteva vraća 503 i preporuku 5 s.
Klijent treba da poštuje `Retry-After` i da ne ponavlja upise bez idempotentnosti.

## Masovni API

Sve putanje imaju prefiks `/api/v1`, zahtevaju prijavljenog zaposlenog i
`catalog.write`. Unosilac može da obrađuje samo svoje proizvode. Ovlašćenja,
aktivnost naloga i uređaja ponovo se čitaju pre svakog artikla. Posao i rezultate
može da vidi/otkaže njegov pokretač ili vlasnik organizacije.

- `POST /admin/catalog/jobs`: kreiranje ili ponavljanje identičnog zahteva.
- `GET /admin/catalog/jobs/:id?after=-1`: napredak i do 50 rezultata; sledeća
  stranica koristi `nextAfter`. `pendingSync` prikazuje preostale trajne isporuke.
- `POST /admin/catalog/jobs/:id/cancel`: zaustavlja preostale artikle; već
  potvrđene izmene ostaju i njihova sinhronizacija se nastavlja.

Primer tela zahteva (ID-jeve i verzije uzeti iz stvarnog kataloga):

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "items": [
    {
      "productId": "22222222-2222-4222-8222-222222222222",
      "expectedProductVersion": 7,
      "product": { "description": "Novi opis artikla" },
      "variantId": "33333333-3333-4333-8333-333333333333",
      "expectedVariantVersion": 4,
      "pricePercent": 5
    }
  ]
}
```

`GET /products`, `/products/:id` i administratorski prikazi proizvoda vraćaju
`version` i `variantVersion` za prvu varijantu; `/products/:id/variants` vraća
verzije svih varijanti (pretvoriti u broj pri sastavljanju JSON-a).

Posao prihvata do 1.000 različitih proizvoda, po jednu ciljnu varijantu uz svaki
proizvod. Telo masovnog zahteva ima plafon 8 MB. Za svaki proizvod potrebna je
očekivana verzija; za izmene varijante potrebni su njen ID i očekivana verzija.
`product` podržava naziv, opis, stanje artikla, odeljenje, brend, kategoriju, SEO,
features, marketingFlags, aktivnost i objavu. `variant` podržava SKU, barkod, MPN,
naziv, pol, cenu u najmanjim novčanim jedinicama, valutu, attributes, aktivnost i
objavu. `pricePercent` menja cenu procentualno i isključuje direktnu cenu u istom
artiklu. `specifications: [{"specKeyId":"UUID","value":"vrednost"}]` zamenjuje
strukturirane specifikacije; prazan niz ih briše. Proverava se pripadnost odeljenju.
Nepoznata polja se odbijaju. Slugovi, mediji, EPC i fizičko stanje nisu deo ovog
masovnog ugovora; za njih ostaju postojeće namenske rute.

Isti `requestId` i isto telo vraćaju postojeći posao, uključujući završen posao.
Drugačije telo sa tim ID-jem vraća konflikt. Za popravku neuspešnih artikala
učitati trenutno stanje, sastaviti novi plan sa novim verzijama i novim requestId.
Ne ponavljati ceo procentualni posao sa novim ID-jem, jer to predstavlja novu izmenu.

## Izvršavanje i pouzdanost

API proces pokreće ugrađene potrošače poslova i sinhronizacije; nije potreban nov
Render servis. Potrebna je migracija `096_catalog_bulk_jobs.sql` pre novog API-ja.
Poslovi, ulazi, rezultati i red za isporuku nalaze se u PostgreSQL-u, ne u Redis
redu koji može da izgubi podatke pri restartu.

Artikli su organizovani u logičke grupe od 25. Svaki artikal ima svoju transakciju.
Početno ograničenje je najviše približno dva artikla u sekundi po poslu, sa pauzom
kada proces ima najmanje 16 aktivnih zahteva. Stvarna brzina zavisi od baze,
broja specifikacija i opterećenja; nije izmerena. `FOR UPDATE SKIP LOCKED` i
`next_run_at` sprečavaju dve instance da preuzmu isti artikal/ubrzaju isti posao.

Promena, revizija, zapis za sinhronizaciju i oznaka uspeha potvrđuju se zajedno.
Prekid pre potvrde vraća celu transakciju; prekid posle potvrde preskače završen
artikal. Provera verzije i uslovni SQL UPDATE sprečavaju prepisivanje novije
izmene. Poslovna greška postaje `failed` ili `conflict` bez izmene tog artikla;
privremene greške imaju do pet pokušaja sa odlaganjem. Nedostupnost same baze
odlaže obradu dok se veza ne vrati.

Trajna isporuka ponavlja objavu kanonskih sync snimaka za sve varijante i
invalidaciju keša sa odlaganjem do 256 s između pokušaja. Zapis se završava tek
kada te radnje uspeju; pokušaji nemaju automatski konačni otpis. Ponovljeni sync
snimci koriste postojeće idempotentne ključeve. Pretraga/listanje u drugim
procesima imaju postojeći keš do 60 s; novi Redis limiti sami ne uvode distribuiranu
invalidaciju tog lokalnog keša. `completed` označava završene izmene u bazi;
`pendingSync=0` označava da su njihove isporuke obrađene, ne potvrdu prijema na
fizičkom telefonu ili čitaču.

Trajni zapisi dodati su i postojećim pojedinačnim izmenama proizvoda, varijante,
strukturiranih specifikacija i objedinjene administratorske forme. Izmena
specifikacija sada napreduje verzije proizvoda i varijante i ima revizijski zapis.
Postojeći DB okidači za obaveštenja o promenama cena ostaju aktivni.

Ovo su API mogućnosti; nije dodat nov ekran za masovne poslove u web/Android
aplikaciji. Testovi se ne pokreću prema korisnikovom uputstvu. TypeScript
kompilacija služi statičkoj proveri, ne potvrđuje produkcijsko izvršavanje.
