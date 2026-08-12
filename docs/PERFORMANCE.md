# Performance

Implemented performance checks:

- `npm run plan2:perf` verifies EPC, slug and SKU exact lookups use indexes on realistic fixture sizes.
- `npm run plan3:perf` verifies sync pull and related Plan 3 query paths.
- Public catalog listing uses one bounded SQL query with joins/lateral subqueries rather than N+1 per product.

Initial targets:

- cached exact reads: p50 below 50 ms server-side in staging-like conditions;
- common DB reads: p95 below 150-200 ms server-side;
- EPC DB lookup: exact, index-backed, low latency.

These are engineering targets, not guaranteed production SLAs. Real staging results must be captured after final infrastructure is selected.
