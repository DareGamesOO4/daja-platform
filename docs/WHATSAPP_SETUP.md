# DAJA WhatsApp: priprema za povezivanje

Status 03.11.2026: korisnik je zatrazio pripremu WhatsApp kodova i naveo da nema
Meta Business nalog. Korisnik se prijavio na Facebook. Pokusaj kreiranja portfolija DajaShop sa
poslovnim emailom dajashopnis@gmail.com odbijen je porukom: Facebook nalog je
previse nov; pokusati ponovo za sat vremena. Poslovni portfolio nije kreiran.
Firebase Phone integracija ostaje zaseban SMS kanal; WhatsApp nije ukljucen.

## Podaci i predlog za pregled posle prijave

- Predlozen poslovni naziv: DAJA / DajaShop (konacni naziv mora odgovarati stvarnim
  poslovnim podacima korisnika, ne pretpostavljati pravni naziv).
- Sajt: https://dajashop.rs
- Namena: kod za potvrdu broja i prijavu postojecih DAJA kupaca.
- Pocetno trziste: Srbija (+381).
- Predlog naziva authentication template-a: daja_phone_verification.
- Predlog jezika: srpski; vazi 10 minuta; radnja kopiranja koda ako je dostupna.
- Poslovni broj: korisnik je odredio broj sa zavrsetkom 2425; pre povezivanja
  proveriti da li vec koristi WhatsApp ili WhatsApp Business. Postojeci broj kupca
  iz AWS sandboxa ne tretirati kao poslovnog WhatsApp posiljaoca.

## Sledeci koraci

1. Korisnik se prijavljuje u https://business.facebook.com/wa/manage/home/.
2. Pregledati postojeci poslovni portfolio, ili pripremiti novi sa njegovim stvarnim
   poslovnim podacima. Ne prihvatati pravne uslove bez izricite potvrde.
3. Utvrditi koji poslovni broj ce biti povezan i koje Meta opcije taj broj podrzava.
   Ne brisati/migrirati privatni WhatsApp broj bez zasebne autorizacije.
4. Pregledati uslove, naplatu, verifikaciju i dostupnost authentication sablona.
   Trenutni Meta cenovnik/pravila nisu potvrdjeni: javni developer docs vratili su
   429 tokom pregleda. Proveriti iz same prijavljene konzole pre primene.
5. Tek sa stvarnim WABA/phone-number identifikatorima i odobrenim sablonom dodati
   slanje u backend. Dugotrajni token ide u Render secret, nikad u web/Git/chat.
6. Pripremiti verifikovan webhook za status isporuke; odgovor API-ja da je poruka
   prihvacena ne oznacavati kao fizicku isporuku korisniku.

## Granice pripreme

Nije kreiran Meta nalog, izabran poslovni broj, uvedena naplata, izdat pristupni
Meta token, poslat kod, niti uveden aktivan WhatsApp tok u aplikaciju. To zavisi
od prijavljenog Meta naloga i poslovnih podataka koje korisnik treba da odredi.
