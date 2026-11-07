import {
  prepareImageVariants,
  prepareProductVariants,
  prepareAvifMain,
  prepareRemainingVariants,
  inspectImageSource,
  type ImageOutputOptions
} from './image-encoder-core.js';

// No database, Redis or R2 clients/secrets enter this process.
process.on('disconnect', () => process.exit(0));
process.once(
  'message',
  (message: {
    source: Buffer;
    options?: ImageOutputOptions;
    product: boolean | 'avif-main' | 'remaining' | 'inspect';
  }) => {
    void (async () => {
      try {
        const result =
          message.product === 'inspect'
            ? await inspectImageSource(message.source)
            : message.product === 'avif-main'
            ? await prepareAvifMain(message.source)
            : message.product === 'remaining'
              ? await prepareRemainingVariants(message.source)
              : message.product
                ? await prepareProductVariants(message.source)
                : await prepareImageVariants(message.source, message.options);
        // A successful send callback does not acknowledge receipt by the
        // parent. Keep IPC open until the parent receives the result and
        // terminates this child in isolatedEncode.finish(). Otherwise a clean
        // exit can race the buffered image payload and be reported as failure.
        process.send?.({ ok: true, result });
      } catch {
        process.send?.({ ok: false });
      }
    })();
  }
);
