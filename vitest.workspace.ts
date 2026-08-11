import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/*.unit.test.ts', 'apps/**/*.unit.test.ts'],
      environment: 'node',
      env: {
        NODE_ENV: 'test',
        PORT: '3000',
        DATABASE_URL: 'postgres://daja_app:daja_app_password@localhost:5432/daja_platform',
        REDIS_URL: 'redis://localhost:6379',
        API_PUBLIC_BASE_URL: 'http://localhost:3000',
        CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
        LOG_LEVEL: 'silent'
      }
    }
  },
  {
    test: {
      name: 'integration',
      include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
      environment: 'node',
      fileParallelism: false,
      env: {
        NODE_ENV: 'test',
        PORT: '3000',
        DATABASE_URL: 'postgres://daja_app:daja_app_password@localhost:5432/daja_platform',
        REDIS_URL: 'redis://localhost:6379',
        API_PUBLIC_BASE_URL: 'http://localhost:3000',
        CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
        LOG_LEVEL: 'silent'
      },
      testTimeout: 30000,
      hookTimeout: 30000
    }
  }
]);
