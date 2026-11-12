import { z } from 'zod';
import type { DbClient } from '@daja/database';
import { ResourceConflictError, ValidationFailedError } from '@daja/security';

const isLocalPath = (value: string) => /^\/(?!\/)[^\\\x00-\x20]*$/.test(value);

const frameSchema = z.object({
  width: z.coerce.number().int().min(200).max(5000),
  height: z.coerce.number().int().min(200).max(5000)
}).strict().refine(({ width, height }) => width / height >= 0.25 && width / height <= 5,
  'Frame ratio must be between 1:4 and 5:1');
const imagePosition = z.enum(['center', 'top', 'bottom', 'left', 'right']);

const homeHeroSlideSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(100),
  active: z.boolean(),
  desktopSrc: z.string().trim().min(1).max(2048),
  mobileSrc: z.string().trim().min(1).max(2048),
  desktopMediaId: z.string().uuid().nullable().optional(),
  mobileMediaId: z.string().uuid().nullable().optional(),
  alt: z.string().trim().max(200).default(''),
  altEn: z.string().trim().max(200).optional(),
  to: z.string().trim().max(500).refine(value => !value || isLocalPath(value), 'Link must be a local path').default(''),
  desktopFrame: frameSchema,
  mobileFrame: frameSchema,
  desktopPosition: imagePosition.optional(),
  mobilePosition: imagePosition.optional(),
  fit: z.enum(['cover', 'contain']).default('contain'),
  zoom: z.coerce.number().int().min(100).max(108).default(102),
  animation: z.boolean().default(true)
}).strict();

export const homeHeroSlidesSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0).max(2_147_483_646),
  intervalMs: z.number().int().refine(value => value === 0 || (value >= 3000 && value <= 30000)),
  slides: z.array(homeHeroSlideSchema).min(1).max(20)
    .refine(slides => slides.some(slide => slide.active), 'At least one slide must be active')
    .refine(slides => new Set(slides.map(slide => slide.id)).size === slides.length, 'Slide IDs must be unique')
}).strict();

type HomeHeroSlide = z.infer<typeof homeHeroSlideSchema>;

const defaultHomeHeroSlides: HomeHeroSlide[] = [
  {
    id: '11111111-1111-4111-8111-111111111111', title: 'DajaShop', active: true,
    desktopSrc: '/images/home/hero-dajashop-desktop.webp?v=2', mobileSrc: '/images/home/hero-dajashop-mobile.webp',
    alt: 'Daniel Klein satovi', to: '/catalog?brand=DANIEL%20KLEIN',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'contain', zoom: 102, animation: true
  },
  {
    id: '22222222-2222-4222-8222-222222222222', title: 'Orient Stretto', active: true,
    desktopSrc: '/images/home/hero-orient-stretto-desktop.webp', mobileSrc: '/images/home/hero-orient-stretto-mobile.webp',
    alt: 'Orient Stretto Date kolekcija', to: '/brend/orient',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'contain', zoom: 102, animation: true
  },
  {
    id: '33333333-3333-4333-8333-333333333333', title: 'G-Shock', active: true,
    desktopSrc: '/images/home/hero-g-shock-gold-1280.webp', mobileSrc: '/images/home/hero-g-shock-gold-1280.webp',
    alt: 'Casio G-Shock kolekcija', to: '/catalog?brand=CASIO&category=G-SHOCK',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'cover', zoom: 102, animation: true
  },
  {
    id: '44444444-4444-4444-8444-444444444444', title: 'Daniel Klein izbor', active: true,
    desktopSrc: '/images/home/hero-daniel-klein-gold-960.webp', mobileSrc: '/images/home/hero-daniel-klein-gold-960.webp',
    alt: 'Daniel Klein izbor', to: '/catalog?brand=DANIEL%20KLEIN',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'cover', zoom: 102, animation: true
  },
  {
    id: '55555555-5555-4555-8555-555555555555', title: 'Casio', active: true,
    desktopSrc: '/images/home/hero-casio-1920.webp', mobileSrc: '/images/home/hero-casio-1920.webp',
    alt: 'Casio kolekcija', to: '/catalog?brand=CASIO',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'cover', zoom: 102, animation: true
  },
  {
    id: '66666666-6666-4666-8666-666666666666', title: 'Daniel Klein', active: true,
    desktopSrc: '/images/home/hero-daniel-klein-1519.webp', mobileSrc: '/images/home/hero-daniel-klein-1519.webp',
    alt: 'Daniel Klein kolekcija', to: '/catalog?brand=DANIEL%20KLEIN',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'cover', zoom: 102, animation: true
  },
  {
    id: '77777777-7777-4777-8777-777777777777', title: 'G-Shock GA-2100', active: true,
    desktopSrc: '/images/home/g-shock-1600.webp', mobileSrc: '/images/home/g-shock-1600.webp',
    alt: 'G-Shock GA-2100', to: '/catalog?brand=CASIO&category=G-SHOCK',
    desktopFrame: { width: 1534, height: 678 }, mobileFrame: { width: 750, height: 1000 }, fit: 'cover', zoom: 102, animation: true
  }
];

const builtInSources = new Set(defaultHomeHeroSlides.flatMap(slide => [slide.desktopSrc, slide.mobileSrc]));
type SettingsRow = { version: number; intervalMs: number; slides: HomeHeroSlide[] };

function homeHeroMediaIds(slides: HomeHeroSlide[]) {
  return [...new Set(slides.flatMap(slide => [slide.desktopMediaId, slide.mobileMediaId]
    .filter((id): id is string => Boolean(id))))];
}

export async function readHomeHeroSettings(client: DbClient, organizationId: string): Promise<SettingsRow> {
  const result = await client.query<SettingsRow>(
    'SELECT version, interval_ms AS "intervalMs", slides FROM storefront_home_hero_settings WHERE organization_id = $1',
    [organizationId]
  );
  return result.rows[0] ?? { version: 0, intervalMs: 5600, slides: defaultHomeHeroSlides };
}

export function publicHomeHeroSettings(settings: SettingsRow) {
  const { version, intervalMs, slides } = settings;
  return {
    version, intervalMs,
    slides: slides.filter(slide => slide.active).map(({
      id, desktopSrc, mobileSrc, alt, altEn, to, desktopFrame, mobileFrame, desktopPosition, mobilePosition, fit, zoom, animation
    }) => ({
      id, desktopSrc, mobileSrc, alt, altEn, to, desktopFrame, mobileFrame, desktopPosition, mobilePosition, fit, zoom, animation
    }))
  };
}

export async function writeHomeHeroSettings(
  client: DbClient, organizationId: string, input: z.infer<typeof homeHeroSlidesSchema>
) {
  const previous = await readHomeHeroSettings(client, organizationId);
  const conflict = () => new ResourceConflictError('Početni slajder je u međuvremenu promenjen.');
  if (input.expectedVersion !== previous.version) throw conflict();

  const ids = homeHeroMediaIds(input.slides);
  const assets = ids.length ? (await client.query<{ id: string; public_url: string }>(
    `SELECT id, public_url FROM media_assets WHERE organization_id = $1 AND id = ANY($2::uuid[])
     AND deleted_at IS NULL AND status = 'ready' AND mime_type LIKE 'image/%' AND public_url IS NOT NULL
     ORDER BY id FOR SHARE`,
    [organizationId, ids]
  )).rows : [];
  const urls = new Map(assets.map(asset => [asset.id, asset.public_url]));
  const source = (url: string, id?: string | null) => {
    const resolved = id ? urls.get(id) : builtInSources.has(url) ? url : undefined;
    if (!resolved) throw new ValidationFailedError('Slika banera nije dostupna. Izaberite je ponovo.');
    return resolved;
  };
  const slides = input.slides.map(slide => ({
    ...slide,
    desktopSrc: source(slide.desktopSrc, slide.desktopMediaId),
    mobileSrc: source(slide.mobileSrc, slide.mobileMediaId)
  }));
  const saved = (await client.query<SettingsRow>(
    `INSERT INTO storefront_home_hero_settings (organization_id, version, slides, interval_ms)
     VALUES ($1, 1, $2::jsonb, $4)
     ON CONFLICT (organization_id) DO UPDATE SET
       version = storefront_home_hero_settings.version + 1, slides = EXCLUDED.slides,
       interval_ms = EXCLUDED.interval_ms, updated_at = now()
     WHERE storefront_home_hero_settings.version = $3
     RETURNING version, interval_ms AS "intervalMs", slides`,
    [organizationId, JSON.stringify(slides), input.expectedVersion, input.intervalMs]
  )).rows[0];
  if (!saved) throw conflict();
  const kept = new Set(ids);
  return { saved, removedIds: homeHeroMediaIds(previous.slides).filter(id => !kept.has(id)) };
}
