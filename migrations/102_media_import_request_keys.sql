BEGIN;
CREATE UNIQUE INDEX media_assets_client_import_request
  ON media_assets(organization_id, (metadata->>'clientRequestId'))
  WHERE metadata->>'clientRequestId' IS NOT NULL;
COMMIT;
