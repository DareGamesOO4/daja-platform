# Capability Matrix

| Capability         | RFIDDaja                                     | dajashopweb                          | DAJA Platform Batch 1                  |
| ------------------ | -------------------------------------------- | ------------------------------------ | -------------------------------------- |
| Staff login        | Access/refresh JWT, Argon2id, device binding | Not primary                          | Implemented                            |
| Refresh rotation   | Session family + reuse detection             | Not primary                          | Implemented                            |
| Request context    | Token-derived tenant/user/device             | Firebase/client context              | Token-derived by default               |
| Trusted headers    | Not identity source                          | N/A                                  | Disabled by default; opt-in only       |
| RBAC               | Roles/grants/permissions                     | Firebase rules/functions             | Existing roles/permissions used        |
| Offline sync       | Push/pull/bootstrap/conflicts                | N/A                                  | Implemented contract and permissions   |
| Realtime           | Tenant-scoped events                         | N/A                                  | Token-gated WebSocket namespace        |
| Catalog source     | Local sync data                              | Firestore products/categories/brands | PostgreSQL typed catalog               |
| Image storage      | N/A                                          | R2 bucket `dajashop-images`          | R2 config supports existing bucket/CDN |
| Firestore import   | N/A                                          | Source of truth before cutover       | Dry-run framework and mappings         |
| Legacy IDs         | App-local IDs                                | Firestore document IDs               | `legacy_identity_mappings` added       |
| Production cutover | Requires client rollout                      | Requires dry-run/reconcile           | Deferred after Batch 1 stop            |
