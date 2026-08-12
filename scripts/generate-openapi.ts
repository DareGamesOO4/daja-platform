import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { format } from 'prettier';

const { AppModule } = (await import('../apps/api/dist/app.module.js')) as {
  AppModule: unknown;
};
const app = await NestFactory.create(AppModule, { logger: false });
try {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DAJA Platform API')
      .setDescription('Versioned DAJA Platform HTTP API contract generated from Nest controllers.')
      .setVersion('1.0')
      .build()
  );
  await mkdir('packages/contracts/generated', { recursive: true });
  await writeFile(
    'packages/contracts/generated/openapi.json',
    await format(JSON.stringify(document), { parser: 'json' })
  );
  console.log('generated packages/contracts/generated/openapi.json');
} finally {
  await app.close();
}
