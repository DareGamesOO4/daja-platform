import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { TenantAccessDeniedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { ReaderStationService } from './reader-station.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

const registerSchema=z.object({name:z.string().trim().min(1).max(120),locationId:uuidSchema.optional(),hardwareKey:uuidSchema.optional()});
const stationPreviewSchema=z.object({name:z.string().trim().min(1).max(240),sku:z.string().trim().max(120).optional(),barcode:z.string().trim().max(256).optional(),imageUrl:z.string().url().max(2000).optional(),description:z.string().trim().max(1000).optional()});
const startSchema=z.object({stationId:uuidSchema,clientId:uuidSchema,preview:stationPreviewSchema.optional()});
const epcSchema=z.object({sessionId:uuidSchema,epc:z.string().trim().min(1).max(256)});
const barcodeSchema=z.object({sessionId:uuidSchema,barcode:z.string().trim().max(256).optional()});
const findStartSchema=z.object({stationId:uuidSchema,clientId:uuidSchema,epc:z.string().trim().min(1).max(256),preview:stationPreviewSchema.optional()});
const findProximitySchema=z.object({sessionId:uuidSchema,epc:z.string().trim().min(1).max(256),rssi:z.number().min(-150).max(20),proximity:z.number().min(0).max(1)});
function requireReaderAccess(ctx: RequestContext): void {
  if (ctx.permissions.includes('rfid.scan') || ctx.roles.includes('Unosilac kataloga')) return;
  throw new TenantAccessDeniedError();
}
@Controller('rfid/reader-stations')
export class ReaderStationController {
  constructor(@Inject(ReaderStationService) private readonly stations: ReaderStationService) {}
  @Post('register') async register(@Req() req:Request,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.register(ctx,parseWithSchema(registerSchema,body));}
  @Post(':id/heartbeat') async heartbeat(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);await this.stations.heartbeat(ctx,parseWithSchema(uuidSchema,id));return {ok:true};}
  @Get() async list(@Req() req:Request){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.list(ctx);}
  @Post('sessions') async start(@Req() req:Request,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.start(ctx,parseWithSchema(startSchema,body));}
  @Post('find-sessions') async startFind(@Req() req:Request,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.startFind(ctx,parseWithSchema(findStartSchema,body));}
  @Get('find-sessions/:id') async findSession(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.findSession(ctx,parseWithSchema(uuidSchema,id));}
  @Post('find-sessions/:id/cancel') async cancelFind(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);await this.stations.cancelFind(ctx,parseWithSchema(uuidSchema,id));return {ok:true};}
  @Post(':id/find-sessions/proximity') async findProximity(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);const input=parseWithSchema(findProximitySchema,body);return this.stations.findProximity(ctx,parseWithSchema(uuidSchema,id),input);}
  @Post(':stationId/find-sessions/:sessionId/complete') async completeFind(@Req() req:Request,@Param('stationId') stationId:string,@Param('sessionId') sessionId:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);await this.stations.completeFind(ctx,parseWithSchema(uuidSchema,stationId),parseWithSchema(uuidSchema,sessionId));return {ok:true};}
  @Post(':id/sessions/epc') async epc(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);const input=parseWithSchema(epcSchema,body);return this.stations.epc(ctx,parseWithSchema(uuidSchema,id),input.sessionId,input.epc);}
  @Post(':id/sessions/barcode') async barcode(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);const input=parseWithSchema(barcodeSchema,body);return this.stations.barcode(ctx,parseWithSchema(uuidSchema,id),input.sessionId,input.barcode);}
  @Get('sessions/:id') async session(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);return this.stations.session(ctx,parseWithSchema(uuidSchema,id));}
  @Post('sessions/:id/cancel') async cancel(@Req() req:Request,@Param('id') id:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);await this.stations.cancel(ctx,parseWithSchema(uuidSchema,id));return {ok:true};}
  @Post(':stationId/sessions/:sessionId/abort') async abort(@Req() req:Request,@Param('stationId') stationId:string,@Param('sessionId') sessionId:string){const ctx=resolveRequestContext(req);requireReaderAccess(ctx);await this.stations.abortFromStation(ctx,parseWithSchema(uuidSchema,stationId),parseWithSchema(uuidSchema,sessionId));return {ok:true};}
}
