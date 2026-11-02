# Izbori i serije satova

`apps/api/src/catalog-landings.ts` sadrži 19 selekcija za web stalne stranice.
Definicije putanja, naslova i opisa uskladiti sa
`dajashopweb/src/data/catalogLandings.js` prilikom izmena.

API proverava putanje prema dozvoljenim rutama; `publicListingParams` pretvara
stalnu putanju u parametar `landing`. Taj parametar učestvuje u izboru, facetima,
sortiranju i ključevima keša. Dodatni uslovi su presek sa izborom stalne stranice.
Sitemap v6 sadrži samo selekcije sa aktivnim/objavljenim proizvodima. Sve postojeće
putanje invalidacije sitemap-a sada uključuju v6.

Serija se izvodi u odgovoru, bez migracije ili prepisivanja baze i sačuvane
konfiguracije filtera. Izvedeni facet `watch_series` koristi
`spec:seo_watch_series`. Interna pretraga koristi istu funkciju `watchSeries`.

Pravila prihvataju izričit naziv serije u imenu, kategoriji ili specifikaciji
`serija` / `series` / `kolekcija` / `collection`. Opisi se ne koriste za dodelu.
Pravila oznaka su ograničena na poznate porodice; nepoznate oznake se ne dodaju.
Jedan model može opravdano biti Bambino i Sun and Moon.

## Osnova za oznake modela

- Kamasu RA-AA0001–RA-AA0006:
  https://www.orientwatchusa.com/products/um025113j0
  https://www.orientwatchusa.com/products/ra-aa0001b39b
- Bambino RA-AC0M01–04, 09–11:
  https://www.orientwatchusa.com/products/ul020014j0-1
  https://www.orientwatchusa.com/products/um00y113j0
- Bambino RA-AC0P01–04:
  https://www.orientwatchusa.com/products/ra-ac0p04y30b
- Bambino AC00 porodica i stari FAC00008W / FAC00009W / FAC0000DD:
  https://www.orientwatch.co.uk/or/en_GB/brands/orient/c/orient
  https://www.orientwatchusa.com/collections/orient-bambino-version-3/tac0000dd0
- Bambino Sun and Moon RA-AK0801–08:
  https://www.orientwatch.co.uk/or/en_GB/brands/orient/orient-bambino-sun-%26-moon/p/RA-AK0802S
  https://orient-watch.com/en/orient/collection/classic/classic-and-simple-style-day-and-night/RA-AK0806L/
- Sun and Moon AK00 Version 3 RA-AK0007–10:
  https://www.orientwatchusa.com/products/ra-ak0007s30b
  https://www.orientwatchusa.com/products/ra-ak0008s30b
  https://www.orientwatchusa.com/products/ra-ak0010b30b
- Mako RA-AC0Q i RA-AA08:
  https://orient-watch.com/en/news/news_en_file/file/EN-049.pdf
  https://orient-watch.com/en/news/press/news_en_file/file/EN-045.pdf
  https://www.orientwatch.co.uk/or/en_GB/brands/orient/c/orient

Casio MTP prepoznaje se po izričitoj oznaci MTP-, Duro po MDV-106/107 ili
izričitom nazivu, a G-Shock/Edifice/Vintage po potvrđenoj seriji u podacima.
Nisu sve Casio oznake automatski razvrstane. Kada se ponuda dodaje, uneti i seriju.

Pravila ne potvrđuju stanje dobavljača niti automatski otkrivaju skrivene artikle.
Javni izbori nastavljaju da koriste postojeća pravila objavljivanja kataloga.

## Pregledi kolekcija

`GET /public/catalog/collections` koristi javni snapshot satova, pet grupa brendova
i postojeće landing izbore. Za svaki neprazan izbor vraća broj proizvoda i najviše
tri kartice. Fotografije za jedinstvene proizvode učitavaju se grupno jednim pozivom
postojećeg repozitorijuma, bez posebnog zahteva po kolekciji.
Sitemap uključuje i SSR magazin `/kolekcije-satova`.
