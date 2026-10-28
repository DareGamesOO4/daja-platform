# Uputstva za rad

- Ne pokretati testove; štedeti tokene.
- Kada se završe tražene izmene, uraditi commit i push. Navesti naziv commita i projekat.
- Novu verziju Android aplikacije instalirati ako je uređaj povezan; ako nije, preskočiti.
- Ne proveravati da li je deploy završen.

## Mapa projekata i infrastrukture

Ovaj repozitorijum sadrži zajednički backend za prodavnicu `dajashopweb` i desktop/Android aplikaciju `RFIDDaja`.

Pre rada na infrastrukturi, integracijama, mejlovima, sinhronizaciji, medijima, Renderu ili Cloudflare-u pročitaj [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md). Tu su mapa sva tri projekta, nazivi i ID-jevi resursa, API adrese, veze i putanje do odgovarajućeg koda. Dokument je u repozitorijumu i dostupan je bez Codex memorije ili pristupa drugim lokalnim projektima.

Mapa je snimak od 28.10.2026, a ne dokaz trenutnog stanja. Kada zadatak zavisi od aktivne konfiguracije, pročitaj odgovarajući izvor ili resurs preko dostupnog Render/Cloudflare/AWS konektora. Ne zaključuj da je worker aktivan samo zato što postoji u render.yaml. SES ostaje u sandboxu dok korisnik ne zatraži drugačije. Ne čuvaj tajne u dokumentaciji.
