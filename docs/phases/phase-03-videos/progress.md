# phase-03-videos — Progress

**Status:** completed
**SIs:** 13/13 completed

**Final verification (2026-10-24):** unit + integration 262/262 tests (39 suites) · E2E 78/78 tests (7 suites) · `tsc --noEmit` exit 0 · eslint 0 errors (48 warnings, all `no-unsafe-argument`, configured as warning) · frontend contract freshness: regeneration is a no-op. No open handles.

### SI-03.1 — Infra: storage S3 (MinIO), Redis e FFmpeg no ambiente Docker
- **Status:** completed
- **Tests:** no tests (Infra). ACs verified manually: all services healthy; `minio-init` exit 0 (idempotent on rerun); Redis `noeviction` + `appendonly yes`; `ffprobe`/`ffmpeg` 5.1.9 in the image.
- **Observations:**
  - MinIO (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`) rejects a lifecycle rule carrying only `AbortIncompleteMultipartUpload`, and silently drops it when combined with another action. It also returns "not implemented" for bucket-level CORS (`mc cors set`). With the user's approval, both were replaced by MinIO-native server settings: `MINIO_API_STALE_UPLOADS_EXPIRY=24h` + `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL=1h` (the storage-level expiry of TD-13), and `MINIO_API_CORS_ALLOW_ORIGIN=*`, whose global CORS already exposes `Etag` (TD-02). `minio-init` only creates the buckets. The S3 lifecycle rule remains the production (AWS S3) path.
  - Pinned images: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `pgsty/mc:RELEASE.2026-09-16T00-00-00Z`, `redis:7.4.11-alpine`. Bucket names default to `streamtube-videos` / `streamtube-videos-test` via Compose interpolation (`STORAGE_BUCKET` / `STORAGE_TEST_BUCKET`).
  - TD-13 Revisions follow-up: the decisions doc still describes the lifecycle rule; record a `/decide` revision for the MinIO-native mechanism.

### SI-03.2 — Configuração: variáveis de storage, fila e upload
- **Status:** completed
- **Tests:** 13 passing (`src/config/env.validation.integration-spec.ts`); `tsc --noEmit` clean
- **Observations:**
  - Required keys: `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `REDIS_HOST`. Defaults: `STORAGE_REGION=us-east-1`, `REDIS_PORT=6379` and the three upload/delivery keys. Dev credentials (`streamtube` / `streamtube-secret`) match the Compose defaults of the `minio` service.

### SI-03.3 — StorageModule: clientes S3 interno/público e StorageService
- **Status:** completed
- **Tests:** 8 passing (`storage.module.spec.ts`, `storage.service.integration-spec.ts`)
- **Observations:**
  - Added the test helper `src/test/storage-test-config.ts` (test bucket + public endpoint = internal container hostname), reused by later integration suites. The public-vs-internal host AC is verified by signing with an unreachable public host (`public.example.test`) and asserting URL hosts only.
  - `listParts` paginates with `PartNumberMarker` (S3 returns at most 1000 parts per page, while a 10 GiB upload can have up to 10000).

### SI-03.4 — Infra: QueueModule (BullMQ + Redis)
- **Status:** completed
- **Tests:** 2 passing (`src/queue/queue.module.spec.ts`); `tsc --noEmit` + eslint clean
- **Observations:**
  - Installed `@nestjs/bullmq@11.0.5` + `bullmq@6.4.2`.
  - `tsc` caught a `fetch` body typing error in SI-03.3's integration spec (`Buffer` is not `BodyInit` under the installed lib types; ts-jest does not type-check). Fixed with `new Uint8Array(body)`; the 8 storage tests still pass.
  - `ProcessVideoJobData` (`{ videoId }`) lives in `queue.constants.ts`, next to the queue/job names, so producer and consumer share one payload type.

### SI-03.5 — Entidade Video, migração CreateVideos e gerador de public id
- **Status:** completed
- **Tests:** 120 passing (new `video.entity.integration-spec.ts`, `public-id.spec.ts`, updated `migrations.integration-spec.ts`, plus every suite under `src/{videos,database,channels,users,auth}`)
- **Observations:**
  - Migration `1792878763609-CreateVideos.ts` (generated, reviewed, applied to the dev DB). Adds a `CHK_videos_size_bytes` check (`> 0 AND <= 10737418240`) enforcing the Data Model size constraint at the DB level.
  - Adding `Channel.videos` forced `Video` into the hard-coded `ALL_ENTITIES` list of 10 existing test suites (TypeORM requires both sides of a relation in the DataSource). Fixed on the first attempt. A shared test-entities constant would remove that duplication — follow-up, not done here.
  - The migrations spec now treats `CreateVideos` as the last migration (the revert test checks the `videos` table and both enum types are dropped while the token tables remain).
  - Until SI-03.6 registers `VideosModule` (`TypeOrmModule.forFeature([Video])`), booting `AppModule` fails on the `Channel.videos` relation. SI-03.6 closes this gap.

### SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- **Status:** completed
- **Tests:** 27 passing (20 unit/integration across `videos.service.spec.ts`, `videos.service.integration-spec.ts`, `videos.module.spec.ts`, `channels.service.integration-spec.ts`; 7 E2E in `test/videos-initiate-upload.e2e-spec.ts` from `specs/videos-initiate-upload.plan.md`)
- **Observations:**
  - Format/size rules live in a pure module `src/videos/video-upload-rules.ts` (`MAX_VIDEO_SIZE_BYTES`, `isAcceptedFormat`, `defaultTitle`, `partCountFor`). The extension/content-type pairing is a domain rule (415), not DTO validation, matching the Error Catalog.
  - Added the shared E2E helper `test/utils/videos-e2e.ts`. It overrides the `storage`/`videos` config providers (test bucket + container-reachable public endpoint), confirms users directly in the DB, resets the throttler, and aborts multipart uploads left open by drafts. It is reused by the other video E2E suites.
  - With `VideosModule` registered, `AppModule` boots again (closes the SI-03.5 gap).

### SI-03.7 — Endpoints de upload: URLs de partes, listagem para retomada e abort
- **Status:** completed
- **Tests:** 25 unit/integration passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts`) + 6 E2E passing (`test/videos-upload-parts.e2e-spec.ts` from `specs/videos-upload-parts.plan.md`). The SI-03.6 E2E suite still passes (13 E2E total).
- **Observations:**
  - Presigning never contacts storage, so `part-urls` can only answer `410 UPLOAD_EXPIRED` after a real storage check. Added `StorageService.assertUploadExists` (`ListParts` with `MaxParts: 1`) and call it before presigning.
  - Failure-state writes are conditional (`UPDATE ... WHERE processing_status = 'awaiting_upload'`), so concurrent calls cannot move a video out of a later state.
  - Fix loop, 1 attempt, both test-side: (a) the integration service used the default 64 MiB part size for a 5 MiB + 2 KiB draft (1 part only) and now uses 5 MiB; (b) the E2E non-owner scenario built three supertest requests up front, and each one binds and closes the server's ephemeral port, causing `ECONNREFUSED`. Requests are now built lazily.

### SI-03.8 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)
- **Status:** completed
- **Tests:** 51 unit/integration passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts`, `queue.module.spec.ts`, `env.validation.integration-spec.ts`, `videos.module.spec.ts`) + 19 E2E passing (new `test/videos-upload-complete.e2e-spec.ts` from `specs/videos-upload-complete.plan.md`, plus the initiate/parts suites)
- **Observations:**
  - **Dependency added:** `ioredis@^5.11.1`. BullMQ 6 declares `ioredis` as an *optional* peer, so it was never installed, and every queue failed with "could not load the optional 'ioredis' package". `ioredis@6` conflicts with `typeorm@0.3.28`'s optional peer `^5.0.4`; 5.11.1 satisfies both. `library-refs.md` does not list it.
  - **Test isolation (TD-17), added to SI-03.4's queue config:** a `QUEUE_PREFIX` key (Joi default `bull`), passed as the BullMQ `prefix`. Integration and E2E suites use the `streamtube-test` prefix, so the future `video-worker` never consumes test jobs.
  - Enqueue ordering: DB update to `processing` first, then `queue.add` with `jobId = video.id`. If the enqueue fails, the row rolls back to `awaiting_upload` with its `upload_id`, so a retried complete recovers through the `NoSuchUpload` + existing-object path.
  - Fix loop, 1 attempt: installed `ioredis`. Separately, `videos.module.spec.ts` now loads `QueueModule` (otherwise BullMQ defaults to `localhost:6379`, logging `ECONNREFUSED` and leaving an open handle).

### SI-03.9 — MediaModule: wrapper tipado de ffprobe/ffmpeg e allowlist de formatos
- **Status:** completed
- **Tests:** 22 passing (`media-format.spec.ts`, `media-thumbnail.service.spec.ts`, `media-probe.service.integration-spec.ts`, `media-thumbnail.service.integration-spec.ts`)
- **Observations:**
  - `src/media/run-process.ts` runs binaries via `spawn` without a shell and SIGKILLs them past the timeout (probe 30 s, thumbnail 60 s). Errors are typed: `MediaUnreadableError`, `MediaProcessTimeoutError`, `MediaProcessFailedError`.
  - Fixtures in `test/fixtures/media/` (4–44 KB each) were generated with the image's `ffmpeg` 5.1.9 from `lavfi` test sources: `h264-aac.mp4`, `vp9-opus.webm`, `h264-noaudio.mp4`, `hevc.mp4`, `short-0_5s.mp4`, `not-a-video.mp4`.
  - The JPEG width is asserted by running `ffprobe` on the extracted frame (a 320 px source upscaled to 1280 px).

### SI-03.10 — VideoProcessor: metadados, thumbnail e política de falha
- **Status:** completed
- **Tests:** 53 passing (`video.processor.spec.ts`, `video.processor.integration-spec.ts`, `videos.service.integration-spec.ts`, `videos.service.spec.ts`)
- **Observations:**
  - The processor runs `headObject` before probing, so a transient storage failure throws a normal (retried) error. Only an object that exists but that `ffprobe` cannot parse becomes `UnrecoverableError` → `unsupported_format`, so storage blips do not burn the format path.
  - The range-read AC (TD-09) is verified by serving a *virtual* file (real fixture + generated zero padding, backpressured 64 KiB slices) to the real `ffprobe`/`ffmpeg`. A 1 GiB original reads no more than ~2× the bytes of a 64 MiB one, and < 5% of the file (the bytes read are bounded by socket buffering, not file size). Fix loop, 1 attempt: the first version's server wrote whole ranges with `res.end()` and its "< 1/4 of the file" bound measured kernel buffering rather than consumption.
  - `VideosService.markReady` / `markProcessingFailed` are conditional on `processing_status = processing` and return whether a row changed.
  - `VideoProcessingModule` (consumer) is not imported by `AppModule`; it is wired only into the worker (SI-03.11).

### SI-03.11 — Runtime do Video Worker: contexto Nest standalone e serviço Compose
- **Status:** completed
- **Tests:** 3 passing (`worker.module.spec.ts`, `app.module.spec.ts`, `videos.module.spec.ts`). Runtime ACs verified manually against the real `video-worker` container with a throwaway script (not committed):
  - a queued `process-video` job → `ready` (mp4/h264/aac, 2 s, 320×240) plus a 37 KB JPEG thumbnail;
  - worker stopped → the video stays `processing`; restarted → the pending job is consumed → `ready`;
  - `docker compose stop video-worker` → exit code 0, with `SIGTERM received` / `Worker closed` logged.
- **Observations:**
  - `src/config/root-config.module.ts` (`RootConfigModule`) now holds the `ConfigModule.forRoot` + `TypeOrmModule.forRootAsync` setup, shared by `AppModule` and `WorkerModule`.
  - **Module split:** `VideosCoreModule` (entity, `VideosService`, queue producer, storage, channels) vs `VideosModule` (HTTP controller only). The worker imports only the core, so its graph has no controllers (AC). `WorkerModule` also imports `UsersModule`, because TypeORM needs the `User` side of `Channel#user`.
  - **Graceful shutdown:** `worker.ts` handles SIGTERM/SIGINT itself (`app.close()` → `@nestjs/bullmq` closes the worker after the in-flight job → `process.exit(0)`), instead of `enableShutdownHooks()`, which re-raises the signal (exit 143). In Compose, the worker runs the compiled build (`nest build --path tsconfig.worker.json && exec node dist-worker/worker`) under `init: true` (tini) with `stop_grace_period: 60s`. With `npm run`/`nest start --watch` as PID 1, the watch wrapper killed the child abruptly (exit 1 / 143, no shutdown log). Code changes need `docker compose restart video-worker`; `npm run start:worker:dev` (watch) remains for local use.
  - `dist-worker/` (the worker's own build output, so it does not fight the API's `deleteOutDir` on `dist/`) is excluded in `tsconfig.json`, `tsconfig.build.json` and `.gitignore`. Without the exclusion, `nest build` read its own output (`TS5055`).
  - Fix loop: 1 attempt (`User` entity missing from the worker DataSource). The module split, the `dist-worker` exclusion and the signal handling came from verifying the runtime ACs.

### SI-03.12 — Endpoints de leitura e entrega: detalhe, streaming, download e thumbnail
- **Status:** completed
- **Tests:** 46 unit/integration passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts`) + 7 E2E passing (`test/videos-delivery.e2e-spec.ts` from `specs/videos-delivery.plan.md`)
- **Observations:**
  - `GET /videos/:publicId` reuses `findOwnedOrFail` + `toVideoResponse` directly, so the planned separate `getOwned` method was unnecessary. `getMediaUrl(kind)` covers stream / download / thumbnail.
  - The download `Content-Disposition` carries an ASCII fallback (`filename="..."`, quotes / backslashes / non-ASCII replaced by `_`) plus the RFC 6266 `filename*=UTF-8''...` form, so accented names survive.
  - The E2E expiry scenario runs with `MEDIA_URL_EXPIRES_SECONDS=5` (videos config override) and confirms storage answers `403` after `expiresAt`.

### SI-03.13 — Contrato OpenAPI re-sincronizado e documentação da fase
- **Status:** completed
- **Tests:** 12 passing (`src/openapi-export.integration-spec.ts`, extended with the 9 `/videos` paths and their documented status codes). Frontend freshness verified: re-running the sync + `openapi:types` is a no-op.
- **Observations:**
  - `nestjs-project/openapi.json` regenerated (+1018 lines: 9 `/videos` paths, response schemas, error envelopes); `next-frontend/lib/api/types.gen.ts` regenerated. No FE source file changed.
  - **Pre-existing, out of scope (follow-ups):** (a) `next-frontend/openapi.json` is gitignored (`next-frontend/.gitignore:42`), contradicting `next-frontend-openapi-typing/TD-02` (committed local copy) — only `types.gen.ts` is committable; (b) the TD-03 CI freshness workflow (`.github/workflows/openapi-freshness.yml`) does not exist; (c) request DTOs export with empty `properties` (the committed `RegisterDto` was already `{ properties: {} }`) because `openapi:export` runs through `ts-node`, which skips the `@nestjs/swagger` CLI plugin transformer — the project rule forbids hand-written `@ApiProperty` on request DTOs, so the fix belongs in the export pipeline.
  - The `next-frontend` container was started (dev-only `tail -f` CMD, no dev server) and its dependencies installed with `npm ci` (lockfile unchanged) to run `openapi:types`.
  - Docs: `nestjs-project/CLAUDE.md` (new services + readiness checks, worker commands and restart note, "Videos" section mirroring routes/statuses/queue/storage/env keys/tests); root `CLAUDE.md` and `docs/diagrams/software-arch.mermaid` (queue = BullMQ + Redis, worker = `video-worker`, API signs URLs instead of uploading bytes).
  - A whole-directory `prettier --write src` (SI-03.11) had reformatted `src/mail/templates/*.hbs` and dropped their `<!DOCTYPE html>`; both templates were restored with `git checkout`.
