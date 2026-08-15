# Render deployment

Deploy this repository with `render.yaml`. It creates the public API and the media worker.

Before the first deploy, set the secret values requested by the blueprint. `PUBLIC_ORGANIZATION_ID` is mandatory: public catalog and storefront routes return an authorization/validation error without it. Use the existing organization UUID from the production DAJA Platform database.

The frontend uses `https://daja-platform-api.onrender.com/api/v1`. The API service must retain this public URL in `API_PUBLIC_BASE_URL` and list every deployed DajaShop origin in `CORS_ALLOWED_ORIGINS`.

After deploy, verify:

```sh
curl https://daja-platform-api.onrender.com/health/live
curl https://daja-platform-api.onrender.com/health/ready
curl https://daja-platform-api.onrender.com/api/v1/public/catalog/products
```
