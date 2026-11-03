import {
  prepareImageVariants,
  prepareProductVariants,
  type ImageOutputOptions
} from './image-encoder-core.js';

// No database, Redis or R2 clients/secrets enter this process.
process.on('disconnect', () => process.exit(0));
process.once(
  'message',
  (message: { source: Buffer; options?: ImageOutputOptions; product: boolean }) => {
    void (async () => {
      try {
        const result = message.product
          ? await prepareProductVariants(message.source)
          : await prepareImageVariants(message.source, message.options);
        process.send?.({ ok: true, result }, () => process.disconnect());
      } catch {
        process.send?.({ ok: false }, () => process.disconnect());
      }
    })();
  }
);
