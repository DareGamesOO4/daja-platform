# SMS status — 03.11.2026.

Google/Firebase phone authentication is now prepared in the new `dajashop-sms`
project. Cloud provider setup exists, but DAJA activation is off pending billing
approval. See [FIREBASE_PHONE.md](FIREBASE_PHONE.md). No real delivery is confirmed.

## Previous step: AWS SMS retired

Korisnik je povukao AWS SMS integraciju i nije odobrio zamenskog provajdera.

- SNS SDK, SMS konfiguracija i implementacije slanja uklonjeni su iz API-ja i workera.
- Stare phone/start i phone/verify rute vracaju jasnu gresku da SMS nije dostupan.
  Prethodno izdati kodovi vise se ne prihvataju.
- Nove SMS pretplate za proizvode se odbijaju. Postojece SMS pretplate se cuvaju;
  email-only claim upiti ih ne oznacavaju kao obradjene ili isporucene.
- Web ne nudi SMS prijavu, povezivanje broja ili SMS kanal za obavestenja.
- Render API: SNS_SMS_ACCESS_KEY_ID i SNS_SMS_SECRET_ACCESS_KEY postavljeni su na
  prazne vrednosti. Ostale promenljive su sacuvane.
- IAM dajashop-ses-sender / DajaShopSnsPublishOnly sada ima samo eksplicitni Deny
  za sns:Publish i sms-voice:SendTextMessage. Konzola je potvrdila cuvanje politike.
  Nisu obrisani deljeni IAM kljucevi niti SES/SQS email dozvole.
- AWS SMS nalog ostaje u sandboxu. Sender ID, verifikovani broj i istorijski logovi
  nisu obrisani. SNS topic za SES email feedback ostaje jer nije SMS slanje.
- SES email ostaje zasebno: zahtev za produkciju prethodno poslat; zadnje poznato
  stanje je Under review, sto nije odobrenje niti potvrda isporuke emaila.

Nisu pokretani testovi, slanje SMS-a, instalacija aplikacije ili provera deploy-a.
Zamena zahteva zaseban izbor i autorizaciju korisnika.
