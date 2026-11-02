# Jednokratni obračun muških Q&Q cena, 02.11.2026.

`reprice-qq-male.cjs` je ručno pokretana administrativna operacija. Nije migracija,
cron posao niti deo pokretanja API-ja. Nikada ne menja cene bez `--apply`.

Plan sadrži identitet proizvoda/varijante, proverene izvore za punu oznaku modela,
NBS kurs i datum liste, početnu cenu u **minor** jedinicama i predloženu cenu.
Javni katalog vraća minor jedinice: `480000` predstavlja **4.800 RSD**.
Skripta nezavisno proverava obračun tačnom celobrojnom aritmetikom:

- Timezone cena je osnova.
- Kada je Stilius skuplji, osnova je prosek oba izvora.
- Kada postoji samo jedan potvrđen izvor, koristi se taj izvor.
- EUR se preračunava potvrđenim srednjim kursom NBS.
- Osnova se zaokružuje naviše na 100 RSD, pa dodaje 200 RSD.
- Nepotvrđeni izvori, nejasne cene i drugi modeli ne koriste se za obračun.

Pokretati iz korena pripremljenog backend runtime-a, gde postoje kompajlirani
`packages/database/dist` i `apps/api/dist`. `DATABASE_URL` i `REDIS_URL` koristi
isključivo na serveru; ne kopirati njihove vrednosti u komande ili dokumente.

```sh
node scripts/reprice-qq-male.cjs --backup /private/plan.json /private/before.json
# Pregledati ispisani broj artikala, uzorak cena i fingerprint kopije.
QQ_PRICES_EXPECTED_FINGERPRINT=REVIEWED_SHA256 node scripts/reprice-qq-male.cjs --apply /private/plan.json /private/before.json
node scripts/reprice-qq-male.cjs --verify /private/plan.json /private/before.json
```

Zaštite: tačna organizacija/brend/odeljenje/pol i varijanta; zabrana duplih
identiteta; provera početne cene, cele kopije i verzija; odbijanje novih proizvoda
izvan plana i aktivnih/budućih akcijskih cena; zaključavanje redova i jedna
transakcija. Greška pre COMMIT vraća sve izmene. Proizvodi, opisi, stanje i datumi
kreiranja ostaju isti; samo odabrane cene i metapodaci njihove izmene smeju da se
promene. Skripta proverava ta polja pre COMMIT-a.

Svaka izmena koristi `CatalogRepository.patchVariant`, čuva istoriju cena, audit,
`PriceChanged` outbox, korpu/listu želja i operativnu sinhronizaciju. Audit ima
čitljiv tekstualni request ID; sinhronizacija koristi UUID. Završni audit događaj
`catalog.prices.reprice`, request ID `qq-male-prices-20261102`, čuva celu kopiju
pre izmene i izvore, pa kopija nije vezana samo za privremeni serverski fajl.

Posle COMMIT-a čiste se pripadajući Redis keševi. Ako samo taj korak ne uspe,
pokrenuti `--cache`, zatim `--verify`. **Ne ponavljati `--apply` posle COMMIT-a.**
Batch marker dodatno sprečava ponovno izvršavanje. API metapodaci filtera imaju
TTL od 60 sekundi; otvoren tab može prikazivati sopstveni prethodni keš.

Za eventualno vraćanje koristiti sačuvane početne iznose uz novu proveru
trenutnih verzija i standardnu istoriju cena. Ne prepisivati novije izmene
artikala, ne brisati istoriju cena niti ponavljati staru operaciju.
