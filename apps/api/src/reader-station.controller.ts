import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { ReaderStationService } from './reader-station.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

const registerSchema=z.object({name:z.string().trim().min(1).max(120),locationId:uuidSchema.optional()});
const startSchema=z.object({stationId:uuidSchema,clientId:uuidSchema});
const epcSchema=z.object({sessionId:uuidSchema,epc:z.string().trim().min(1).max(256)});
const barcodeSchema=z.object({sessionId:uuidSchema,barcode:z.string().trim().max(256).optional()});
@Controller('rfid/reader-stations')
export class ReaderStationController {
  constructor(@Inject(ReaderStationService) private readonly stations: ReaderStationService) {}
  @Post('register') async register(@Req() req:Request,@Body() body:unknown){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');return this.stations.register(ctx,parseWithSchema(registerSchema,body));}
  @Post(':id/heartbeat') async heartbeat(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');await this.stations.heartbeat(ctx,parseWithSchema(uuidSchema,id));return {ok:true};}
  @Get() async list(@Req() req:Request){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');return this.stations.list(ctx);}
  @Post('sessions') async start(@Req() req:Request,@Body() body:unknown){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');return this.stations.start(ctx,parseWithSchema(startSchema,body));}
  @Post(':id/sessions/epc') async epc(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');const input=parseWithSchema(epcSchema,body);return this.stations.epc(ctx,parseWithSchema(uuidSchema,id),input.sessionId,input.epc);}
  @Post(':id/sessions/barcode') async barcode(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');const input=parseWithSchema(barcodeSchema,body);return this.stations.barcode(ctx,parseWithSchema(uuidSchema,id),input.sessionId,input.barcode);}
  @Post('sessions/:id/cancel') async cancel(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requirePermission(ctx,'rfid.scan');await this.stations.cancel(ctx,parseWithSchema(uuidSchema,id));return {ok:true};}
}
