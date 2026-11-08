import { z } from 'zod';

const outputOptions = (size: number, effort: number) => z.object({
  quality: z.number().int().min(1).max(100),
  effort: z.number().int().min(0).max(effort),
  size: z.number().int().min(1).max(size),
  lossless: z.boolean()
});
const avif = (size: number) => outputOptions(size, 9).extend({ chromaSubsampling: z.enum(['4:4:4', '4:2:0']) });
const webp = (size: number) => outputOptions(size, 6).extend({ smartSubsample: z.boolean() });
export const mediaWorkerProfileSchema = z.object({
  paused: z.boolean(),
  avif: avif(2048), webp: webp(2048), avifThumb: avif(512), webpThumb: webp(512)
});
export type MediaWorkerProfile = z.infer<typeof mediaWorkerProfileSchema>;
export const defaultMediaWorkerProfile: MediaWorkerProfile = {
  paused: false,
  avif: { quality: 95, effort: 4, size: 2048, lossless: false, chromaSubsampling: '4:4:4' },
  webp: { quality: 75, effort: 4, size: 2048, lossless: false, smartSubsample: true },
  avifThumb: { quality: 65, effort: 4, size: 512, lossless: false, chromaSubsampling: '4:4:4' },
  webpThumb: { quality: 75, effort: 4, size: 512, lossless: false, smartSubsample: true }
};
