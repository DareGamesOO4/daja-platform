import { prepareImageVariants, type ImageOutputOptions } from './image-encoder-core.js';

// No database, Redis or R2 clients/secrets enter this process.
process.on('disconnect', () => process.exit(0));
process.once('message', (message: { source: Buffer; options?: ImageOutputOptions; product: boolean }) => {
  void (async () => {
    try {
      const result = message.product
        ? { webp: await prepareImageVariants(message.source, { format: 'webp', quality: 75 }),
            avif: await prepareImageVariants(message.source, { format: 'avif', quality: 65 }) }
        : await prepareImageVariants(message.source, message.options);
      process.send?.({ ok: true, result }, () => process.disconnect());
    } catch {
      process.send?.({ ok: false }, () => process.disconnect());
    }
  })();
});
