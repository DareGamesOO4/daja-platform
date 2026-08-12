# Authentication

DAJA Platform staff authentication is token-based.

Routes:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

`/auth/login` accepts the RFIDDaja-compatible body:

```json
{
  "organizationId": "uuid",
  "email": "staff@example.com",
  "password": "secret",
  "deviceId": "uuid"
}
```

Access tokens are short-lived Bearer JWTs. Refresh tokens are stored only as hashes, rotate on every refresh, and revoke the session family on reuse detection. Device identity is bound into both token types via the `dev` claim.

`RequestContext` is derived from the verified access token by default. `x-organization-id`, `x-user-id`, `x-roles`, and `x-permissions` are accepted only when `TRUSTED_IDENTITY_HEADERS=true`; this is for a documented trusted reverse-proxy/service-to-service boundary and is disabled by default.

Required production secrets:

- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`

Both must be unique high-entropy values with at least 32 characters.
