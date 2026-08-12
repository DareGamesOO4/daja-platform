# OpenAPI

The OpenAPI artifact is generated from the actual Nest application:

```bash
npm run openapi:generate
```

Output:

```text
packages/contracts/generated/openapi.json
```

CI validates that the generated JSON parses with:

```bash
npm run openapi:check
```

The artifact is the v1 HTTP contract seed for later `dajashopweb` and `RFIDDaja` client generation. Sync `schemaVersion` is versioned independently from HTTP API versioning.
