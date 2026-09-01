/**
 * Legal copy is intentionally source-controlled.  The current document is a
 * deployment-safe draft scaffold only; it must be replaced with the reviewed
 * company data before a production publication is marked as ready.
 */
export const LEGAL_POLICY_VERSION = '2026-09-01-analytics-draft';

export type LegalDocumentKind = 'privacy' | 'cookies' | 'terms';

export interface LegalDocument {
  kind: LegalDocumentKind;
  title: string;
  updatedAt: string;
  ready: boolean;
  sections: Array<{ title: string; body: string[] }>;
}

const sharedNotice = [
  'Ovaj tekst je tehnički nacrt i nije konačna pravna politika.',
  'Pre javne objave moraju se uneti puni podaci rukovaoca, kontakt za privatnost i pravno odobren sadržaj.'
];

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    kind: 'privacy',
    title: 'Politika privatnosti',
    updatedAt: '2026-09-01',
    ready: false,
    sections: [
      { title: 'Status dokumenta', body: sharedNotice },
      {
        title: 'Šta će sadržati konačna verzija',
        body: [
          'Identitet i kontakt rukovaoca, svrhe obrade, pravni osnovi, primaoci, rokovi čuvanja i prava korisnika.',
          'Konačna verzija će navesti kontakt za zahtev za pristup, ispravku, brisanje ili prigovor.'
        ]
      }
    ]
  },
  {
    kind: 'cookies',
    title: 'Politika kolačića i lokalne memorije',
    updatedAt: '2026-09-01',
    ready: false,
    sections: [
      { title: 'Status dokumenta', body: sharedNotice },
      {
        title: 'Kategorije koje aplikacija podržava',
        body: [
          'Neophodno: dokaz izbora, prijava i funkcije koje korisnik izričito koristi, poput korpe.',
          'Podešavanja: tema, zapamćena prijava, pozicija skrola i prikaz newsletter ponude.',
          'Spoljne usluge: Google Maps i Google Places, samo nakon posebne ili potpune dozvole.',
          'Analitika: Cloudflare Web Analytics, samo nakon izričitog pristanka korisnika.'
        ]
      }
    ]
  },
  {
    kind: 'terms',
    title: 'Uslovi korišćenja',
    updatedAt: '2026-09-01',
    ready: false,
    sections: [
      { title: 'Status dokumenta', body: sharedNotice },
      {
        title: 'Obaveštenja o proizvodima',
        body: [
          'Korisnik može samostalno uključiti ili isključiti obaveštenje o promeni cene ili ponovnoj dostupnosti proizvoda.',
          'Email obaveštenja sadrže direktnu odjavu za konkretan proizvod i tip obaveštenja.'
        ]
      }
    ]
  }
];

export function legalDocument(kind: LegalDocumentKind): LegalDocument {
  const document = LEGAL_DOCUMENTS.find((item) => item.kind === kind);
  if (!document) throw new Error(`Unknown legal document: ${kind}`);
  return document;
}
