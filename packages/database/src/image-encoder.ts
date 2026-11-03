import {
  prepareImageVariants,
  prepareProductVariants,
  prepareAvifMain,
  prepareRemainingVariants,
  type ImageOutputOptions
} from './image-encoder-core.js';

// No database, Redis or R2 clients/secrets enter this process.
process.on('disconnect', () => process.exit(0));
process.once(
  'message',
  (message: {
    source: Buffer;
    options?: ImageOutputOptions;
    product: boolean | 'avif-main' | 'remaining';
  }) => {
    void (async () => {
      try {
        const result =
          message.product === 'avif-main'
            ? await prepareAvifMain(message.source)
            : message.product === 'remaining'
              ? await prepareRemainingVariants(message.source)
              : message.product
                ? await prepareProductVariants(message.source)
                : await prepareImageVariants(message.source, message.options);
        process.send?.({ ok: true, result }, () => process.disconnect());
      } catch {
        process.send?.({ ok: false }, () => process.disconnect());
      }
    })();
  }
);
