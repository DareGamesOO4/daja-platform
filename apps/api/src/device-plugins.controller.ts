import { Body, Controller, Get, Inject, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { ValidationFailedError } from '@daja/security';
import { parseWithSchema } from '@daja/validation';
import {
  DevicePluginsService,
  createDevicePluginReleaseSchema,
  type DevicePluginAdminRelease,
  type DevicePluginManifest,
  type DevicePluginReleaseUpload
} from './device-plugins.service.js';
import { resolveRequestContext } from './runtime/request-context.js';

@Controller('plugins')
export class DevicePluginsController {
  constructor(@Inject(DevicePluginsService) private readonly plugins: DevicePluginsService) {}

  @Get('catalog')
  catalog(): ReturnType<DevicePluginsService['catalog']> {
    return this.plugins.catalog();
  }

  @Get('packages/:pluginId/:version/download')
  async download(
    @Param('pluginId') pluginId: string,
    @Param('version') version: string,
    @Res() response: Response
  ): Promise<void> {
    const { downloadUrl } = await this.plugins.download(pluginId, version);
    response.redirect(302, downloadUrl);
  }

  @Get('admin/releases')
  listReleases(@Req() request: Request): Promise<DevicePluginAdminRelease[]> {
    return this.plugins.listReleases(resolveRequestContext(request));
  }

  @Post('admin/releases')
  createRelease(
    @Req() request: Request,
    @Body() body: unknown
  ): Promise<DevicePluginReleaseUpload> {
    return this.plugins.createRelease(
      resolveRequestContext(request),
      parseWithSchema(createDevicePluginReleaseSchema, body)
    );
  }

  @Put('admin/releases/:pluginId/:version/archive')
  uploadArchive(
    @Req() request: Request,
    @Param('pluginId') pluginId: string,
    @Param('version') version: string
  ): Promise<DevicePluginAdminRelease> {
    if (
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/zip'
    ) {
      throw new ValidationFailedError(
        'Plugin archive upload must use content-type application/zip'
      );
    }
    return this.plugins.uploadReleaseArchive(
      resolveRequestContext(request),
      pluginId,
      version,
      request as unknown as Readable
    );
  }

  @Post('admin/releases/:pluginId/:version/publish')
  publish(
    @Req() request: Request,
    @Param('pluginId') pluginId: string,
    @Param('version') version: string
  ): Promise<DevicePluginManifest> {
    return this.plugins.publishRelease(resolveRequestContext(request), pluginId, version);
  }

  @Post('admin/releases/:pluginId/:version/unpublish')
  async unpublish(
    @Req() request: Request,
    @Param('pluginId') pluginId: string,
    @Param('version') version: string
  ) {
    await this.plugins.unpublishRelease(resolveRequestContext(request), pluginId, version);
    return { unpublished: true };
  }
}
