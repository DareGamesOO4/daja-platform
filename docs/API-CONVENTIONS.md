# API Conventions

Versioned API routes live under `/api/v1`.

Success responses use:

```json
{
  "data": {},
  "meta": {},
  "requestId": "..."
}
```

Error responses use:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Human-readable message",
    "details": {},
    "requestId": "..."
  }
}
```

Production responses must not expose stack traces, SQL, secrets, or credentials.

Authenticated staff requests resolve a request context containing request, correlation, organization, user, roles, permissions, and optional location/device identifiers. Organization scope from JSON bodies is not trusted.
