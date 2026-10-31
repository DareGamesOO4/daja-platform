# Zaštićen API i browser sesije — 31.10.2026.

## Sačuvano stanje pre izmena

Git oznaka u sva tri projekta: `rollback/security-edge-20261031`.

| Projekat | Revizija pre izmena |
|---|---|
| daja-platform | `90685b28d7f69989c9e32022fd3bd4e970f7be95` |
| dajashopweb | `80caf40b81ecec2eca9eb7f7874394c11f221cd1` |
| RFIDDaja | `c5809058549bd4810b7caed88ac8901a0df023f1` |

Lokalna kopija izvora, Git patch-eva i privatnih podešavanja je u
`C:\Users\09081\Documents\Codex\2026-10-31\a\work\security-edge-backup`.
Direktorijum ima ograničena Windows prava. Sadrži tajne: ne objavljivati i ne
kopirati njegov sadržaj u repozitorijum. `manifest.json` opisuje kopije.
`pages-before.json` čuva prethodnu Pages konfiguraciju; nov edge secret čuva se
odvojeno. Zatečene korisničke izmene `.env.example` i `.idea` nisu uključene u commit.

## Arhitektura

- Web koristi `/api/v1` i `/socket.io` na istom hostu `dajashop.rs` preko Pages Worker-a.
- Android, desktop i RFID PWA koriste `https://api.dajashop.rs/api/v1` preko
  zasebnog Worker-a `daja-api-gateway`. Poznate stare Render adrese u novim
  klijentima migriraju se na taj host; proizvoljne korisničke server adrese ostaju podržane.
- Worker dodaje tajnu samo u serverskom pozivu ka fiksnom Render originu i
  zamenjuje sve dolazne identitetske gateway hintove. Oba gateway izvora moraju
  ostati usklađena: platform `infra/edge-gateway/worker.mjs` i web `src/edge/apiProxy.js`.
- Backend proverava dokaz pre obrade poslovnog HTTP zahteva i na svim Engine.IO
  transport zahtevima. Posle potvrđenog prebacivanja uključuje se `enforce`.
- Izuzeci su samo ograničeni health endpointi. Proveren Google callback je
  `https://dajashop.rs/api/v1/customer-auth/oauth/google/callback` i prolazi kroz
  Pages. Signed OAuth state i browser nonce ostaju obavezni.
- Health ne deli potrošivu HTTP kvotu sa javnim korisnicima: oni ne smeju
  iscrpeti kvotu i izazvati pad Render probe. Liveness ne radi I/O, a readiness
  grupiše/cache-ira provere na 2 s i ima vremensku granicu odgovora.
- Cloudflare ograničava saobraćaj pre aplikacije, ali serverski dokaz nije mrežna
  izolacija Rendera. Javni origin i dalje prima mrežni saobraćaj i odbija poslovne zahteve.

## Sesije

Browser JWT-i putuju isključivo u `Secure`, `HttpOnly`, host-only `__Host-`
kolačićima sa `SameSite=Lax`, bez tokena u JSON odgovorima ili OAuth fragmentu.
Postojeće sesije i revokacija ostaju u PostgreSQL-u; ne uvodi se nova baza niti
poziv dodatnom servisu za svaki zahtev. CSRF token je zaseban neautentikacioni
kolačić i šalje se zaglavljem; promene zahtevaju i tačan Origin.

Staff cookie je dodatno vezan za customer identitet i session family, tako da
kasni odgovor stare admin prijave ne može postati pravo drugog kupca.
Promene/obnova web sesija koordiniraju se između tabova. Native klijenti zadržavaju
postojeći bearer-token ugovor. Stari frontend sa tokenima sačuvan je u
`apiClientLegacy.js` samo radi eksplicitnog rollback-a.

Migracija `090` jednom opoziva postojeće customer sesije nastale pre ove promene.
Korisnici se ponovo prijavljuju. RFID device sesije se ne opozivaju. Opozvane
web sesije se namerno ne oživljavaju ni pri rollback-u; prijava ponovo radi.

## Podešavanja i izvor istine

Render promenljive podešavaju se operativno kroz service environment i čuvaju
se pri Blueprint sync-u zato što ih `render.yaml` ne definiše:

- `EDGE_SHARED_SECRET`: isti tajni nasumični ključ na API-ju i oba Worker-a.
- `EDGE_ENFORCEMENT`: `off`, `observe` ili `enforce`; početni rollout je `observe`.
- `BROWSER_SESSIONS_ENABLED`: `true` kada je novi backend spreman.

Pages secret `EDGE_SHARED_SECRET` nikada ne sme imati `VITE_` prefiks.
Web build koristi cookie režim osim ako je `VITE_DAJA_BROWSER_SESSIONS=false`.
`API_PUBLIC_BASE_URL` i Google redirect URI se ne menjaju naslepo.

## Redosled prebacivanja

1. Sačuvati kod/podešavanja i izmeriti staru produkciju.
2. Objaviti gateway i proveriti native API; backend ostaje u `observe` režimu.
3. Objaviti backend i proveriti browser capability/CSRF/cookie ugovor.
4. Objaviti web i migrirane klijente, proveriti javne stranice i WebSocket.
5. Tek tada postaviti `EDGE_ENFORCEMENT=enforce` i potvrditi da direktni poslovni
   endpoint odbija zahtev, dok oba gateway puta rade.
6. Ponoviti istu seriju merenja i sačuvati poređenje. Bez čekanja na deploy dashboard;
   validira se ponašanje stvarnih endpointa potrebnih za ovaj zadatak.

## Povratak

1. Prvo postaviti Render `EDGE_ENFORCEMENT=off` uz aktiviranje te konfiguracije.
   `BROWSER_SESSIONS_ENABLED=true` ostaje dok se novi web koristi. Ne vraćati
   klijente pre otvaranja starog puta.
2. Vratiti kod sa navedenih Git oznaka novim revert/restore commit-om, bez
   `reset --hard`, forsiranog push-a ili brisanja korisničkih lokalnih izmena.
   Alternativa za web je build sa `VITE_DAJA_BROWSER_SESSIONS=false`.
3. Vratiti Pages javne API/WS promenljive iz sačuvane konfiguracije ako su menjane.
   Uklanjanje novog Pages secret-a nije neophodno za funkcionalan povratak.
   Tek posle vraćanja starog web-a opciono postaviti `BROWSER_SESSIONS_ENABLED=false`.
4. RFID vratiti na prethodni izvor/konfiguraciju; originalni `.env` je u privatnoj kopiji.
5. Tek kad stari put radi, opcionalno ukloniti novi custom domain i Worker. Ne
   brisati postojeći CDN Worker, R2 bucket, podatke ili sesijske tabele.
6. Ponoviti javne provere i merenje. Očekivana je ponovna prijava web korisnika.

## Merenja i granice

Pre/posle: isti lokalni Chrome, desktop 1440×1000 i mobilni 390×844, tri sveža
browser konteksta po početnoj strani, katalogu i istom proizvodu. Beleže se
TTFB, FCP, LCP, CLS, load, resursi i JS greške; pet uzoraka po javnom API endpointu.
Nema veštačkog mrežnog ograničenja. Ovo su laboratorijska merenja sa jednog
računara, ne podaci stvarnih posetilaca, INP, Lighthouse ocena ili DDoS test.

Zatečena React hidrataciona greška #418 postoji pre promene i evidentirana je
odvojeno. Šire test-suite nisu pokretane; ciljane provere ovog prebacivanja,
kompilacije i pre/posle merenja dokumentuju se u izlaznom izveštaju.
