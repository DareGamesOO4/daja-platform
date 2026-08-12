# Sync

Plan 3 adds durable RFIDDaja-compatible sync primitives:

- `organization_revisions`
- `server_sync_events`
- `sync_conflicts`
- `devices`
- `device_sessions`
- `device_authorizations`

Each organization has a monotonic revision. `server_sync_events` is append-only and ordered by `(organization_id, revision)`.

## Push

`POST /api/v1/sync/push` accepts an ordered batch of 1-100 events. Each event returns one of:

- `applied`
- `duplicate`
- `conflict`
- `rejected`

Current transaction semantics are `ordered-per-event`: events are evaluated in order, and one conflict does not make the rest of the response ambiguous.

## Pull

`GET /api/v1/sync/pull?afterRevision=...&limit=...` returns ordered revisions and never downloads the whole database.

## Bootstrap

`GET /api/v1/sync/bootstrap` returns a snapshot page and a `watermarkRevision`. A device persists the snapshot and then pulls deltas after that watermark.

## Conflicts

Conflicts are durable rows with client payload, server payload, base/server versions, status and resolution metadata. Resolution is audited through the API controller.

Raw RFID reader frames are not normal sync events.
