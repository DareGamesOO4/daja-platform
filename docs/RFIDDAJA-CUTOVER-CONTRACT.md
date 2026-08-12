# RFIDDaja Cutover Contract

Do not modify `RFIDDaja` as part of this plan.

DAJA Platform now owns central catalog, RFID tag identity, inventory ledger/balances, revisions, sync events and conflicts.

RFIDDaja remains local/offline-first. Internet is not added to the critical path of normal local RFID/inventory UI operations.

## Sync

- Push: `POST /api/v1/sync/push`
- Pull: `GET /api/v1/sync/pull`
- Bootstrap: `GET /api/v1/sync/bootstrap`

RFIDDaja keeps local SQLite/outbox/inbox responsibilities. DAJA Platform provides durable server revision ordering and conflict records.

## Device Mapping

Devices register through `POST /api/v1/devices`. Offline authorization metadata is server-side contract data; encrypted local offline sessions remain a RFIDDaja responsibility.

## WebSocket

Realtime events are tenant/location-scoped hints. Reconnect must resume by sync pull, not by trusting WebSocket as durable state.

RFID hardware adapters and vendor SDKs remain in RFIDDaja.
