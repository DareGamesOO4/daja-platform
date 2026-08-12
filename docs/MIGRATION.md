# Migration

Production cutover must be rehearsed in staging first:

```text
Firestore/XLSX snapshot
  -> new PostgreSQL staging database
  -> import/migration
  -> reconciliation
  -> API verification
  -> performance verification
```

Required report:

- source and target counts;
- duplicate IDs/SKUs;
- invalid rows;
- media URL status;
- sampled SKU/price/slug comparison;
- sampled EPC mapping when available.

Firestore must stop being product master after cutover. Permanent dual-master synchronization is forbidden.
