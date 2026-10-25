---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-24T17:23:49-03:00"
  "bullmq":
    version: "^6.4.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-24T17:23:49-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T17:23:49-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-24T17:23:49-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T17:21:42-03:00"
---

# Library References

Distilled from Context7 for the surfaces the Phase 03 TDs use. None of these packages is installed yet in `nestjs-project/package.json`; versions are the ranges to install.

## Version notes

- **`@nestjs/bullmq` — pin the 11.x line (`^11.0.5`).** `12.0.0` is published with `"type": "module"` (ESM-only). The project builds CommonJS (`module: nodenext`, no `"type": "module"`) with ts-jest. `11.0.5` peers: `@nestjs/common`/`@nestjs/core` `^10 || ^11`, `bullmq` `^3 || ^4 || ^5 || ^6` (checked on npm 2026-10-24). Matches phase-03-videos/TD-01.
- **`bullmq` `^6.4.2`** ships a CJS entry (`main: ./dist/cjs/index.js`). Context7 indexes v6.3.11; the APIs used here are the same.
- **`@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` `^3.1156.0`** — keep both on the same version. Context7 indexes v3.1153.0.

## Libraries

### @nestjs/bullmq

Used by: phase-03-videos/TD-01 (queue), TD-07 (enqueue on `complete`), TD-08 (standalone worker context), TD-12 (retries).

- **Root connection:** `BullModule.forRootAsync({ imports, useFactory: (cfg) => ({ connection: { host, port } }), inject: [...] })` registers a global module. Use the project's `registerAs` config factory via `@Inject(xxxConfig.KEY)`/`inject: [xxxConfig.KEY]`, per the inherited config conventions. Host is the Compose service name (`redis`), never `localhost`.
- **Queue:** `BullModule.registerQueue({ name: 'video-processing' })` in the module that enqueues. Inject it with `@InjectQueue('video-processing') queue: Queue`.
- **Processor:** a class decorated `@Processor('video-processing')` that `extends WorkerHost` and implements `async process(job: Job<T>): Promise<R>`. A rejected promise marks the attempt failed, and BullMQ applies `attempts`/`backoff`. The resolved value becomes `job.returnvalue`.
- **Worker events:** `@OnWorkerEvent('failed' | 'completed' | 'error' | 'stalled' | …)` on methods of the `@Processor` class. `this.worker` is only available from `onApplicationBootstrap` onward.
- **Worker in its own container (TD-08):** register the processor only in the worker's module, which is booted via `NestFactory.createApplicationContext(WorkerModule)`, and keep it out of the API's module graph. The API module registers the queue only, so it can produce jobs without consuming them.

### bullmq

Used by: phase-03-videos/TD-01, TD-07, TD-12, TD-18.

- **Retries with backoff:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })` waits `2^(attempt-1) * delay` ms between attempts. These can also be set once as `defaultJobOptions` on the queue.
- **Permanent failure without retries:** throw `new UnrecoverableError(msg)` (from `bullmq`) in the processor. The job moves straight to `failed` and ignores `attempts`. Use it for TD-18 `unsupported_format` and non-video content, so TD-12 retries only spend attempts on transient errors.
- **Idempotent enqueue:** `queue.add(name, data, { jobId })`. A job whose id already exists is ignored. Custom ids **must not contain `:` and must not be purely numeric**. The video id (UUID) satisfies both.
- **Final-failure detection:** in the `failed` handler, compare `job.attemptsMade` with `job.opts.attempts` (or check for `UnrecoverableError`) before writing `processing_status = failed` and the reason.
- **Redis requirements (production guide):** `maxmemory-policy noeviction` is the only setting that keeps queues correct. Enable AOF (`appendonly yes`) for durability across restarts. Workers need `maxRetriesPerRequest: null` on their connection, and should be closed gracefully on shutdown (`enableShutdownHooks`) to avoid stalled jobs, which are reprocessed after ~30s by default.

### @aws-sdk/client-s3

Used by: phase-03-videos/TD-02, TD-03, TD-05, TD-06, TD-07, TD-09, TD-13, TD-15.

- **MinIO client config (TD-06):** `new S3Client({ endpoint: 'http://minio:9000', forcePathStyle: true, region, credentials })` gives path-style addressing (`host/bucket/key`). This is the internal client, used for all server-side operations. The second client has the same options but `endpoint` set to the public URL and is used **only** to sign client-facing URLs.
- **Checksum defaults:** newer v3 releases default `requestChecksumCalculation` to `WHEN_SUPPORTED`, which adds CRC32 checksum headers (`x-amz-sdk-checksum-algorithm`, `x-amz-checksum-crc32`) to operations such as `PutObject`/`UploadPart`. For presigned part URLs that a client fills with arbitrary bytes, and for S3-compatible servers, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` on both clients (see aws-sdk-js-v3 issue #6810).
- **Multipart lifecycle (TD-02/TD-03/TD-07/TD-13):**
  - `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` returns the `UploadId` to persist on the draft.
  - `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` is presigned, never sent by the API. Each response carries an `ETag`, which a browser can only read when the bucket's CORS config sets `ExposeHeaders: ETag`.
  - `ListPartsCommand({ Bucket, Key, UploadId })` is used for resume, to report the parts already stored.
  - `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` takes the parts in ascending `PartNumber` order.
  - `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` backs the explicit abort endpoint. `NoSuchUpload` errors indicate an expired or aborted upload.
  - `HeadObjectCommand({ Bucket, Key })` reads `ContentLength`, to check it against the declared size at `complete`.
- **Incomplete-upload expiry (TD-13):** `PutBucketLifecycleConfigurationCommand` with a rule `{ Status: 'Enabled', Filter: { Prefix: 'videos/' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: N } }`.

### @aws-sdk/s3-request-presigner

Used by: phase-03-videos/TD-03, TD-09, TD-15.

- `getSignedUrl(client, command, { expiresIn })` returns a URL string. `expiresIn` is in seconds and **defaults to 900** if omitted. The URL is valid for the host of the `client` used to sign, which is why TD-06 signs with the public-endpoint client for browser/client URLs and with the internal client for the worker (TD-09).
- **Part URLs (TD-03):** `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })`, issued on demand in batches.
- **Stream URL (TD-15):** `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key }), { expiresIn })`. Storage answers `Range` requests with `206 Partial Content`.
- **Download URL (TD-15):** `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="<name>"' })`. Response-header overrides only work on signed requests, which presigned URLs are.
- **Worker media access (TD-09):** sign `GetObjectCommand` with the **internal** client and pass the URL to `ffprobe`/`ffmpeg` as input.
