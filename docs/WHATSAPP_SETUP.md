# DAJA WhatsApp — novo povezivanje, 05.11.2026.

Korisnik radi Meta podesavanja; kod, red slanja i web priprema su u DAJA projektima.

## Potvrdjeno u prijavljenoj Meta konzoli

- Novi nalog: Daja Shop, WABA 1888317035945342, Account status Approved.
- Broj: +381641262425; Phone Profile ID: 1329253216947689.
- Broj je povezan sa Cloud API i prikazuje Registered. App DajaShop Poruke
  (1444767067083457) je uspesno objavljena. API sender ID je potvrdjen kao
  1329253216947689. Webhook je validiran; messages v27.0 je Subscribed, a novi
  WABA je vratio Successfully subscribed to webhooks.
- API token, App Secret, verify token, sender broj/ID, Graph v25.0 i zasebni OTP
  HMAC kljuc sacuvani su u Render environment tajnama. Nema tajni u ovom dokumentu.
- Newsletter i promena cene, sr/en: sva cetiri predloska su podneta kao Marketing
  i imaju In review. Authentication daja_verification_v1 NIJE kreiran: Meta vraca
  This WhatsApp business account does not have permission to create message template.
- Poslovna verifikacija firme je In review; Meta navodi oko dva radna dana.
  To je moguc uzrok OTP zabrane, ali greška ne navodi precizniji uslov. Posle
  verifikacije ponoviti Authentication zahtev; ako ostane zabrana, traziti Meta
  podrsku sa app ID/WABA ID i tacnom greskom. Ne obecavati da verifikacija sama
  sigurno resava zabranu.
- Slanje jos nije ukljuceno: approval/enabled zastavice ostaju false dok potrebni
  predlosci nisu odobreni. Nije proveravan zavrsetak deploy-a niti slata probna poruka.
- WhatsApp povratak na stanje je na zahtev korisnika iskljucen; njegov predlozak
  nije podnet i nije uslov za newsletter/promenu cene.
- Korisnik je odobrio zasebno sr/en obavestenje o WhatsApp privatnosti i brisanju:
  https://dajashop.rs/whatsapp-privacy. Taj URL je sacuvan u Meta app Privacy Policy
  i User Data Deletion poljima. Opsta /privacy stranica ostaje tehnicki nacrt.
- Ranija blokada naloga 2239869233236176 nije status ovog novog naloga.

## Sta korisnik radi u Meti

1. U Meta for Developers otvori poslovnu aplikaciju i WhatsApp API Setup.
   Povezi ovaj broj kroz opciju koju Meta nudi za konkretan nalog. Samo dodavanje
   broja u Business Suite ne potvrdjuje API povezivanje. Ako Meta prijavi da broj
   vec koristi Business App, prati njen ponudjeni onboarding; ne brisi nalog niti
   migriraj broj naslepo. Phone Number ID mora biti onaj iz API Setup ekrana.
2. Obezbedi serverski token za konkretan nalog/broj, sa
   whatsapp_business_messaging pristupom. Token, App Secret i ostale tajne upisi
   direktno u Render environment secrets; ne salji ih u chat ili Git.
3. U aplikaciji postavi callback:
   https://daja-platform-api.onrender.com/api/v1/whatsapp/webhook
   Verify token mora biti ista nasumicna tajna kao WHATSAPP_WEBHOOK_VERIFY_TOKEN
   na Renderu. WHATSAPP_APP_SECRET je App Secret iste Meta aplikacije.
   Ukljuci messages webhook i povezi/pretplati aplikaciju na odgovarajuci WABA.
4. Kreiraj sledece predloske, po srpsku (sr) i englesku (en) verziju.
   Koristi pozicione parametre u body delu, bez dodatnih obaveznih parametara,
   slika ili dinamickih URL dugmadi u predloscima za obavestenja. STOP je odgovor
   tekstom. Meta odredjuje kategoriju i odobrenje; odobrenje nije obecano.
5. Tek nakon potvrde API broja, tokena, webhooka i predlozaka ukljuci odgovarajuce
   approval i enabled zastavice na Renderu. Broj mora biti spreman za API slanje.

## Predlosci koje kod ocekuje

### daja_verification_v1 — Authentication

Oba jezika, Meta-generisan OTP tekst, Copy code dugme, sigurnosna preporuka,
istek i validity 5 minuta. Jedan kod je body parametar {{1}} i OTP URL dugme 0.
Detalji: WHATSAPP_OTP.md. Ne praviti ovaj predlozak kao Marketing.

### daja_newsletter_v1 — Marketing

sr: DajaShop novosti: {{1}}. Za odjavu odgovorite STOP.
en: DajaShop news: {{1}}. Reply STOP to unsubscribe.

Primer {{1}}: Pogledajte novitete u nasoj ponudi na https://dajashop.rs/catalog
(Engleski primer: See what is new at https://dajashop.rs/en/catalog.)

### daja_price_change_v1 — prijavljena promena cene

sr: DajaShop: cena artikla {{1}} promenjena je sa {{2}} na {{3}}. Detalji: {{4}}. Za odjavu odgovorite STOP.
en: DajaShop: the price of {{1}} changed from {{2}} to {{3}}. Details: {{4}}. Reply STOP to unsubscribe.

Primeri parametara redom: Casio MTP; 5.000,00 RSD; 4.500,00 RSD;
https://dajashop.rs/product/primer
Ovaj predlozak pokriva i snizenje i povecanje cene. Stari daja_price_drop_v1
nije zamena za ovaj tekst. Za kategoriju prihvati Metinu odluku; ne ukljucuj
slanje pre odobrenja. Ne dodavati promocije u transakcioni predlozak.

### daja_back_in_stock_v1 — iskljuceno, ne kreirati sada

sr: DajaShop: artikal {{1}} je ponovo na stanju. Cena: {{2}}. Detalji: {{3}}. Za odjavu odgovorite STOP.
en: DajaShop: {{1}} is back in stock. Price: {{2}}. Details: {{3}}. Reply STOP to unsubscribe.

Primeri parametara redom: Casio MTP; 4.500,00 RSD;
https://dajashop.rs/product/primer

## Render — daja-platform-api

Postavi (tajne samo u serverski secret store):

WHATSAPP_BUSINESS_PHONE=+381641262425
WHATSAPP_PHONE_NUMBER_ID=<potvrdjeni Phone Number ID iz API Setup>
WHATSAPP_GRAPH_API_VERSION=<podrzana verzija iz API Setup, oblik vNN.0>
WHATSAPP_ACCESS_TOKEN=<serverski token>
WHATSAPP_APP_SECRET=<App Secret iste Meta aplikacije>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<nasumicna tajna najmanje 32 znaka>
WHATSAPP_OTP_SECRET=<zasebna nasumicna tajna najmanje 32 znaka>
WHATSAPP_OTP_TEMPLATE_NAME=daja_verification_v1
WHATSAPP_NEWSLETTER_TEMPLATE=daja_newsletter_v1
WHATSAPP_PRICE_TEMPLATE=daja_price_change_v1
WHATSAPP_STOCK_TEMPLATE=daja_back_in_stock_v1
WHATSAPP_OTP_DAILY_LIMIT=100
WHATSAPP_NOTIFICATION_DAILY_LIMIT=100

Dok Meta deo nije spreman, ostaju false:
WHATSAPP_OTP_ENABLED=false
WHATSAPP_OTP_TEMPLATES_APPROVED=false
WHATSAPP_NOTIFICATIONS_ENABLED=false
WHATSAPP_NOTIFICATION_TEMPLATES_APPROVED=false
WHATSAPP_STOCK_ALERTS_ENABLED=false

OTP zastavice ukljuciti nakon odobrenja oba OTP jezika. Notification zastavice
ukljuciti nakon odobrenja newsletter i price-change predlozaka u oba jezika i webhooka.
Stock predlozak nije potreban dok je WHATSAPP_STOCK_ALERTS_ENABLED=false.
Nijedna tajna nije potrebna u web projektu. Postojeci PUBLIC_ORGANIZATION_ID,
PostgreSQL i Redis koriste se i za ovaj tok. Migracija 103 ide uz standardni API
startup/migration postupak; nema novog posebnog placenog workera.

Detalji implementacije i ogranicenja: WHATSAPP_NOTIFICATIONS.md.
