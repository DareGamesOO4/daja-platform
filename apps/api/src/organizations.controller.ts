import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Database } from '@daja/database';
import { AuditRepository, OrganizationRepository, TransactionManager } from '@daja/database';
import type { Logger } from '@daja/observability';
import { DATABASE, LOGGER } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';

@Controller('organizations')
export class OrganizationsController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  @Get(':id')
  async getOrganization(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    return new OrganizationRepository(this.database.pool).findByIdForContext(ctx, id);
  }

  @Patch(':id/name')
  async updateName(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { expectedVersion: number; name: string; reason?: string }
  ) {
    const ctx = resolveRequestContext(request);
    const tx = new TransactionManager(this.database.pool, this.logger);
    return tx.run(async (client) => {
      const repository = new OrganizationRepository(client);
      const before = await repository.findByIdForContext(ctx, id);
      const after = await repository.updateName(ctx, {
        id,
        expectedVersion: body.expectedVersion,
        name: body.name
      });
      const auditInput = {
        ctx,
        aggregateType: 'organization',
        aggregateId: id,
        operation: 'update_name',
        beforePayload: before,
        afterPayload: after
      };
      await new AuditRepository(client).append(
        body.reason ? { ...auditInput, reason: body.reason } : auditInput
      );
      return after;
    });
  }
}
