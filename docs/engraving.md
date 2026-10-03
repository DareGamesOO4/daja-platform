# Engraving drafts and order snapshots

Apply `076_engraving_drafts.sql` through the normal migration workflow before enabling the storefront feature. It adds private drafts/assets and changes the customer cart key to a line identifier, retaining existing cart contents.

Customer endpoints under `/engraving/drafts` support list, create, open (POST), versioned update (PUT), guest claim and PNG asset upload. Authenticated drafts require the owning customer session. Anonymous drafts use a random capability token, hashed at rest; tokens must stay in request bodies/local cart storage, never URLs. Administrators receive artwork only through their authorized order endpoint.

Images up to 10 MB are decoded and resized in the browser to PNG (up to 1024 pixels and 700,000 encoded characters per asset). They are stored privately in PostgreSQL rather than in the public catalog media bucket. Artwork and thumbnail are separate PNGs. Font licenses accompany the four self-hosted font families in the web repository.

The version check rejects stale saves with HTTP 409. Checkout validates draft ownership/capability, product and variant, publication, referenced assets, nonempty text and the engraving zone. It copies the design, assets, thumbnail and full-size monochrome artwork into the order inside its transaction; future draft edits cannot change that copy. Engraving adds no cost.

The admin SVG export embeds the frozen artwork to preserve exact font and emoji rendering, with physical dimensions in millimeters. It is a preview/layout artifact, not laser-ready vector outlines. JSON includes the editable element geometry and settings. PNG is the exact frozen monochrome artwork.

No tests, builds, runtime or deployment verification were performed for this implementation, per request. Follow-up acceptance checks: circular upper/lower text and emoji, image threshold/invert, guest-to-account transfer, another-device resume/version conflict, distinct cart lines and identical immutable order exports.
