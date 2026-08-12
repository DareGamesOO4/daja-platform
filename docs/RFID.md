# RFID

RFID is a central platform domain. Public lookup is intentionally minimal:

```text
GET /api/v1/public/rfid/resolve/:epc
```

The resolver normalizes EPC input, performs exact lookup only, checks published product/variant state, and returns only product navigation data. It does not reveal TID, internal location, audit history or other EPCs.

RFID staff APIs support create/read/assign/unassign/status/events. RFIDDaja hardware SDKs and raw reader frame handling remain outside DAJA Platform.

Realtime RFID events are hints only. Durable truth remains PostgreSQL plus sync pull.
