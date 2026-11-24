# DAJA Shop — privatnost i prava kupaca

Pregled izvornog koda i dostupne cloud konfiguracije: 23–24.11.2026.
Verzija tekstova: `2026-11-23-privacy-storage-v1`. Poslovne podatke potvrdio je vlasnik.
Ovo je evidencija implementacije i otvorenih obaveza, a ne potvrda potpune pravne usklađenosti.

## Objavljeni tekstovi u izvoru

- `/privacy`: rukovalac, svrhe i osnovi obrade, primaoci, međunarodni prenos, rokovi i prava.
- `/cookies`: kolačići, localStorage, sessionStorage, IndexedDB, opcione usluge i rokovi.
- `/terms`: kupovina, dostava u Srbiji, plaćanje pouzećem, odustanak, personalizacija, saobraznost, reklamacije i sporovi.
- `/withdrawal`: izjava za odustanak koja se može prepisati u email ili odštampati.
- `/whatsapp-privacy`: usklađeno posebno sr/en obaveštenje za Meta aplikaciju.

Izvor API teksta je `apps/api/src/legal-policy-content.ts`; isti srpski sadržaj je u
`dajashopweb/src/data/legalDocuments.js`, a engleski prevod u `src/localization/en.json`.
Pri budućim izmenama uskladiti oba sadržaja i prevod. Za bitne promene povećati verziju
i u `dajashopweb/src/services/consentStorage.js`. Ranija admin objava ne može novom
tekstu dodeliti staru verziju. Admin objava obaveštenja o promeni ostaje dostupna;
u ovom zadatku nije korišćena i nisu poslati emailovi korisnicima.

Pravne stranice renderuju se bez katalog API-ja i bez obaveznog JavaScript-a.
`ready: true` znači da je sadržaj pripremljen za objavu, ne da ga je odobrio advokat.
Tekst je datiran kada je pripremljen; završetak produkcijskog deploya nije proveren.

## Ponašanje koje kod sprovodi

- Jednim izborom „Samo neophodni” odbijaju se opcione svrhe. Lokalno pamćenje,
  Google mapa/Places i analitika imaju zasebne prekidače. Odbijanje radi i bez API-ja.
- Potvrda izbora važi 180 dana. Stare verzije/istekli zapisi ne odobravaju nove svrhe.
  Povlačenje se primenjuje odmah i prenosi drugim otvorenim karticama.
- IndexedDB katalog traži dozvolu za lokalno pamćenje: do 5 minuta upotrebljivosti,
  40 proizvoda, 3 početne liste, oko 4 MB. Proizvodi sa tekstom recenzija ne upisuju
  se na disk. Opoziv zatvara i briše bazu; generacija zaustavlja čekajuće upise.
  Zatvoren pregledač ne može izvršavati brisanje; sledeće otvaranje pokreće čišćenje.
- Tema, zatvaranje newsletter ponude, predlozi gravure i radni raspored imaju rok
  180 dana; poslednji način prijave 30 dana. Lični nacrti gravure i korpa imaju
  zasebnu funkcionalnu svrhu i ne brišu se zajedno sa opcionim kešom.
- Analitika se učitava samo uz izbor korisnika, sa isključenim SPA praćenjem, izvan
  privatnih putanja i osetljivih parametara URL-a. Kada je već učitana, prelazak
  na privatnu putanju ili opoziv može osvežiti dokument da zaustavi posmatrače skripte.
- Firebase SMS pre pokretanja prikazuje objašnjenje i traži nastavak od korisnika.
  Koristi memoriju stranice; to ne briše Googleov serverski Authentication zapis.
- Poručivanje prikazuje „Poruči uz obavezu plaćanja”, uslove i izuzetak za ličnu gravuru.
  Server traži ponovnu potvrdu promenjene dostave/popusta/ukupnog iznosa, pored
  postojeće provere cena i količina. Stariji klijenti bez `termsVersion` ostaju podržani;
  poslata pogrešna verzija se odbija. Ne predstavljati odsutnu verziju kao pristanak.
- Uslovi i FAQ objašnjavaju tehničku/nenamernu grešku ili neažuriranu cenu.
  Ispravka pre prihvatanja zahteva obaveštavanje i izričito prihvatanje nove ponude;
  kupac može odbiti bez naknade. Nema opšteg odricanja od odgovornosti niti
  jednostranog povećanja cene već zaključenog ugovora. Automatski email jasno
  potvrđuje samo prijem zahteva, a prihvatanje se saopštava zasebno.
- Nova porudžbina dobija sačuvanu verziju i ceo tekst uslova/obrasca u `shipping_payload.legal`.
  Email potvrde zahteva sadrži taj tekst na trajnom mediju. Liste porudžbina ne nose
  ceo tekst svake kopije. Slanje emaila i dalje zavisi od postojećeg reda i provajdera.
- `PrivacyRetentionService` radi periodično, u ograničenim serijama, uz PG zaključavanje
  i vremensko ograničenje upita. Briše istekle dokaze: izbor kolačića 5 godina;
  email marketinški dokaz za završen period pristanka 3 godine od opoziva.
  Ne briše račune i porudžbine. Migracija 138 dodaje indekse za ove upite.
- WhatsApp cleanup koristi usvojene rokove i više ne zavisi od zastarele zastavice
  `WHATSAPP_RETENTION_APPROVED`: završena slanja 90 dana od promene statusa;
  opozvana pretplata nakon 90 dana i uklanjanja slanja; heširani dokaz do 12 meseci
  od odjave. Postojeći HMAC ključ se zadržava; bez njega se ključ izvodi od privatnog
  signing secret-a sa zasebnim kontekstom. Ne rotirati ga proizvoljno. Hash nije anonimizacija.

## Šta je pročitano na cloudu

Render API, PostgreSQL i Key Value prijavljeni su u Frankfurtu. Baza nema javnu IP
allowlist stavku; Redis je bez perzistencije. Cloudflare Pages koristi `dajashopweb`.
Automatsko ubacivanje Web Analytics je isključeno; aplikacija ima sopstveni loader.
Cloudflare challenge passage iznosi 1800 sekundi; Always Online je isključen.
Nisu menjani cloud resursi niti proveravan deploy. Lokacija baze ne znači da svi
logovi, podrška, email i podobrađivači ostaju u toj državi.

## Obaveze vlasnika koje nisu rešene samim tekstom

1. Redovno pratiti `info@dajashop.rs`. Voditi evidenciju zahteva i proveriti identitet
   bez prikupljanja suvišnih dokumenata. Osnovni rok odgovora za Srbiju je 30 dana;
   po GDPR-u jedan mesec kada se on primenjuje. Kod brisanja proveriti i Firebase,
   email, WhatsApp, poslovne kopije i lokalne Windows rezervne kopije.
2. Evidentirati reklamaciju i izdati broj. Odgovor do 8 dana; rešavanje do 15 dana,
   odnosno 30 dana za tehničku robu, uz zakonske izuzetke i pravila o produženju.
   Evidenciju čuvati najmanje 2 godine. Povrat/saobraznost ne uslovljavati ambalažom
   ili zapisnikom kurira. Trošak i rizik dostave nisu isto: prodavac snosi rizik
   do uručenja kada organizuje prevoz. Kupac snosi neposredni povratni trošak
   kod odustanka bez nedostatka, jer je o tome unapred obavešten.
3. Sa računovođom razvrstati račune, poreske i druge poslovne evidencije po stvarnom
   zakonskom roku. Ne stavljati jedan izmišljeni rok za sve porudžbine i prepisku.
   Kontaktne poruke, neaktivne kontakte pretplata, priloge i ostale zapise bez
   automatizovanog brisanja uključiti u redovan pregled potrebnosti. Brisanje
   dokaza pristanka ne briše automatski sve povezane poslovne ili kontaktne redove.
4. Potvrditi važeće ugovore o obradi i osnov svakog međunarodnog prenosa sa Renderom,
   Cloudflare-om, Google/Firebase, AWS, Apple i Meta/WhatsApp i angažovanim dostavljačima.
   EU SCC ili server u EU sami nisu potvrda osnova po srpskom ZZPL-u. U ovom pregledu
   nisu pregledani potpisani ugovori, ugovoreni planovi čuvanja logova i sve kopije.
   Utvrditi konkretne rokove i dopuniti politiku kada su ugovori potvrđeni.
5. **Referentna cena kod oglašenog sniženja:** vlasnik je 24.11.2026. potvrdio da nema
   potpunu istoriju cena. U web karticama, detaljima i skeletonu uklonjena je nepotvrđena
   precrtana cena; prikazuje se stvarna važeća prodajna cena. Obračun, kuponi i
   administrativno upravljanje cenama ostaju. Količinski obračun pakovanja baterija
   nije predstavljen kao istorijska cena istog pakovanja. Red događaja za obaveštenja
   nije potpuna, neizmenjiva istorija svih javno ponuđenih cena. Pre ponovnog oglašavanja
   prethodne cene ili procenta vremenskog sniženja potrebno je uspostaviti potpunu
   evidenciju, sačekati relevantni period ili obezbediti proverljiv istorijski izvor.
   Ne izmišljati početne podatke. Spoljni oglasi, ručno upisani opisi/baneri i šabloni
   poruka zahtevaju odvojenu proveru istih pravila. Ovaj paket nije rekonstruisao istoriju.
6. Zaposleni, radno praćenje i obrada u RFIDDaja zahtevaju zasebno obaveštenje i
   postupke. Politika kupaca ne služi kao njihov pristanak. Mobilni/desktop kod
   nije menjan ovim paketom. Pre stvarne ponude za EU proveriti ciljne države,
   potrošačke obaveze, GDPR teritorijalni obuhvat i eventualnog predstavnika.

## Izvori

- [Zakon o zaštiti podataka o ličnosti, 87/2018](https://www.parlament.gov.rs/upload/archive/files/lat/pdf/zakoni/2018/2959-18-lat.pdf), naročito čl. 21, 23 i 63–69.
- [Zakon o elektronskim komunikacijama, 35/2023](https://pravno-informacioni-sistem.rs/SlGlasnikPortal/eli/rep/sgrs/skupstina/zakon/2023/35/1), čl. 160.
- [Zakon o zaštiti potrošača, 35/2026](https://www.parlament.gov.rs/upload/archive/files/lat/pdf/zakoni/14_saziv/1317-26-lat..pdf), čl. 27–38, 48–63, 173; primena od 02.08.2026.
- [Izmene Zakona o trgovini, 35/2026](https://www.parlament.gov.rs/upload/archive/files/lat/pdf/zakoni/14_saziv/1266-26-lat..pdf), čl. 14 (prethodna cena).
- [Vansudsko rešavanje potrošačkih sporova](https://vansudsko.must.gov.rs/).
- [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng), [ePrivacy izmene](https://eur-lex.europa.eu/eli/dir/2009/136/oj/eng).
- [Cloudflare kolačići](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/), [Cloudflare DPA](https://www.cloudflare.com/cloudflare-customer-dpa/).
- [Render logovi](https://render.com/docs/logging), [Render DPA](https://render.com/dpa).
- [Google kolačići](https://policies.google.com/technologies/cookies?hl=en), [Firebase privatnost](https://firebase.google.com/support/privacy), [reCAPTCHA FAQ](https://docs.cloud.google.com/recaptcha/docs/faq).

Po izričitom uputstvu vlasnika nisu pokretani testovi, build, browser scenariji,
migracije na produkciji niti provera završetka deploya. Pregled koda nije dokaz
ponašanja produkcije, isporuke emaila ili potpune pravne usklađenosti.
