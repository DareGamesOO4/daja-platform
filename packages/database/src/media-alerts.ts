import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '@daja/security';

type Client = Pick<pg.Pool | pg.PoolClient, 'query'>;
const messages: Record<string, string> = {
  IMAGE_UPLOAD_TRANSFER_FAILED: 'Prenos slike nije uspeo. Dodajte izvorni fajl ponovo.',
  IMAGE_PROCESSING_TIMEOUT: 'Obrada slike je trajala predugo. Pokušajte ponovo.',
  VALIDATION_FAILED:
    'Slika je oštećena, nepodržana ili prelazi dozvoljene dimenzije. Dodajte ispravan fajl.',
  IMAGE_SOURCE_CHANGED: 'Sačuvani izvor slike se promenio. Potrebno je ponovo dodati izvorni fajl.',
  IMAGE_PROCESSING_INTERRUPTED: 'Obrada je prekinuta pre završetka. Slika čeka ponovni pokušaj.',
  IMAGE_PROCESSING_FAILED: 'Obrada ili čuvanje slike nije uspelo. Pokušajte ponovo.'
};

/** Fixed messages only: never persist exception text, storage URLs or credentials in the inbox. */
export function mediaFailure(error: unknown): { code: string; message: string } | undefined {
  const code = error instanceof AppError ? error.code : 'IMAGE_PROCESSING_FAILED';
  // A full queue, a lost processing lease or the 07:00 cutoff is a deferral, not a bad image.
  if (code === 'IMAGE_PROCESSING_BUSY') return undefined;
  return {
    code: Object.hasOwn(messages, code) ? code : 'IMAGE_PROCESSING_FAILED',
    message: messages[code] ?? messages.IMAGE_PROCESSING_FAILED!
  };
}

export async function recordMediaFailure(
  client: Client,
  organizationId: string,
  mediaId: string,
  phase: 'upload' | 'overnight',
  error: unknown,
  eventKey = randomUUID()
) {
  const failure = mediaFailure(error);
  if (!failure) return;
  await client.query(
    `INSERT INTO media_processing_alerts
     (organization_id,media_asset_id,phase,error_code,message,event_key)
     SELECT organization_id,id,$3,$4,$5,$6 FROM media_assets
     WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND mime_type LIKE 'image/%'
     AND ($3<>'upload' OR status<>'ready')
     AND ($3<>'overnight' OR EXISTS (SELECT 1 FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2))
     ON CONFLICT (organization_id,media_asset_id,phase) DO UPDATE SET
       error_code=excluded.error_code,message=excluded.message,event_key=excluded.event_key,
       occurrences=media_processing_alerts.occurrences+1,last_failure_at=now(),
       resolved_at=NULL,resolution=NULL,retry_requested_at=NULL
     WHERE media_processing_alerts.event_key IS DISTINCT FROM excluded.event_key`,
    [organizationId, mediaId, phase, failure.code, failure.message, eventKey]
  );
}

export async function resolveMediaFailures(
  client: Client,
  organizationId: string,
  mediaId: string,
  phase?: 'upload' | 'overnight',
  resolution: 'ready' | 'removed' = 'ready'
) {
  await client.query(
    `UPDATE media_processing_alerts SET resolved_at=now(),resolution=$4
     WHERE organization_id=$1 AND media_asset_id=$2 AND resolved_at IS NULL
     AND ($3::text IS NULL OR phase=$3)`,
    [organizationId, mediaId, phase ?? null, resolution]
  );
}
