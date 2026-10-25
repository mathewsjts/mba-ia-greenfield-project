# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, object storage, queue broker, video worker) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -fsS http://localhost:9000/minio/health/ready` — expect HTTP 200; `docker compose ps -a minio-init` must show `Exited (0)` (buckets provisioned)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started, consuming queue "video-processing"`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — consumes the `video-processing` queue (same codebase and image, standalone Nest application context, no HTTP server)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7.4 (BullMQ broker), port `6379`, `maxmemory-policy noeviction` + AOF
- `minio` — S3-compatible object storage (`pgsty/minio`), S3 API on port `9000`, console on `9001`, credentials `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` (dev: `streamtube` / `streamtube-secret`)
- `minio-init` — one-shot job that creates the `streamtube-videos` and `streamtube-videos-test` buckets (idempotent)
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (node dist/worker)
npm run start:worker:dev                 # Video worker in watch mode (local use; output in dist-worker/)
npm run openapi:export                   # Regenerate openapi.json from the code

npm test                                 # Unit + integration tests (serial, --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report (serial, --runInBand)
npm run test:e2e                         # End-to-end tests (serial, --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database, so they **must** run serially. The `test`, `test:cov` and `test:e2e` scripts already pass `--runInBand`; keep the flag when invoking `jest` directly:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

### Video worker (`video-worker` service)

The Compose service builds and runs the worker directly (`nest build --path tsconfig.worker.json && exec node dist-worker/worker`) under `init: true`, so SIGTERM reaches node and the worker closes gracefully (it finishes the in-flight job, then exits `0`). It has `restart: on-failure`, so it keeps retrying until the build succeeds (e.g. on a fresh clone, before the first `npm install`); a graceful shutdown is not restarted. It does **not** watch files — after changing worker code run:

```bash
docker compose restart video-worker
```

The worker builds into `dist-worker/` (not `dist/`) so it never deletes the API's build output.

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## Videos (upload, processing and delivery)

Module layout: `VideosModule` (HTTP controller, API only) imports `VideosCoreModule` (`Video` entity, `VideosService`, queue producer); the worker's `VideoProcessingModule` imports `VideosCoreModule` + `MediaModule` and hosts `VideoProcessor`. `AppModule` never registers the processor, so the API only produces jobs. `StorageModule` is the only module that talks to the S3 SDK.

**Upload (10 GiB, direct to storage — the API never receives file bytes):** every route requires the JWT and is owner-only (non-owners get `404 VIDEO_NOT_FOUND`).

1. `POST /videos` `{ fileName, size, contentType, title? }` → draft (`status: draft`, `processingStatus: awaiting_upload`) + S3 multipart upload; returns `upload: { partSize, partCount }`. Rejects `size` > 10737418240 (`413 VIDEO_TOO_LARGE`) and anything other than `video/mp4` (`.mp4`/`.m4v`) or `video/webm` (`.webm`) (`415 UNSUPPORTED_VIDEO_FORMAT`).
2. `POST /videos/:publicId/upload/part-urls` `{ partNumbers }` → short-lived presigned `UploadPart` URLs; the client `PUT`s each part to storage and keeps the `ETag` header. `GET /videos/:publicId/upload/parts` lists stored parts for resume. `DELETE /videos/:publicId/upload` aborts (`failed` / `upload_aborted`).
3. `POST /videos/:publicId/upload/complete` `{ parts: [{ partNumber, etag }] }` → assembles the upload, checks the stored size (`422 UPLOAD_SIZE_MISMATCH`), moves to `processing` and enqueues the job → `202`.

**Processing:** BullMQ queue `video-processing`, job `process-video`, payload `{ videoId }`, `jobId = videoId`, `attempts: 3` with exponential backoff (5 s). The worker reads the original through an internal presigned URL with HTTP range reads (`ffprobe`/`ffmpeg` never download the whole file), accepts only MP4 (H.264/VP9/AV1) or WebM (VP8/VP9/AV1) with AAC/MP3/Opus/Vorbis or no audio, persists `duration`, `width`, `height`, `container`, `video_codec`, `audio_codec`, stores a 1280px-wide JPEG thumbnail (frame at 10% of the duration, first frame below 1 s) and sets `processing_status = ready`. Unsupported/unreadable media fails immediately as `unsupported_format` (no retries); exhausted retries fail as `processing_error`.

**Statuses:** `status` is always `draft` in this phase (publication belongs to Phase 04). `processing_status`: `awaiting_upload → processing → ready | failed`; `failure_reason` ∈ `unsupported_format`, `processing_error`, `size_mismatch`, `upload_expired`, `upload_aborted`.

**Delivery:** `GET /videos/:publicId` (owner view, poll for status), and `GET /videos/:publicId/{stream|download|thumbnail}` → `{ url, expiresAt }` presigned for the public endpoint (`409 VIDEO_NOT_READY` until `ready`). Stream URLs answer `Range` with `206`; download URLs carry `Content-Disposition: attachment`.

**Storage layout:** one private bucket (`STORAGE_BUCKET`), keys `videos/{id}/original` and `videos/{id}/thumbnail.jpg` (`id` = internal UUID; URLs use the 11-char `public_id`). MinIO ignores bucket lifecycle `AbortIncompleteMultipartUpload` and bucket CORS, so stale multipart uploads expire server-side (`MINIO_API_STALE_UPLOADS_EXPIRY=24h`) and the global CORS (`MINIO_API_CORS_ALLOW_ORIGIN`) exposes `ETag`; on AWS S3 use a lifecycle rule and bucket CORS instead.

**Environment keys** (validated in `src/config/env.validation.ts`):

- `STORAGE_ENDPOINT` (container-to-container, e.g. `http://minio:9000`) and `STORAGE_PUBLIC_ENDPOINT` (what clients can reach, e.g. `http://localhost:9000` — used only to sign client URLs), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`.
- `REDIS_HOST` (`redis`), `REDIS_PORT`, `QUEUE_PREFIX` (default `bull`; test suites use `streamtube-test` so a running worker never consumes their jobs).
- `UPLOAD_PART_SIZE_BYTES` (default 64 MiB, minimum 5 MiB), `UPLOAD_PART_URL_EXPIRES_SECONDS` (900), `MEDIA_URL_EXPIRES_SECONDS` (3600).

**Tests:** storage, queue and worker tests run against the real `minio` / `redis` services and the real `ffmpeg` binary — the test bucket is `streamtube-videos-test`. Media fixtures live in `test/fixtures/media/`. Because the suites run inside the `nestjs-api` container (where `localhost:9000` is not MinIO), they sign client URLs for `STORAGE_ENDPOINT` via `src/test/storage-test-config.ts`; E2E suites use `test/utils/videos-e2e.ts`.

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
