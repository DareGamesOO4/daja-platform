/** Customer notices, source version shared with the storefront. Business facts confirmed 2026-11-23. */
export const LEGAL_POLICY_VERSION = '2026-11-23-privacy-storage-v1';
export type LegalDocumentKind = 'privacy' | 'cookies' | 'terms' | 'withdrawal';
export interface LegalDocument {
  kind: LegalDocumentKind;
  title: string;
  updatedAt: string;
  ready: boolean;
  sections: Array<{ title: string; body: string[] }>;
}
export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    "kind": "privacy",
    "title": "Politika privatnosti",
    "updatedAt": "2026-11-23",
    "ready": true,
    "sections": [
      {
        "title": "Ko smo i na šta se politika odnosi",
        "body": [
          "Sajt dajashop.rs vodi TRGOVINSKO KOMISIONA RADNJA DAJA SHOP CVETKOVIĆ DEJAN PR NIŠ, matični broj 60556903, PIB 104852069, upisana u registar Agencije za privredne registre Republike Srbije. Sedište i adresa za pisma, povrat i reklamacije je Obrenovićeva bb, Podzemni prolaz, lokal C31, 18105 Niš, Srbija.",
          "Pišite nam na info@dajashop.rs ili pozovite +381 64 126 24 25. Na ovoj email adresi primamo i zahteve u vezi sa privatnošću. U nastavku koristimo naziv DAJA Shop ili „mi”.",
          "Ova politika objašnjava obradu podataka posetilaca, kupaca, korisnika naloga i primalaca obaveštenja na sajtu. Mi određujemo svrhe i načine obrade i imamo ulogu rukovaoca. Primenjujemo Zakon o zaštiti podataka o ličnosti Republike Srbije. Kada je konkretna obrada obuhvaćena GDPR-om, primenjuju se i njegova obavezna pravila. Prodavnica trenutno isporučuje u Srbiji; engleski prevod i informativne valute ne predstavljaju ponudu dostave u druge države."
        ]
      },
      {
        "title": "Kupovina, dostava i komunikacija",
        "body": [
          "Za porudžbinu koristimo ime i prezime, email, telefon, adresu, izabrane artikle, količine, cenu, popust, način isporuke i plaćanja i napomenu koju sami unesete. Ovi podaci služe za prijem i izvršenje ugovora, potvrdu porudžbine, dostavu i podršku. Bez podataka potrebnih za dostavu ne možemo poslati paket. Kupovina je moguća bez otvaranja naloga.",
          "Račune, podatke o prometu, reklamacije i druga obavezna dokumenta obrađujemo i radi zakonskih obaveza. Za zahteve pre kupovine osnov je preduzimanje radnji na vaš zahtev; za druge upite koristimo legitimni interes da odgovorimo i rešimo problem. Nepotrebne osetljive podatke, lozinke i podatke sa platnih kartica nemojte unositi u napomene ili kontakt poruke. Trenutno se plaća pouzećem i sajt ne prikuplja brojeve platnih kartica."
        ]
      },
      {
        "title": "Nalog i bezbedna prijava",
        "body": [
          "Ako otvorite nalog, čuvamo vaše kontakt podatke, zaštićenu vrednost lozinke ako je koristite, sačuvane adrese, korpu, listu želja, porudžbine i podešavanja obaveštenja. Osnov je pružanje naloga koji ste zatražili. Za zaštitu naloga i sprečavanje zloupotreba obrađujemo i sesije, vreme prijave, tehničke identifikatore i ograničenja neuspelih pokušaja na osnovu legitimnog interesa za bezbednost.",
          "Google prijava se pokreće kada je sami izaberete. Google nam prosleđuje podatke potrebne za prijavu, kao što su identifikator, ime, potvrđena email adresa i dostupna profilna slika. SMS potvrda koristi Google Firebase Authentication i reCAPTCHA tek kada zatražite kod. Google tada obrađuje broj telefona i tehničke podatke radi provere i sprečavanja zloupotreba. WhatsApp potvrda, kada je ponuđena, koristi Metinu platformu. Izbor jednog načina prijave ne predstavlja pristanak na marketing ili Google mapu.",
          "Ako koristite passkey, čuvamo javni ključ i podatke potrebne da proverimo prijavu. Otisak prsta, snimak lica i PIN kojima otključavate uređaj ne dobijamo. Njih proverava vaš uređaj ili izabrani upravljač pristupnim ključevima."
        ]
      },
      {
        "title": "Novosti i obaveštenja o proizvodima",
        "body": [
          "Novosti, praćenje cena, obaveštenje o dostupnosti i automatsko praćenje liste želja uključujete zasebno, za ponuđeni kanal i svrhu. Osnov je vaš pristanak. Obrada obuhvata kontakt, jezik, izabrani proizvod ili listu, datum i dokaz prijave i odjave, kao i status slanja. Kupovina, nalog i prihvatanje kolačića ne prijavljuju vas sami na novosti.",
          "Na novosti emailom prijavljujete se klikom na dugme „Prijavi me“. Uz prijavu beležimo datum, mesto prijave i verziju obaveštenja o pristanku. Iz svake poruke možete da se odjavite. Za popust na prvu porudžbinu koristimo potvrdu email adrese i proveravamo prethodne porudžbine; popust je vezan za potvrđenu adresu.",
          "Email poruke za obaveštenja imaju mogućnost odjave; podešavanja su dostupna i u nalogu. U WhatsApp razgovoru STOP isključuje novosti, STOP CENE praćenja cena, a STOP SVE sve WhatsApp pretplate. STOP SAT uz šifru iz poruke isključuje određeni sat. Odjava se odnosi na izabrani kanal i svrhu. Opoziv ne menja zakonitost ranije obrade. Neophodne poruke o konkretnoj porudžbini i bezbednosti naloga šaljemo po odgovarajućem ugovornom ili bezbednosnom osnovu."
        ]
      },
      {
        "title": "Recenzije, graviranje i sadržaj koji šaljete",
        "body": [
          "Ako objavite recenziju, javno se prikazuju odobreno ime za prikaz, ocena, tekst i datum. Ne unosite tuđe kontakt podatke ili osetljive informacije. Obrada omogućava funkciju koju ste zatražili; pregled sadržaja služi legitimnom interesu da uklonimo zloupotrebe. Prijava na nalog sama po sebi ne dokazuje da je recenzent kupio proizvod. Sadržaj ne označavamo kao potvrđenu kupovinu bez odgovarajuće provere.",
          "U editoru gravure obrađujemo tekst, odabrane motive, slike i raspored koje unesete. Nacrt se čuva na uređaju radi nastavka rada; pri korišćenju čuvanja na nalogu ili naručivanju podaci se šalju serveru. Sadržaj potvrđene gravure postaje deo porudžbine. Unesite samo sadržaj koji smete da koristite i podatke koji su potrebni za gravuru. Podatke drugih ljudi unosite samo kada za to imate odgovarajući osnov."
        ]
      },
      {
        "title": "Kolačići, keš i dobrovoljne usluge",
        "body": [
          "Neophodno tehničko čuvanje omogućava prijavu, sigurnost i funkcije koje tražite, poput korpe. Dodatno lokalno pamćenje i IndexedDB keš kataloga uključuju se uz zasebnu dozvolu. Google mapa, predlozi adrese i ocena prodavnice imaju zaseban izbor, a Cloudflare Web Analytics zaseban analitički izbor. Svi su podrazumevano isključeni. Izbor menjate preko „Podešavanja privatnosti” u podnožju sajta ili u nalogu.",
          "Serverski i Cloudflare keš javnog kataloga ubrzavaju prikaz istih javnih informacija posetiocima. Nalog, privatni podaci kupca, korpa i porudžbine ne smeju ulaziti u zajednički javni keš. Javne recenzije mogu biti deo javne stranice, ali se detalj proizvoda sa recenzijama ne upisuje u naš opcioni IndexedDB keš. Politika kolačića navodi nazive zapisa, svrhe i rokove."
        ]
      },
      {
        "title": "Ko prima podatke i gde se obrađuju",
        "body": [
          "Pristup imaju ovlašćena lica DAJA Shopa kada im je potreban za posao. Za isporuku, poštanskom operatoru, uključujući Post Express kada se koristi, dajemo podatke potrebne za paket i naplatu pouzeća. Računovodstvo i državni organi mogu dobiti podatke kada postoji zakonski osnov. Kontakt poruke i porudžbine mogu primati ovlašćeni zaposleni u poslovnim email sandučićima. Podatke ne prodajemo.",
          "Render Services obezbeđuje API, PostgreSQL bazu i Redis u regionu Frankfurt, Nemačka. Cloudflare pruža isporuku sajta, zaštitu saobraćaja, javni keš i skladištenje slika. Ovi pružaoci pri radu obrađuju i tehničke podatke, uključujući IP adresu i podatke o zahtevu. Frankfurt kao lokacija osnovne baze ne znači da se sva podrška, mrežna obrada i podobrađivači nalaze samo u Nemačkoj.",
          "Za email koristimo Amazon Web Services SES, uz konfigurisan rezervni tok preko Google Firebase funkcije i Apple iCloud SMTP-a kada glavni kanal nije dostupan. Za Google prijavu, SMS potvrdu, mapu i adresne predloge koristi se Google; za WhatsApp poruke Meta/WhatsApp. Ovi sistemi mogu obrađivati podatke u drugim državama, uključujući SAD. Spoljne društvene mreže dobijaju podatke kada otvorite njihov link ili sami pokrenete njihov servis.",
          "Za prenos u drugu državu potreban je primeren nivo zaštite ili druga primenljiva mera iz čl. 63–69 Zakona o zaštiti podataka o ličnosti. Kada se primenjuje GDPR, važe i njegova pravila o međunarodnom prenosu. Uslovi obrade pružalaca usluga predviđaju ugovorne mere, uključujući standardne ugovorne klauzule u odgovarajućim slučajevima; sama lokacija servera ili pristanak na kolačiće ne zamenjuju taj pravni osnov. Na info@dajashop.rs možete zatražiti informacije o konkretnom primaocu, državi i primenjenim merama i dostupnu kopiju zaštitnih klauzula."
        ]
      },
      {
        "title": "Koliko čuvamo podatke",
        "body": [
          "Podatke naloga čuvamo dok koristite nalog i dok su potrebni za uslugu. Gašenje naloga ili brisanje tražite emailom. To ne briše automatski račune, porudžbine ili dokaz o reklamaciji koji se moraju sačuvati po zakonu ili za rešavanje određenog spora. Za te dokumente rok određuju njihova vrsta, računovodstveni i poreski propisi i važeći rokovi zastarelosti. Evidencija reklamacija čuva se najmanje dve godine od podnošenja. Pristup izdvojenoj obaveznoj dokumentaciji ograničavamo na tu svrhu.",
          "Kontakt prepisku čuvamo dok je potrebna da odgovorimo, izvršimo dogovor ili zaštitimo prava u vezi sa konkretnim zahtevom. Poruke koje postanu deo porudžbine ili reklamacije prate rok te dokumentacije. Brisanje poruke iz sistema slanja ne briše kopiju u sandučetu primaoca; i te kopije podležu istim ograničenjima svrhe i potrebnosti.",
          "Dokaz izbora kolačića na serveru ima rok od pet godina od događaja. Dokaze email marketinškog pristanka čuvamo dok je pretplata aktivna i do tri godine po odjavi. To su rokovi našeg dokazivanja pristanka, a ne dozvola da vam po odjavi šaljemo marketing. Periodično čišćenje uklanja zapise kojima je istekao rok; postupak se ponavlja ako servis privremeno nije dostupan.",
          "Email potvrda pretplate važi 24 sata. Završen zapis u sistemu slanja emaila čisti se nakon 30 dana od nastanka, a povratne tehničke potvrde nakon 90 dana. WhatsApp nepotvrđene prijave uklanjaju se po isteku i dodatnom danu, a identifikatori primljenih događaja posle 30 dana. Završeni zapisi slanja uklanjaju se po isteku 90 dana od poslednje promene statusa. Opozvanu WhatsApp pretplatu i broj uklanjamo po isteku 90 dana od odjave, nakon završetka i uklanjanja povezanih slanja; ograničen dokaz sa heširanim brojem čuva se najduže 12 meseci od odjave. Heš je pseudonimizovan podatak, ne potpuno anoniman. Čišćenje se izvršava periodično.",
          "Google navodi da Firebase Authentication čuva evidentirane IP adrese nekoliko nedelja, a ostale podatke prijave do zahteva za brisanje odgovarajućeg Firebase korisnika. Nakon tog zahteva brisanje iz aktivnih i rezervnih sistema može trajati do 180 dana. Brisanje lokalne memorije pregledača nije takav zahtev. Za brisanje podataka prijave pišite nam na info@dajashop.rs; zahtev obuhvata i povezani Firebase zapis kada ga koristite.",
          "Serverski gostujući nacrt gravure važi 24 sata, a nacrt vezan za nalog 30 dana od poslednje izmene; fizičko čišćenje se pokreće pri narednim upisima gravura. Lokalni nacrt na vašem uređaju nema automatski rok i ostaje do brisanja podataka sajta. Gravura koja je potvrđena u porudžbini čuva se uz porudžbinu. Javna recenzija ostaje dok je objavljena; zahtev za ispravku ili uklanjanje možete poslati na naš kontakt.",
          "Tehnički logovi i rezervne kopije imaju cikluse čuvanja pružalaca usluga i naša pravila za oporavak i bezbednost. Renderovi aplikacioni logovi dostupni su 7, 14 ili 30 dana, zavisno od plana. Rok u radnoj bazi nije obećanje da je istog trenutka prepisana svaka rezervna kopija. Kopije ne koristimo za redovan marketing, a pri oporavku je potrebno ponovo primeniti prethodno evidentirane zahteve za brisanje."
        ]
      },
      {
        "title": "Vaša prava i kako nam se obraćate",
        "body": [
          "Možete zatražiti pristup i kopiju svojih podataka, ispravku, brisanje, ograničenje obrade i prenosivost kada su ispunjeni zakonski uslovi. Možete povući pristanak i podneti prigovor na obradu zasnovanu na legitimnom interesu. Prigovor na direktni marketing uvažavamo bez potrebe da obrazlažete svoj razlog. Za zahtev nije potrebno da imate nalog ili da prihvatite opcione kolačiće.",
          "Pošaljite zahtev na info@dajashop.rs uz kontakt preko kog možemo da vas prepoznamo. Tražimo samo podatke potrebne da sprečimo predaju podataka pogrešnoj osobi. Odgovaramo bez nepotrebnog odlaganja, najkasnije u roku od 30 dana prema srpskom zakonu; ako se primenjuje GDPR, u roku od jednog meseca. Ako zakon dopušta produženje zbog složenosti ili broja zahteva, u prvobitnom roku ćemo objasniti razlog i novi rok. Zahtevi su po pravilu besplatni.",
          "Možete podneti pritužbu Povereniku za informacije od javnog značaja i zaštitu podataka o ličnosti putem www.poverenik.rs. Kada se primenjuje GDPR, možete se obratiti i nadležnom organu u EU, naročito u državi uobičajenog boravišta, rada ili navodne povrede. Ne donosimo odluke sa pravnim ili sličnim značajnim posledicama po vas isključivo automatizovanom obradom. Pravila kupona i obaveštenja o cenama ne zamenjuju vaše pravo da nam se obratite i zatražite ljudsku proveru."
        ]
      },
      {
        "title": "Bezbednost i izmene politike",
        "body": [
          "Koristimo šifrovan prenos, ograničenja pristupa, bezbednosne sesije i provere zahteva. Nijedan sistem ne može garantovati apsolutnu bezbednost. Ako nastane povreda podataka, procenjujemo rizik i obaveštavamo nadležni organ i pogođene osobe kada zakon to zahteva. Podatke zaposlenih u poslovnim aplikacijama obrađujemo prema zasebnim obaveštenjima za zaposlene.",
          "Datum ove verzije je naveden na vrhu. Važne izmene objavljujemo na sajtu i, kada je potrebno, obaveštavamo korisnike. Nova opciona svrha neće biti uključena samo zato što ste ranije prihvatili druga podešavanja. Prevod služi lakšem razumevanju; obavezna zakonska prava ostaju na snazi."
        ]
      }
    ]
  },
  {
    "kind": "cookies",
    "title": "Politika kolačića i lokalne memorije",
    "updatedAt": "2026-11-23",
    "ready": true,
    "sections": [
      {
        "title": "Kako birate šta se pamti",
        "body": [
          "Sajt dajashop.rs vodi TRGOVINSKO KOMISIONA RADNJA DAJA SHOP CVETKOVIĆ DEJAN PR NIŠ, matični broj 60556903, PIB 104852069, upisana u registar Agencije za privredne registre Republike Srbije. Sedište i adresa za pisma, povrat i reklamacije je Obrenovićeva bb, Podzemni prolaz, lokal C31, 18105 Niš, Srbija.",
          "Kolačić je mali zapis koji pregledač šalje sajtu uz zahtev. localStorage, sessionStorage i IndexedDB čuvaju podatke u pregledaču na drugi način. Ova politika obuhvata sve te zapise. Neophodne koristimo za komunikaciju, bezbednost i uslugu koju tražite. Za dodatno lokalno pamćenje, Google usluge i analitiku tražimo odvojene dozvole. „Samo neophodni” odbija sve opcione svrhe jednim izborom.",
          "Podešavanja možete ponovo otvoriti preko „Podešavanja privatnosti” u podnožju ili u nalogu. Povlačenjem dozvole za lokalno pamćenje brišemo naše opcione zapise i bazu keša proizvoda. Povlačenjem analitike stranica se može osvežiti da bi se zaustavila već učitana skripta. Google sadržaj se uklanja, ali sajt ne može obrisati kolačiće koje je Google postavio na sopstvenom domenu; njih uklanjate kroz podešavanja pregledača."
        ]
      },
      {
        "title": "Neophodni kolačići na dajashop.rs",
        "body": [
          "__Host-daja_customer i __Host-daja_staff služe prijavi kupca, odnosno ovlašćenog osoblja. Važe do isteka pristupnog tokena, najviše 15 minuta. __Host-daja_refresh obnavlja prijavu, podrazumevano do 30 dana od izdavanja ili obnove. __Host-daja_csrf štiti zahteve od zloupotrebe i važi 30 dana. Odjava uklanja kolačiće sesije. Kolačići prijave su Secure i HttpOnly; CSRF vrednost može čitati sajt radi slanja zaštićenog zahteva.",
          "__Host-daja_oauth i __Host-daja_phone povezuju započetu Google ili telefonsku prijavu sa vašim pregledačem, najviše 10 minuta. __Host-daja_passkey važi najviše 5 minuta. Završetak ili prekid odgovarajućeg postupka može ih ukloniti ranije. daja_language_choice pamti jezik koji sami izaberete do godinu dana. Prikaz jezika konkretne stranice i dalje određuje njena adresa."
        ]
      },
      {
        "title": "Neophodna lokalna memorija",
        "body": [
          "dajashop_privacy_receipt u localStorage čuva nasumičnu oznaku dokaza, verziju politike, vaš izbor i datum isteka. Izbor važi 180 dana, pa se traži novi; nova važna verzija može zahtevati raniji ponovni izbor. Zapis nije identifikator za oglašavanje. Ako pregledač blokira čuvanje, pitanje se može ponovo pojaviti pri sledećem otvaranju.",
          "cart, daja_wishlist i zapisi sačuvanih artikala omogućavaju korpu, listu želja i „sačuvaj za kasnije”. daja_active_promo, daja_welcome_promo_removed_for i daja_kod_dobrodoslice_na_cekanju pamte korišćenje ili uklanjanje kupona. dajashop_product_alert_state pamti potvrđen pristup upravljanju obaveštenjima. Ovi zapisi se menjaju ili brišu korišćenjem odgovarajuće funkcije i trenutno nemaju poseban automatski rok u pregledaču. Možete ih ukloniti brisanjem podataka sajta. Važenje kupona i pristupa dodatno proverava server.",
          "Kolačić __Host-daja_welcome čuva dokaz potvrde emaila za korišćenje kupona dobrodošlice u istom pregledaču do 30 dana. Možete ga ukloniti brisanjem podataka sajta.",
          "dajashop_language i dajashop_currency pamte prikaz jezika i izabranu informativnu valutu bez posebnog automatskog isteka u localStorage. daja_oauth_browser_state u sessionStorage važi 10 minuta i troši se pri obradi povratka sa prijave. daja:checkout-attempt:* sprečava dupliranje iste porudžbine i uklanja se posle potvrđenog ishoda ili zatvaranjem sesije kartice. daja-chunk-reload-at sprečava petlju osvežavanja, a daja:prelaunch-notice-dismissed pamti zatvaranje obaveštenja, tokom sesije kartice.",
          "Kratkotrajne oznake zaključavanja osvežavanja prijave u localStorage sprečavaju sudar između otvorenih kartica. Brava važi najviše 60 sekundi i normalno se uklanja odmah po završetku. Ako se kartica naglo zatvori, nevažeći zapis može fizički ostati do naredne upotrebe ili brisanja podataka sajta."
        ]
      },
      {
        "title": "Dobrovoljno lokalno pamćenje",
        "body": [
          "theme, dajashop_newsletter_seen i engraving-auto-suggestions pamte temu, zatvaranje ponude za novosti i izbor automatskih predloga gravure do 180 dana od upisa. daja_last_login može pamtiti način prijave i prikaz poslednjeg naloga do 30 dana. Pomoćni daja:preference-expiry:* zapisi čuvaju samo rok tih vrednosti. Istekle vrednosti se ne koriste i uklanjaju se pri narednom čitanju ili povlačenju dozvole.",
          "catalog-scroll:* u sessionStorage pamti poziciju u katalogu do završetka sesije kartice. U IndexedDB bazi daja-public-catalog-v2 čuvamo samo dozvoljene javne stranice kataloga i proizvode bez javnih recenzija. Podatak važi najviše 5 minuta od serverske potvrde, a uobičajena svežina cene je kraća. Granice su 40 proizvoda, 3 početne liste i približno 4 MB. Nema kopije naloga, adrese ili porudžbine u toj bazi.",
          "Istek keša ograničava njegovo korišćenje. Čišćenje se obavlja dok sajt radi i pri sledećem pristupu; zatvoren pregledač ne može izvršavati naš kod, pa istekli bajtovi mogu ostati na disku do narednog čišćenja. Opoziv dozvole pokreće brisanje cele baze i zaustavlja nove upise. Ugrađeni HTTP keš pregledača za slike, fontove i programske fajlove ima rokove iz zaglavlja odgovora i može se obrisati ranije odlukom pregledača; nije naš IndexedDB keš."
        ]
      },
      {
        "title": "Serverski keš i javni fajlovi",
        "body": [
          "Za javni katalog server i Cloudflare koriste odvojene kopije podataka: uobičajena svežina je 30 sekundi, a dozvoljeno rezervno prikazivanje pri prekidu najviše 5 minuta od potvrde servera. Takav prikaz je označen kao poslednja poznata cena; obračun porudžbine se proverava na serveru. To nije dokaz pristanka niti kopija vašeg naloga. Za stranice naloga, porudžbine i pravne dokumente odgovori nalažu da se ne čuvaju u zajedničkom kešu.",
          "HTTP zaglavlja za verzionisane programske fajlove u /assets/ dozvoljavaju keš do 365 dana, a za statične slike u /images/ do 7 dana. Javno objavljene slike proizvoda preko image servisa mogu imati keš do 365 dana; privremeni izvori vraćaju zabranu čuvanja. Pregledač može podatke ukloniti i ranije zbog prostora ili vašeg izbora. Ove kopije resursa ne služe praćenju posetilaca."
        ]
      },
      {
        "title": "Google i Cloudflare",
        "body": [
          "Google Maps i Places učitavamo tek kada dozvolite Google usluge. Google tada može primiti IP adresu, podatke uređaja i adresu koju unosite, a zapisi na njegovim domenima zavise od usluge i prijavljenosti na Google nalog. Ručno unošenje adrese ostaje dostupno. Google prijava i Firebase SMS/reCAPTCHA pokreću se zasebno, na vaš zahtev za taj način prijave. Firebase prijava na našem sajtu koristi memoriju trenutne stranice, bez trajnog Firebase naloga u localStorage.",
          "Google može postaviti bezbednosni kolačić _GRECAPTCHA kada pokrenete reCAPTCHA proveru. Njegov rok zavisi od odgovora usluge i može se videti u pregledaču; ne određujemo ga mi. Google za NID navodi 6 meseci od poslednjeg korišćenja, za _Secure-ENID 13 meseci, a za bezbednosne SID i HSID 2 godine. To su primeri Google zapisa, a ne tvrdnja da se svi postavljaju svakom posetiocu. Ove servise ne pokrećemo samim otvaranjem kataloga. Izvor i objašnjenja su policies.google.com/technologies/cookies i policies.google.com/privacy.",
          "Cloudflare može postaviti zaštitni cf_clearance pri bezbednosnoj proveri. Za našu zonu vreme prolaska izazova podešeno je na 30 minuta; Cloudflare može obnavljati vrednost u okviru svoje zaštite. Ako je primenjena bot zaštita koja koristi __cf_bm, on ističe nakon 30 minuta neaktivnosti. To su uslovni zaštitni zapisi, a ne tvrdnja da ih svaki posetilac dobija. Automatsko ubacivanje Cloudflare Web Analytics skripte je isključeno; naša skripta se uključuje tek uz analitički pristanak i ne koristi klasične analitičke kolačiće."
        ]
      },
      {
        "title": "Gravure, administracija i brisanje podataka uređaja",
        "body": [
          "IndexedDB daja-engraving čuva nacrte koje pravite u editoru, uključujući tekst i slike. To omogućava traženi nastavak uređivanja i nema automatski lokalni rok. Ovlašćeno osoblje koristi daja-admin-media-queue za izabrane fajlove i nastavak prenosa, nacrte proizvoda, identifikator uređaja i red nezavršenih radnih događaja. Završeni poslovi se uklanjaju kroz radnu funkciju; nezavršeni mogu ostati do nastavka ili ručnog uklanjanja. daja_workforce_layout:* je opciono podešavanje rasporeda, do 180 dana. Posetiocima prodavnice ovi administrativni podaci nisu potrebni.",
          "Podatke uređaja možete ukloniti kroz podešavanja privatnosti pregledača za dajashop.rs. To može odjaviti nalog i ukloniti lokalnu korpu, nacrte i zapamćene izbore. Brisanje podataka uređaja ne briše porudžbine ili nalog na serveru; za to nam pišite na info@dajashop.rs. Na sajtu ne koristimo Meta Pixel, Google Analytics ni druge marketinške piksele; zasebna prijava na email ili WhatsApp nije kolačić."
        ]
      }
    ]
  },
  {
    "kind": "terms",
    "title": "Uslovi kupovine i korišćenja",
    "updatedAt": "2026-11-23",
    "ready": true,
    "sections": [
      {
        "title": "Prodavac i kontakt",
        "body": [
          "Sajt dajashop.rs vodi TRGOVINSKO KOMISIONA RADNJA DAJA SHOP CVETKOVIĆ DEJAN PR NIŠ, matični broj 60556903, PIB 104852069, upisana u registar Agencije za privredne registre Republike Srbije. Sedište i adresa za pisma, povrat i reklamacije je Obrenovićeva bb, Podzemni prolaz, lokal C31, 18105 Niš, Srbija.",
          "Pišite nam na info@dajashop.rs ili pozovite +381 64 126 24 25. Na ovoj email adresi primamo i zahteve u vezi sa privatnošću. U nastavku koristimo naziv DAJA Shop ili „mi”.",
          "Ovi uslovi uređuju internet kupovinu i korišćenje DAJA Shopa. Za potrošače važe obavezna prava iz propisa Republike Srbije. Nijedna odredba ne isključuje odgovornost ili pravo koje se po zakonu ne može isključiti. Za postojeću porudžbinu važi verzija uslova uz koju je poslata; naknadna izmena ne menja samostalno dogovorenu cenu ili prava iz te porudžbine."
        ]
      },
      {
        "title": "Proizvodi, cene i plaćanje",
        "body": [
          "Osnovne karakteristike, varijante i dostupnost prikazani su uz proizvod. Fotografije služe predstavljanju artikla; razlike zbog ekrana ne opravdavaju isporuku drugačijeg proizvoda. Cene i obračun porudžbine su u RSD, sa uključenim primenljivim porezima. Druga valuta je informativna protivvrednost po prikazanom kursu i datumu. Dostava, popust i ukupan iznos prikazuju se pre konačnog slanja porudžbine. Plaćanje je pouzećem prilikom isporuke.",
          "Trudimo se da cene budu tačne i ažurne. Ipak, može doći do greške u unosu, tehničkog problema ili kašnjenja u ažuriranju, uključujući propušteno povećanje ili sniženje cene. Ako grešku utvrdimo pre prihvatanja porudžbine, obavestićemo vas bez odlaganja, navesti tačnu cenu i zatražiti da se izričito izjasnite da li prihvatate novu ponudu. Ćutanje se ne smatra pristankom. Ako je ne prihvatite, porudžbinu nećemo izvršiti po promenjenoj ceni niti vam zbog toga naplatiti naknadu; eventualno primljen novac biće vraćen. Ova odredba ne daje nam pravo da jednostrano menjamo cenu već zaključenog ugovora ili da isključimo vaša zakonska prava.",
          "Dodavanje u korpu samo po sebi ne rezerviše proizvod. Ako je potrebno osvežiti cenu ili obračun pre prijema porudžbine, prikazujemo novi iznos i tražimo da ga ponovo potvrdite. Po prijemu porudžbine ne povećavamo cenu bez vašeg pristanka. Ako artikla nema ili otkrijemo grešku koja onemogućava isporuku, obavestićemo vas i dogovoriti zakonito rešenje ili povrat već plaćenog iznosa. Zamenski proizvod šaljemo samo uz vaš pristanak."
        ]
      },
      {
        "title": "Kako nastaje porudžbina",
        "body": [
          "Izaberite artikle i količine, unesite kontakt i adresu, pa proverite poslednji pregled porudžbine. Do slanja možete menjati stavke i podatke. Pritiskom na „Poruči uz obavezu plaćanja” šaljete porudžbinu za prikazane proizvode i ukupan iznos, uz ove uslove. Potvrda primljenog zahteva i podaci porudžbine prikazuju se na sajtu i šalju na uneti email. Ugovor se zaključuje kada potvrdimo prihvatanje porudžbine; ako poruka potvrđuje samo prijem zahteva, to je u njoj naznačeno.",
          "Uslove i obrazac za odustanak možete sačuvati ili odštampati sa sajta. Kopija se dostavlja i u email potvrdi. Evidenciju porudžbine čuvamo radi izvršenja ugovora i obaveznih evidencija. Pristup svojim porudžbinama imate kroz nalog kada su povezane sa njim, a podatke možete zatražiti i kontaktom sa nama. Ugovaranje je na srpskom jeziku; dostupan je i engleski prevod. Otvaranje naloga i prijava na marketing nisu uslov kupovine."
        ]
      },
      {
        "title": "Dostava u Srbiji",
        "body": [
          "Isporuku trenutno vršimo na teritoriji Republike Srbije. Koristimo poštanske i kurirske usluge, uključujući Post Express kada je odabran za pošiljku. Trošak isporuke koji plaćate naveden je u poslednjem pregledu porudžbine; dodatni nenajavljeni troškovi nisu vaša obaveza. Uobičajeni transport traje 1–3 radna dana nakon slanja. Vreme pripreme, graviranja ili drugačiji ugovoreni rok saopštavamo pre prihvatanja kada je primenljivo. Bez posebnog dogovora zakonski rok isporuke je najviše 30 dana od zaključenja ugovora.",
          "Molimo vas da unesete tačnu adresu i omogućite prijem pošiljke. Ako kasni, izgubi se ili stigne oštećena, obratite nam se da rešimo isporuku sa operatorom. Rizik slučajne propasti ili oštećenja prelazi na vas tek kada vi ili lice koje ste odredili, a koje nije prevoznik, preuzmete robu. Posebno pravilo može važiti ako sami angažujete prevoznika kog nismo ponudili. Pregled paketa i fotografija oštećenja mogu pomoći, ali izostanak zapisnika kurira ne ukida zakonska prava."
        ]
      },
      {
        "title": "Odustanak od internet kupovine",
        "body": [
          "Kao potrošač možete odustati bez navođenja razloga u roku od 14 dana od prijema robe. Ako jedna porudžbina stiže u odvojenim isporukama, rok za tu porudžbinu računa se od prijema poslednjeg proizvoda ili dela, prema zakonu. Dovoljno je da u roku pošaljete nedvosmislenu izjavu na info@dajashop.rs ili na našu adresu. Možete koristiti obrazac na stranici „Obrazac za odustanak”, ali korišćenje obrasca nije uslov.",
          "Robu pošaljite nazad najkasnije 14 dana od slanja izjave o odustanku. Kod odustanka bez nedostatka robe vi snosite neposredni trošak vraćanja, osim ako se posebno dogovorimo da ga snosimo mi. Možete koristiti Post Express ili drugog pouzdanog operatora; sačuvajte dokaz slanja. Koristite zaštitno pakovanje. Originalna ambalaža nije opšti uslov za odustanak ili reklamaciju. Odgovarate samo za umanjenje vrednosti nastalo rukovanjem koje prevazilazi proveru prirode, karakteristika i funkcionalnosti proizvoda.",
          "Vraćamo primljeni iznos, uključujući trošak najjeftinije uobičajene ponuđene dostave, najkasnije 14 dana od prijema izjave. Možemo sačekati prijem robe ili dokaz da ste je poslali, prema tome šta nastupi ranije, osim kada sami preuzimamo robu. Povrat je istim sredstvom plaćanja, osim ako izričito prihvatite drugo sredstvo bez dodatnog troška za vas. Za pouzeće možemo sa vama dogovoriti povrat na račun; ne namećemo vaučer umesto novca."
        ]
      },
      {
        "title": "Personalizovani proizvodi i gravura",
        "body": [
          "Zakonsko pravo na odustanak bez razloga ne važi za robu izrađenu prema vašim posebnim zahtevima ili jasno personalizovanu, kao što je sat sa naručenom ličnom gravurom. O tome vas obaveštavamo pre slanja porudžbine. Izbor standardnog modela, boje ili veličine sam po sebi ne ukida pravo na odustanak. I za personalizovanu robu ostaju prava zbog nesaobraznosti, pogrešne izrade ili drugog nedostatka.",
          "Pre potvrde pažljivo proverite tekst, datume, raspored i sliku gravure. Dužni ste da imate prava na poslati sadržaj. Pregled na ekranu je pomoć pri izboru; prodavac ostaje odgovoran za izradu u skladu sa dogovorenim karakteristikama. Ako želite da izmenite ili otkažete gravuru, javite se odmah da proverimo da li je izrada već započeta."
        ]
      },
      {
        "title": "Saobraznost, garancija i reklamacije",
        "body": [
          "Prodavac odgovara za nesaobraznost robe koja se pojavi u roku od dve godine od isporuke potrošaču. O uočenoj nesaobraznosti obavestite nas u zakonskom roku od dva meseca od saznanja, najkasnije u roku odgovornosti. Ako se pojavi u prvoj godini, primenjuje se zakonska pretpostavka da je postojala pri isporuci, osim kada je to nespojivo sa prirodom robe ili nedostatka. Komercijalna garancija, ako je uz proizvod posebno data, pruža dodatna prava i ne zamenjuje ovu odgovornost.",
          "Reklamaciju možete podneti lično na adresi prodavnice, telefonom, poštom ili na info@dajashop.rs, uz račun ili drugi dokaz kupovine. Opišite problem i željeni način rešavanja. Bez odlaganja potvrđujemo prijem i saopštavamo evidencioni broj. Pisani ili elektronski odgovor dajemo najkasnije za osam dana. Rok rešavanja je do 15 dana, odnosno do 30 dana za tehničku robu, uz zakonom propisana pravila o izjašnjenju potrošača i zastoju roka. Produženje je moguće jednom, iz objektivnih razloga i uz vaš pristanak.",
          "U zakonskim uslovima možete zahtevati besplatnu opravku ili zamenu, odgovarajuće umanjenje cene ili raskid ugovora. Za nedostatak koji se pojavi u prvih 30 dana postoje posebna prava izbora zamene, umanjenja ili raskida. Potrebne troškove opravke, zamene, preuzimanja i slanja zbog nesaobraznosti snosi prodavac. Ne naplaćujemo utvrđivanje nesaobraznosti. Za instrukcije slanja o našem trošku javite nam se pri prijavi. Nedostatak originalne ambalaže nije razlog da odbijemo reklamaciju."
        ]
      },
      {
        "title": "Rešavanje sporova",
        "body": [
          "Ako problem ne rešimo reklamacijom, možete pokrenuti postupak pred telom za vansudsko rešavanje potrošačkih sporova. DAJA Shop je po zakonu obavezan da učestvuje. Informacije, lista tela i pristup postupku dostupni su preko Ministarstva unutrašnje i spoljne trgovine i portala vansudsko.must.gov.rs. Time se ne isključuje pravo na sudsku zaštitu. Ne ugovaramo isključivu nadležnost suda kojom bi potrošač izgubio zakonsko pravo izbora.",
          "Glavni okvir ovih uslova je pravo Srbije. Ako je u konkretnom slučaju obavezno pravo druge države primenljivo na potrošača, izbor srpskog prava ga ne lišava zaštite od koje se ne može odstupiti. Ovi uslovi ne tvrde da ispunjavaju sve nacionalne obaveze za prodaju u svakoj državi EU; prekogranična isporuka trenutno nije ponuđena."
        ]
      },
      {
        "title": "Korišćenje sajta i privatnost",
        "body": [
          "Koristite tačne podatke i čuvajte pristup svom nalogu. Zabranjeni su neovlašćen pristup, ometanje rada i objavljivanje nezakonitog ili tuđeg zaštićenog sadržaja bez osnova. Sadržaj sajta koristite u skladu sa autorskim i drugim pravima. Tehnički prekid ne znači da je prethodno poslata porudžbina otkazana; pre ponavljanja proverite potvrdu ili nas kontaktirajte. Za objašnjenje obrade podataka i izbora tehnologija pročitajte Politiku privatnosti i Politiku kolačića."
        ]
      }
    ]
  },
  {
    "kind": "withdrawal",
    "title": "Obrazac za odustanak",
    "updatedAt": "2026-11-23",
    "ready": true,
    "sections": [
      {
        "title": "Kako poslati izjavu",
        "body": [
          "Ovaj obrazac popunite samo ako želite da odustanete od ugovora. Možete ga odštampati ili prepisati u email i poslati na info@dajashop.rs, odnosno poštom na navedenu adresu. Dovoljna je i druga nedvosmislena izjava. Potpis je potreban samo ako obrazac šaljete na papiru.",
          "Sajt dajashop.rs vodi TRGOVINSKO KOMISIONA RADNJA DAJA SHOP CVETKOVIĆ DEJAN PR NIŠ, matični broj 60556903, PIB 104852069, upisana u registar Agencije za privredne registre Republike Srbije. Sedište i adresa za pisma, povrat i reklamacije je Obrenovićeva bb, Podzemni prolaz, lokal C31, 18105 Niš, Srbija.",
          "Ovim izjavljujem da odustajem od ugovora o prodaji sledeće robe / pružanju sledeće usluge (precrtati nepotrebno).",
          "Opis robe/usluge i broj porudžbine, ako je poznat ______________________________",
          "Datum naručivanja __________________  Datum prijema __________________",
          "Ime i prezime potrošača ______________________________",
          "Adresa potrošača ______________________________",
          "Email ili telefon za odgovor (opciono) ______________________________",
          "Datum izjave __________________  Potpis (samo za papirni obrazac) __________________",
          "Podatke iz izjave koristimo za obradu odustanka i zakonske evidencije, prema Politici privatnosti. Ovaj obrazac ne daje pristanak na marketing. Detalje o rokovima, troškovima vraćanja i izuzecima za jasno personalizovanu robu pročitajte u Uslovima kupovine i korišćenja."
        ]
      }
    ]
  }
];

export function legalDocument(kind: LegalDocumentKind): LegalDocument {
  const document = LEGAL_DOCUMENTS.find(item => item.kind === kind);
  if (!document) throw new Error(`Unknown legal document: ${kind}`);
  return document;
}
