# Pregled zavisnosti — 31.10.2026.

## Rezultat

Zamenjen je npm-run-all 4.1.5 održavanim npm-run-all2 8.0.4. Isti npm-run-all CLI zadržava postojeće skripte, a novi alat koristi picomatch. Scoped override prebacuje samo minimatch >=9 <11 na 11.0.3.

Audit (broj pogođenih paketa, uključujući roditeljske lance): 19 pre → 17 posle. Svi preostali nalazi su moderate; high/critical: 0. Ovo NIJE čist audit.

## Otvoreni nalazi i kompatibilnost

GHSA-g3hv-75wg-m249 ima opseg <11.0.1, a opisuje firstPhasePreProcess/globparts amplifikaciju sa optimizationLevel >=2. Preostale kopije su minimatch 3.1.5 i 5.1.9; pregledani izvori ovih starih grana nemaju tu fazu ni optimizationLevel. To je ograničena provera konkretnog algoritma, ne dokaz odsustva svih DoS mogućnosti ili osnov za skrivanje upozorenja. Potreban je upstream kompatibilan patch/razjašnjenje opsega ili posebno planirana migracija potrošača. ESLint i legacy arhivske alatke koriste callable minimatch API; verzija 11 koristi named export i zato ne sme globalno zameniti starije grane.

Noviji minimatch potrošači koriste named minimatch/Minimatch eksport. Pregledani electron-builder koristi set nizove za prepoznavanje obrazaca i match(path, partial), a typescript-eslint named minimatch funkciju; ti korišćeni oblici postoje u 11.0.3. Ovo je ciljana major zamena uz pregled potrošača, ne obećanje potpune kompatibilnosti svih platformi.

## Uticaj na korisnika

Sve promenjene/uklonjene/dodate zaključane verzije pripadaju devDependencies. Produkcijske verzije biblioteka nisu promenjene. Nije menjan nijedan UI/CSS fajl, tekst, raspored, boja, font, slika, animacija niti API handler. Prethodna mobilna pretraga 44 px i smanjene desktop tačkice slajdera ostaju. Ne očekuje se dodatno runtime učitavanje od ove izmene; mrežno vreme i stvarni rad na uređaju nisu ponovo mereni.

Instalacija je koristila --ignore-scripts. Nisu korišćeni --force/--legacy-peer-deps niti potisnuti audit nalazi. Lockfile zadržava npm integrity vrednosti. Projektni testovi nisu pokretani po korisnikovom uputstvu. Kompilacija ne dokazuje odsustvo regresija.

## Povratak

Početni commit: 6764dfe4177e0bf167a756db683e19588c05bcc8. Git oznaka: rollback/dependencies-20261031. Vratiti package.json i package-lock.json iz te oznake u novom reverzibilnom commitu, instalirati zaključane zavisnosti sa npm ci, pa ponoviti odgovarajući build. RFID native zavisnosti mogu zahtevati uobičajeni lokalni rebuild. Ne vraćati druge korisnikove promene i ne koristiti force push. Privatne kopije oba početna fajla su u radnom direktorijumu ovog zadatka.

## Izvori

- [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
- npm registry metadata i preuzeti, nepokrenuti tarball izvori minimatch 11.0.3/glob 14.0.3; lokalni lockfile i izvori potrošača.

## Izvršene provere

- npm run build: uspešno (paketi, API i worker); nova npm-run-all2 CLI putanja stvarno korišćena.
- ESLint --print-config za API: uspešno učitavanje konfiguracije.
- Projektni testovi nisu pokretani; završetak cloud deploy-a nije proveravan.
