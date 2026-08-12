# API

DAJA Platform exposes HTTP APIs under `/api/v1`. Responses use the existing envelope:

```json
{ "data": {}, "meta": {}, "requestId": "uuid" }
```

Production clients must not connect directly to PostgreSQL.

## Public

- `GET /api/v1/public/catalog/products`
- `GET /api/v1/public/catalog/products/:slug`
- `GET /api/v1/public/catalog/brands`
- `GET /api/v1/public/catalog/categories`
- `GET /api/v1/public/rfid/resolve/:epc`

Public catalog/RFID routes use `PUBLIC_ORGANIZATION_ID` when configured. Otherwise they require the current development header identity.

## Staff/Device

Current implementation uses trusted request headers as the internal auth contract:

- `x-organization-id`
- `x-user-id`
- `x-device-id` when applicable
- `x-location-id` when applicable
- `x-permissions`

This is not a final internet-facing auth scheme. A production edge/JWT verification layer must populate these claims before public exposure.

## Sync

- `POST /api/v1/sync/push`
- `GET /api/v1/sync/pull?afterRevision=0&limit=100`
- `GET /api/v1/sync/bootstrap?limit=100&cursor=...`
- `GET /api/v1/sync/conflicts`
- `PATCH /api/v1/sync/conflicts/:id`

## Devices

- `POST /api/v1/devices`

Registers or refreshes a central device identity. Offline credential storage remains a client responsibility.
