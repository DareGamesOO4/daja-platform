/**
 * Legal copy is intentionally source-controlled. The current document is a
 * deployment-safe draft scaffold only; it must be replaced with reviewed
 * company data before a production publication is marked as ready.
 */
export const LEGAL_POLICY_VERSION = '2026-09-02-cookie-category-groups-draft';

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
    updatedAt: '2026-09-02',
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
    updatedAt: '2026-09-02',
    ready: false,
    sections: [
      { title: 'Status dokumenta', body: sharedNotice },
      {
        title: 'Kategorije koje aplikacija podržava',
        body: [
          'Neophodno: dokaz izbora, prijava i funkcije koje korisnik izričito koristi, poput korpe i liste želja.',
          'Funkcionalni: pamćenje teme, prijave, prikaza newsletter ponude i pozicije u katalogu, Google Maps za prikaz naše lokacije i Google Places za predlog adrese. Kategorija je podrazumevano isključena; korisnik može nastaviti bez mape i ručno uneti adresu. Google pri korišćenju može obraditi tehničke podatke pregledača i adresu koju korisnik unese.',
          'Analitika: Cloudflare Web Analytics, samo nakon izričitog pristanka korisnika.',
          'Marketing: trenutno ne koristimo marketinške kolačiće niti personalizovano oglašavanje.',
          'Neklasifikovani: trenutno nema kolačića koji nisu svrstani u neku od navedenih kategorija.'
        ]
      },
      {
        title: 'Upravljanje izborom',
        body: [
          'Korisnik može prihvatiti samo neophodne kolačiće, dozvoliti funkcionalnu kategoriju ili analitiku, ili kasnije promeniti izbor u podešavanjima privatnosti.',
          'Promena naziva kategorije u „funkcionalni” ne menja činjenicu da su te opcije dobrovoljne i da nisu potrebne za završetak kupovine.'
        ]
      }
    ]
  },
  {
    kind: 'terms',
    title: 'Uslovi korišćenja',
    updatedAt: '2026-09-02',
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
