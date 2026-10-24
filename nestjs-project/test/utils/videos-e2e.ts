import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, IsNull, Not } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import queueConfig from '../../src/config/queue.config';
import storageConfig from '../../src/config/storage.config';
import videosConfig from '../../src/config/videos.config';
import { originalKey } from '../../src/storage/storage-keys';
import { StorageService } from '../../src/storage/storage.service';
import { testStorageConfig } from '../../src/test/storage-test-config';
import { Video } from '../../src/videos/entities/video.entity';

export const E2E_QUEUE_PREFIX = 'streamtube-test';

export interface VideosTestContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  storage: StorageService;
}

export async function createVideosTestApp(
  videosOverrides: Partial<ConfigType<typeof videosConfig>> = {},
): Promise<VideosTestContext> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    // Test bucket + a public endpoint reachable from inside the container.
    .overrideProvider(storageConfig.KEY)
    .useValue(testStorageConfig())
    // Test-scoped queue namespace: a running video-worker never sees these jobs.
    .overrideProvider(queueConfig.KEY)
    .useValue({ ...queueConfig(), prefix: E2E_QUEUE_PREFIX })
    .overrideProvider(videosConfig.KEY)
    .useValue({ ...videosConfig(), ...videosOverrides })
    .compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    storage: moduleFixture.get(StorageService),
  };
}

export function resetThrottler(app: INestApplication): void {
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
}

// Registers through the API, confirms directly in the DB and logs in.
export async function createAuthenticatedUser(
  ctx: VideosTestContext,
  email: string,
): Promise<string> {
  const password = 'password123';
  const server = ctx.app.getHttpServer();
  await request(server)
    .post('/auth/register')
    .send({ email, password })
    .expect(201);
  await ctx.dataSource.query(
    'UPDATE "users" SET "is_confirmed" = true WHERE "email" = $1',
    [email],
  );
  const res = await request(server)
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

// Aborts multipart uploads still open for drafts, so the test bucket stays clean.
export async function abortOpenUploads(ctx: VideosTestContext): Promise<void> {
  const open = await ctx.dataSource
    .getRepository(Video)
    .findBy({ upload_id: Not(IsNull()) });
  for (const video of open) {
    await ctx.storage
      .abortMultipartUpload(originalKey(video.id), video.upload_id!)
      .catch(() => undefined);
  }
}
