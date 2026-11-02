import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { resolveRequestContext } from './runtime/request-context.js';
import { CatalogBulkService, bulkRequestSchema } from './catalog-bulk.service.js';

@Controller('admin/catalog/jobs')
export class CatalogBulkController {
  constructor(@Inject(CatalogBulkService) private readonly jobs: CatalogBulkService) {}
  @Post()
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  create(@Req() request: Request, @Body() body: unknown) {
    return this.jobs.create(
      resolveRequestContext(request),
      parseWithSchema(bulkRequestSchema, body)
    );
  }
  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string, @Query('after') after: unknown) {
    return this.jobs.get(
      resolveRequestContext(request),
      parseWithSchema(uuidSchema, id),
      parseWithSchema(z.coerce.number().int().min(-1).max(999).default(-1), after)
    );
  }
  @Post(':id/cancel')
  cancel(@Req() request: Request, @Param('id') id: string) {
    return this.jobs.cancel(resolveRequestContext(request), parseWithSchema(uuidSchema, id));
  }
}
