# Slike proizvoda

Običan upload i uvoz preko linka koriste `prepareImageVariants` iz
`packages/database/src/media-images.ts`. Svaka nova slika, uključujući galeriju,
dobija tačno dve verzije:

- velika: do 2048 × 2048 px, uz očuvanje proporcija;
- mala: do 512 px širine, uz očuvanje proporcija.

Manje slike se ne uvećavaju. Podrazumevani format je WebP, kvalitet 84 za veliku
i 80 za malu verziju. Postojeći AVIF import paketi mogu izričito izabrati AVIF.

`POST /media/uploads` vraća potpisanu adresu za privremeni original, a `publicUrl`
i `thumbnailUrl` najavljuju konačne verzije. Klijent završava PUT, zatim poziva
`POST /media/uploads/:mediaId/complete`. Završetak validira originalni sadržaj,
veličinu i checksum i odmah priprema obe verzije. Odgovor `ready` sadrži konačne
`publicUrl`, `mainImageUrl` i `thumbnailUrl`. Klijent treba da koristi te adrese.
Novi upload slike ne zavisi od dostupnosti pozadinskog worker-a.

Privremeni original se briše tek posle uspešnog DB commit-a. Ako obrada ili
transakcija ne uspe, uklanjaju se novonastali fajlovi. Neuspeh naknadnog brisanja
originala se beleži u logu i ne poništava uspešan upload. Nova adresa velike
verzije sprečava da CDN posluži keširani neobrađeni original.

Worker za ranije zakazane upload poslove koristi istu obradu, bez posebnog
pravila za glavnu sliku i bez dodatnih verzija 256/768 px. PDF ostaje dokument.
Ova promena ne prepravlja masovno već obrađene slike u katalogu. Takva migracija
zahteva zaseban plan, popis postojećih adresa i rezervnu kopiju.
