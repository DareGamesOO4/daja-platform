# Javni identiteti grupa varijanti

Od 3.11.2026. `loadPublicGroupMembers` vraća prvih 40 heksadecimalnih znakova SHA-256 vrednosti `organizationId:groupKey` umesto svih 64. To je deterministički identifikator od 160 bita koji staje u Googleovo ograničenje od 50 znakova. Interni UUID, ručne grupe i pravila automatskog grupisanja nisu promenjeni.

Web koristi istu vrednost za `inProductGroupWithID` i `ProductGroup.productGroupID`. Tokom prelaska skraćuje i ranije keširane odgovore na istih 40 znakova.
