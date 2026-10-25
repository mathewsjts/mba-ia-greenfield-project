---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-12
scope_description: "Backend foundation for video upload and processing: message queue, 10GB direct-to-storage upload protocol, S3-compatible storage layout and local server, video worker topology and FFmpeg integration, status lifecycle and failure policy, unique public video id, streaming/download delivery and its access policy, accepted input formats and transcoding stance, and the test strategy against real infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (upload handshake, draft pre-registration, delivery endpoints), the storage and queue integrations, the `video-worker` process, the `CreateVideos` migration, and the new Compose services (S3-compatible storage, Redis, worker).
- `next-frontend/` — no open decision in this document: the video UI is out of scope for this phase (backend-only delivery). The client-facing contracts that a future frontend will consume (TD-02 upload handshake, TD-15 delivery) are decided here as `Cross-layer` so the frontend inherits them instead of reopening them.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". Video processing (ffprobe + thumbnail) must run outside the HTTP request, survive API restarts, and retry on transient failures. The choice also determines a new Compose service and how the worker consumes jobs. Installed stack: NestJS 11.1, CommonJS output (`module: nodenext`, no `"type": "module"`), Jest 30 with ts-jest.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq` 11.x)
- Redis-backed job queue with first-party Nest integration (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`). Jobs carry `attempts` + `backoff: { type: 'exponential' }`; failures after the last attempt emit `failed` / `retries-exhausted`.
- **Pros:** Retries, exponential backoff, job ids (idempotent enqueue), concurrency and stalled-job recovery are built in. Official Nest recipe; processor class is a normal provider (DI, config, repositories). Redis is lightweight to run in Compose.
- **Cons:** New infra (Redis) with its own durability settings (needs `maxmemory-policy noeviction`; AOF for durability across restarts). `@nestjs/bullmq` 12.x is ESM-only and targets Nest 12 — must pin the 11.x line (`11.0.5` supports Nest 11 + `bullmq` 6).

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`)
- AMQP broker; API publishes a message, worker consumes with manual ack. Retries via dead-letter exchanges + TTL queues.
- **Pros:** Mature broker with strong delivery semantics, routing (exchanges), management UI. Language-agnostic consumers.
- **Cons:** No built-in retry/backoff — must be modeled with DLX/TTL topology. Heavier service (Erlang VM). The Nest RMQ transport is request/event oriented, not a job queue (no job state, no attempts counter). More moving parts for a single job type.

### Option C: pg-boss (queue on the existing PostgreSQL)
- Job queue implemented on Postgres tables (`SKIP LOCKED`), with retries, backoff and scheduling.
- **Pros:** Zero new infrastructure: reuses the `db` service. Transactional enqueue in the same database is possible.
- **Cons:** v12 is ESM-only (`"type": "module"`), friction with the CommonJS build and ts-jest. No official Nest module (manual lifecycle wiring). Polling-based; adds write load to the primary database that also serves the API.

**Recommendation:** **Option A (BullMQ + Redis, `@nestjs/bullmq@11.0.5`)** — it is the only option that provides retries/backoff, job ids and a Nest-native processor out of the box on the installed CommonJS + Nest 11 stack. The Redis service is a small, well-understood addition. RabbitMQ needs a hand-built retry topology, and pg-boss's ESM-only line conflicts with the build.

**Decision:** A
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Large-file Upload Protocol (10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Uploads of up to 10GB must not hold the API (`project-plan.md` §4: "não trave o sistema e permita retomar em caso de falha de conexão"). The protocol is a contract: the backend issues the handshake, and any client (today `curl`/tests, later `next-frontend`) must follow it.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (direct to storage)
- API creates the video draft and calls `CreateMultipartUpload`, then hands the client presigned `UploadPart` URLs. The client `PUT`s each part straight to storage and sends back the `ETag`s. API calls `CompleteMultipartUpload`. Resume = `ListParts` and upload only the missing parts.
- **Pros:** Zero video bytes flow through the API. Resumable by design (parts persist server-side until complete/abort). Parallel part uploads. The same protocol works unchanged on AWS S3 in production.
- **Cons:** Multi-step handshake (initiate → presign → complete/abort). Client must read the `ETag` response header (browser clients need storage CORS `ExposeHeaders: ETag`). Presigned URLs must be reachable from outside Docker (see TD-06).

### Option B: tus resumable protocol through the API (`@tus/server` + `@tus/s3-store`)
- API exposes a tus endpoint. The client streams chunks to the API, which forwards them to S3 multipart via the store.
- **Pros:** Standard resumable protocol with mature clients (`tus-js-client`, Uppy). Single endpoint; resume via `HEAD`/`PATCH` offsets.
- **Cons:** Every byte of the 10GB passes through the API process (bandwidth, memory and event-loop pressure on the API container). `@tus/server` 2.x is ESM-only. Adds a protocol-specific server mounted inside Express.

### Option C: Custom chunked upload through API endpoints
- Client splits the file and `POST`s chunks to the API, which writes each chunk as an S3 part.
- **Pros:** Full control over the contract; no presigned URL host issues.
- **Cons:** Same throughput problem as B (bytes through the API) without a standard protocol. Resume semantics, ordering and validation all hand-written.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — it is the only option where the API never touches the file bytes, which directly satisfies "sem impacto na performance". It is resumable natively and portable to AWS S3. The extra handshake steps are a small contract cost compared to proxying 10GB through Nest.

**Decision:** A
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-24 — Operational definition of "sem impacto na performance": the API never receives or buffers file bytes (direct-to-storage); API memory and request time do not grow with file size; uploads declared above 10 GiB are rejected at initiate before any part URL is issued; worker metadata/thumbnail extraction reads only the byte ranges it needs (TD-09), never the full object. Rationale: AMB-1 resolved in `/plan-resolve 3` (API + worker definition).

---

## TD-03: Part Sizing and Presigned-URL Issuance

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Depends on TD-02 (Option A). S3/MinIO multipart limits: parts of 5 MiB–5 GiB (last part may be smaller), at most 10,000 parts per upload. The server must decide who sets the part size, when part URLs are issued, and which files are accepted at initiate time (declared size ≤ 10GB, video MIME types).

**Options:**

### Option A: Server-defined fixed part size + on-demand presign batches
- `initiate` validates the declared size (≤ 10 GiB) and MIME type, and returns `partSize` (e.g. 64 MiB → ≤ 160 parts for 10GB) and `partCount`. The client requests short-lived presigned URLs for the part numbers it is about to upload, and can re-request them after expiry or on resume.
- **Pros:** Part count is deterministic and far below the 10,000 limit. Short URL lifetimes. Resume after hours or days just requests new URLs. Validation rules live in one place (server).
- **Cons:** One extra endpoint (presign parts) and more round-trips for very large files.

### Option B: Server-defined fixed part size + all URLs issued at initiate
- `initiate` returns every part URL at once, with a long expiry.
- **Pros:** One round-trip; simplest client.
- **Cons:** URLs must live as long as the slowest upload (hours to days), which widens the exposure window. A resume after expiry needs a re-issue endpoint anyway, so the extra endpoint is not really avoided.

### Option C: Client-chosen part size within S3 bounds
- Client decides part size and requests URLs per part number. The server only checks bounds.
- **Pros:** Clients can tune for network conditions.
- **Cons:** Server cannot guarantee the 10,000-part limit or predict part count. Validation of completeness becomes client-dependent. More surface for malformed uploads.

**Recommendation:** **Option A** — a server-owned part size keeps the 10GB/10,000-part math deterministic. On-demand short-lived URLs make resume work after any interruption without long-lived credentials in circulation. At `complete`, the server also verifies the stored object size with `HeadObject` against the declared size, and the worker's ffprobe (TD-09) rejects non-video content.

**Decision:** A

---

## TD-04: Local S3-compatible Storage Server Image

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project targets S3 in production and MinIO locally. Verified on 2026-10-12: the upstream `minio/minio` GitHub repository is archived. Official community images are no longer pullable (`minio/minio:*` on Docker Hub and the last `quay.io/minio/minio` release tag both fail `docker manifest inspect`), and `minio/mc` is gone too. The Compose file needs a pullable, pinned S3-compatible image for the API, the worker and the tests.

**Options:**

### Option A: Community-maintained MinIO rebuild (`pgsty/minio`, pinned release tag)
- Fork of `minio/minio` (GitHub parent: `minio/minio`, actively pushed) that keeps publishing MinIO builds, e.g. `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, plus `pgsty/mc` for bucket provisioning.
- **Pros:** Same MinIO server, S3 API and console the project and the brief refer to. Drop-in Compose service with a pinned tag; `mc` image available for init tasks. Multi-arch (amd64/arm64).
- **Cons:** Supply-chain trust moves to a third-party fork, not the original vendor. Future availability depends on that maintainer.

### Option B: Build MinIO from the archived upstream source (local Dockerfile)
- A multi-stage Dockerfile `go build`s a pinned upstream release tag.
- **Pros:** Original vendor code; no third-party binary.
- **Cons:** Slow first build (Go toolchain in the image), extra Dockerfile to maintain, and no security fixes ever (the repository is archived).

### Option C: Different S3-compatible server (e.g. SeaweedFS, Garage)
- Replace MinIO with another maintained S3-compatible server.
- **Pros:** Actively maintained upstream images.
- **Cons:** Diverges from the stated MinIO choice. Partial S3 API coverage differs per server (multipart/presign edge cases need re-validation). Different operational model (filer/volumes, layout config).

**Recommendation:** **Option A (`pgsty/minio`, pinned tag)** — it keeps the exact server the project and challenge specify, with a pullable pinned image and an `mc` companion. The fork-trust trade-off is acceptable for a dev/test-only service, because production uses AWS S3.

**Decision:** A

---

## TD-05: Bucket and Object-key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Originals and thumbnails must be stored with a layout that supports per-video lifecycle (delete, re-process) and the access policy (TD-16). `project-plan.md` §4 asks to plan storage growth and cost from the start.

**Options:**

### Option A: Single private bucket, per-video prefix
- One bucket (name from config). Keys `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`. All reads go through presigned URLs.
- **Pros:** One bucket to provision and configure (CORS, lifecycle). Deleting or re-processing a video works on a single prefix. No public-read surface. Keys use the internal UUID, not the public id (TD-14).
- **Cons:** Thumbnails also need presigned URLs (not cacheable as stable public URLs).

### Option B: Two buckets — private originals, public-read thumbnails
- `videos` (private) and `thumbnails` (anonymous read).
- **Pros:** Thumbnails get stable, CDN-friendly URLs.
- **Cons:** Two buckets to provision. Public-read thumbnails leak draft content before publication exists (Phase 03 videos are drafts). The policy split must be mirrored on AWS.

### Option C: Single bucket, prefix by asset type
- Keys `originals/{videoId}` and `thumbnails/{videoId}.jpg`.
- **Pros:** Per-type lifecycle rules (e.g. a different storage class for originals) are easy.
- **Cons:** A video's assets are scattered across prefixes, so delete or re-process touches several prefixes.

**Recommendation:** **Option A** — one private bucket with per-video prefixes matches the draft-only reality of Phase 03, keeps provisioning minimal, and makes video-level operations atomic on a prefix. Public thumbnail URLs can be revisited when publication arrives.

**Decision:** A

---

## TD-06: Presigned-URL Host Topology (internal vs public endpoint)

**Scope:** Backend

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Containers reach storage at the Compose service name (`http://minio:9000`, per CLAUDE.md). External clients cannot resolve `minio`. SigV4 signs the `Host`, so a URL signed for `minio:9000` cannot be rewritten to another host afterwards. Depends on TD-02 and TD-15.

**Options:**

### Option A: Two S3 clients — internal for operations, public for signing client URLs
- The internal client (`S3_ENDPOINT=http://minio:9000`) runs server-side operations (multipart create/complete, HeadObject, PutObject thumbnail, presigned GET used by the worker). A second client configured with `S3_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000` in dev, the S3 domain in prod) only signs URLs handed to external clients. Signing is offline, so this client makes no network calls.
- **Pros:** Correct signatures for both audiences. Container-to-container traffic still uses the service name. One env var switches environments.
- **Cons:** Two client instances and one extra env var. The public endpoint is the single documented exception to the "never localhost" rule: it is a host-facing URL, never used for container-to-container calls.

### Option B: Reverse proxy exposing storage under one public host
- An nginx service publishes MinIO under a stable host that resolves for every party, and URLs are signed for that host.
- **Pros:** Single endpoint for everyone.
- **Cons:** Extra service and proxy config (Host preservation, large-body streaming, timeouts). The proxy itself sits in the 10GB data path.

### Option C: Make `minio` resolvable on the host (`/etc/hosts`)
- Sign everything with the internal endpoint; developers add `127.0.0.1 minio` locally.
- **Pros:** One client, no extra config.
- **Cons:** Manual per-machine setup, not reproducible. Leaks Compose naming into client URLs. Does not reflect production.

**Recommendation:** **Option A** — signing with a public-endpoint client is the standard SigV4-safe answer. It keeps the CLAUDE.md networking rule intact for container traffic, and the only extra cost is one config key. The worker's media access (TD-09) must use the internal signer.

**Decision:** A

---

## TD-07: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing must start automatically once the upload is complete. With TD-02 Option A, the API is not in the data path, so something has to tell the system the upload finished.

**Options:**

### Option A: API `complete` endpoint enqueues the job
- The client calls the complete endpoint. The API runs `CompleteMultipartUpload`, verifies the object, moves the video to processing and enqueues the job (job id = video id).
- **Pros:** Explicit and synchronous with the handshake the client already performs. Deterministic to test end-to-end. Portable to AWS S3 without extra infra. Idempotent re-`complete` via job id.
- **Cons:** If the client never calls `complete`, nothing is processed (covered by TD-13). The API owns the DB-update + enqueue ordering.

### Option B: Storage bucket notification (`s3:ObjectCreated:CompleteMultipartUpload`) → enqueue
- MinIO publishes object-created events (webhook/Redis/AMQP target), and a consumer enqueues the processing job.
- **Pros:** Processing starts even if the client crashes right after the last part, as long as the upload was completed.
- **Cons:** Someone still has to call `CompleteMultipartUpload` (the client cannot do it without credentials), so the API is involved anyway. Notification targets differ between MinIO and AWS (SQS/EventBridge). More infra and config, harder to test deterministically.

**Recommendation:** **Option A** — with presigned multipart, the API already has to perform `CompleteMultipartUpload`, so enqueuing in the same step adds no infra and keeps the flow testable. Bucket notifications would add an event pipeline that solves no remaining problem.

**Decision:** A

---

## TD-08: Video Worker Runtime Topology

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The C4 diagram has a separate "Video Worker (FFmpeg)" container that consumes the queue, reads/saves storage and updates the DB. The worker needs the same entities, config and storage service as the API.

**Options:**

### Option A: Separate Compose service, same codebase and image, standalone Nest context
- `video-worker` service built from the same `Dockerfile.dev` (with ffmpeg installed), started with a different entrypoint (e.g. `src/worker.ts` → `NestFactory.createApplicationContext(WorkerModule)`) that registers only the queue processor plus TypeORM/storage. No HTTP server.
- **Pros:** Matches the C4 diagram (separate container, independently restartable and scalable). Reuses entities, config namespaces and the storage service without duplication. One `package.json` and one test runner.
- **Cons:** Two processes share a codebase, so module boundaries must keep the processor out of the API's `AppModule`. The image grows by the ffmpeg packages.

### Option B: Processor inside the API process
- Register the BullMQ processor in the API's `AppModule`, in the same container.
- **Pros:** Simplest setup; no new service.
- **Cons:** CPU-heavy FFmpeg work competes with HTTP handling in the same container. Contradicts the separate Video Worker container in the architecture. Cannot scale workers independently.

### Option C: Separate subproject (`video-worker/`) with its own `package.json`
- An independent Node project consuming the queue.
- **Pros:** Hard isolation; could even use another language.
- **Cons:** Duplicates entity, config and storage code (or forces a shared package/monorepo tooling). A second dependency tree, Dockerfile and test setup.

**Recommendation:** **Option A** — a dedicated container satisfies the architecture's isolation and scaling intent. Running it as a standalone Nest context from the same codebase avoids duplicating the domain layer.

**Decision:** A

---

## TD-09: Media Access Strategy for ffprobe/FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Originals can be 10GB. Extracting duration/metadata and one thumbnail frame needs only a small fraction of the file. Depends on TD-06 (internal signer) and TD-08.

**Options:**

### Option A: Download the full object to the worker's disk, then run ffprobe/ffmpeg locally
- `GetObject` streamed to a temp file, processed, then deleted.
- **Pros:** Local file I/O is the simplest input for FFmpeg; no network seeks.
- **Cons:** Transfers up to 10GB per job and needs equivalent temp disk. Processing time is dominated by the download.

### Option B: Run ffprobe/ffmpeg directly against a presigned GET URL (HTTP range reads)
- The worker presigns a short-lived internal GET URL and passes it as the FFmpeg input. FFmpeg's HTTP protocol issues `Range` requests, so ffprobe reads headers and the `moov` atom, and an input seek (`-ss` before `-i`) fetches only the bytes around the thumbnail frame.
- **Pros:** Transfers only the bytes actually needed (typically MBs). No temp disk sized to the upload. Same code path on AWS S3.
- **Cons:** Many small range requests to storage. Network errors surface as FFmpeg errors (handled by retries, TD-12).

### Option C: Shared volume between storage and worker
- Mount MinIO's data directory into the worker and read files directly.
- **Pros:** Local-file speed.
- **Cons:** Couples the worker to MinIO's internal on-disk format. Impossible on AWS S3, so dev and prod diverge.

**Recommendation:** **Option B** — range-based reads make metadata and thumbnail extraction cost proportional to what FFmpeg needs, not to the 10GB upload. The worker needs no large scratch disk and the same code runs against S3.

**Decision:** B

---

## TD-10: FFmpeg Integration Library and Binary Source

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must invoke `ffprobe` (JSON metadata) and `ffmpeg` (single-frame thumbnail). Verified on 2026-10-12: `fluent-ffmpeg` is deprecated on npm ("Package no longer supported").

**Options:**

### Option A: System ffmpeg/ffprobe from the image's package manager + thin typed wrapper over `child_process.spawn`
- Install `ffmpeg` via `apt` in the Debian-based dev image. A small service spawns `ffprobe -print_format json -show_format -show_streams` and `ffmpeg -ss <t> -i <url> -frames:v 1`, parsing output into typed results.
- **Pros:** No third-party wrapper dependency. Exact CLI flags are visible and testable. Distro-maintained binaries with HTTP/TLS support.
- **Cons:** Argument building and JSON parsing are hand-written (small). Binary version follows the base image's distro.

### Option B: `fluent-ffmpeg` + system binary
- Fluent builder API over the CLI.
- **Pros:** Familiar API, many examples.
- **Cons:** Deprecated and unmaintained (npm marks it "no longer supported"). Types come from a separate `@types` package. Adds a dependency that will not receive fixes.

### Option C: `ffmpeg-static` / `ffprobe-static` npm binaries + `spawn`
- Binaries downloaded by an npm postinstall step and pinned through the npm version.
- **Pros:** No Dockerfile change; binary version pinned in `package.json`.
- **Cons:** Postinstall network download (fragile in CI/offline), architecture-specific binaries inside a bind-mounted `node_modules`, and a separate `ffprobe-static` package with its own versioning.

**Recommendation:** **Option A** — the two commands needed are small and stable. A typed spawn wrapper over distro binaries avoids betting on a deprecated wrapper or postinstall binary downloads. It also places ffmpeg in the shared image that the tests use (TD-17).

**Decision:** A

**Revisions:**
- 2026-10-24 — Processing outputs pinned: persist `duration` (seconds), `width`, `height`, `size_bytes`, `container`, `video_codec` and `audio_codec` (nullable). Thumbnail: frame at 10% of duration (first frame when duration < 1s), JPEG, 1280px wide preserving aspect ratio. Rationale: AMB-3 resolved in `/plan-resolve 3` (core metadata set).

---

## TD-11: Video Status Model

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** A video is created as a draft when the upload starts, then goes through processing to ready or error. Two concerns are involved: the system-driven processing pipeline (uploading → processing → ready/failed) and the user-facing draft state. The model is persisted (enum column(s) in `CreateVideos`) and read by API, worker and tests.

**Options:**

### Option A: Single `status` enum — `draft → processing → ready | failed`
- `draft` means "pre-registered, upload in progress". `complete` moves it to `processing`, and the worker sets `ready` or `failed`.
- **Pros:** One column, literal match to the lifecycle "rascunho → processando → pronto/erro". Simple queries.
- **Cons:** "Draft" is overloaded: it means "upload not finished", while a draft (unpublished) video can also be fully processed. Any later publication state would need to be mixed into the same enum.

### Option B: Two orthogonal columns — `status` (`draft`) + `processing_status` (`awaiting_upload → processing → ready | failed`)
- `status` stays `draft` for every video in this phase (pre-registration). `processing_status` tracks the pipeline.
- **Pros:** Each column has one owner: the API owns `status` and the pipeline owns `processing_status`. No overloaded meaning, so later states extend `status` without touching the pipeline enum. The cycle rascunho → processando → pronto/erro is still fully observable in the DB.
- **Cons:** Two columns to keep consistent, and slightly more verbose queries and DTOs.

### Option C: Single enum including an explicit upload state — `uploading → processing → ready | failed`
- The draft is implicit (every video in this phase is unpublished); the enum tracks only the pipeline.
- **Pros:** One unambiguous pipeline column.
- **Cons:** Drops the explicit "rascunho" the capability names, so pre-registration-as-draft is not represented in the data.

**Recommendation:** **Option B** — separating the user-facing draft state from the system-driven processing pipeline avoids an overloaded "draft" value. It still records "rascunho" explicitly at pre-registration and the full processing cycle, at the cost of one extra column.

**Decision:** B

**Revisions:**
- 2026-10-24 — Draft pre-registration fields pinned: `initiate` takes `fileName`, `size`, `contentType` and an optional `title` (defaults to the file name without extension); the owning channel comes from the JWT. Phase 03 owns `status: draft` and the `processing_status` transitions up to `ready | failed`; draft → published and metadata editing belong to Phase 04. Rationale: AMB-2 resolved in `/plan-resolve 3` (title defaults to file name).

---

## TD-12: Processing Failure and Retry Policy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Processing can fail transiently (storage/network hiccup, worker restart) or permanently (corrupt or non-video file). The video must not stay in processing forever, and the outcome must be reflected in the DB. Depends on TD-01 and TD-11.

**Options:**

### Option A: Queue-level retries with exponential backoff, then mark failed with reason
- Jobs are enqueued with a bounded `attempts` (e.g. 3) and exponential backoff. The processor throws on any error so the queue retries. When attempts are exhausted, the worker sets the failed status and stores a failure reason. Job id = video id makes re-enqueue idempotent.
- **Pros:** Transient errors self-heal. Permanent errors end in a visible, queryable failed state. Uses the queue's native mechanics.
- **Cons:** Permanent errors (corrupt file) also burn all attempts before being marked failed. The final-failure hook must be implemented carefully (last attempt detection).

### Option B: No automatic retry — mark failed immediately
- Any error sets the failed status at once.
- **Pros:** Simplest; fastest feedback for corrupt files.
- **Cons:** Transient infra errors permanently fail healthy uploads; recovery needs a manual reprocess path.

### Option C: Retries + dead-letter queue for manual inspection
- As in A, but exhausted jobs move to a DLQ that an operator replays.
- **Pros:** Operational visibility and replay.
- **Cons:** Needs replay tooling and procedures with no consumer in this phase. The DB still has to be marked failed, so it duplicates A plus extra moving parts.

**Recommendation:** **Option A** — bounded retries with backoff distinguish transient from permanent failures cheaply, and the final state always lands in the DB with a reason. A DLQ adds operations surface without a consumer in this phase.

**Decision:** A

---

## TD-13: Abandoned and Incomplete Uploads

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Pre-registering the draft at upload start (TD-02/TD-11) means some uploads will never complete. That leaves draft rows plus incomplete multipart parts consuming storage (`project-plan.md` §4: plan storage growth and cost).

**Options:**

### Option A: Explicit abort endpoint + storage-level expiry of incomplete multipart uploads
- The client can abort (API calls `AbortMultipartUpload` and marks the video failed/aborted). Stale incomplete uploads are reclaimed by the storage itself: MinIO's stale-upload expiry (`api` config `stale_uploads_expiry`) locally, and an S3 lifecycle rule `AbortIncompleteMultipartUpload` in production. If a client later resumes an expired upload, the API marks the video failed when storage answers `NoSuchUpload`.
- **Pros:** No scheduler code. Storage cost is bounded by configuration. The client-driven cancel is explicit.
- **Cons:** Abandoned draft rows remain until touched again (`awaiting_upload` forever if never resumed).

### Option B: Scheduled reaper job (BullMQ repeatable job)
- A periodic job lists stale multipart uploads/drafts older than N hours, aborts them, and marks or deletes the rows.
- **Pros:** DB and storage are both reconciled automatically.
- **Cons:** More code, configuration and tests (time-based behavior). Repeatable-job scheduling semantics to get right.

### Option C: Abort endpoint only
- Only explicit client aborts clean up.
- **Pros:** Minimal.
- **Cons:** Crashed or closed clients leave parts in storage indefinitely, with unbounded storage growth.

**Recommendation:** **Option A** — storage-native expiry bounds cost without scheduler code. The explicit abort plus lazy `NoSuchUpload` detection keeps the DB honest on every path the API sees. A reaper job can be added later if stale drafts become a product concern.

**Decision:** A

---

## TD-14: Unique Public Video Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short URL id that never conflicts (`project-plan.md` §4: "URL curta e única"). Existing entities use UUID primary keys. The `channels` module already uses a unique-constraint + retry pattern for nicknames (`ChannelsService`, pg `23505`).

**Options:**

### Option A: Expose the UUID primary key in the URL
- `/videos/{uuid}`.
- **Pros:** Zero extra code; globally unique.
- **Cons:** Long (36 chars), so not a short URL as required. Couples the public URL to the internal key.

### Option B: Separate short random id via `crypto.randomBytes` (base64url), UNIQUE + retry
- 11-char base64url id from 8 random bytes (64 bits), stored in a `UNIQUE` column. On a `23505` collision, regenerate (same pattern as `ChannelsService`).
- **Pros:** Short, YouTube-like, unguessable (no enumeration). No dependency (Node `crypto`). The DB guarantees uniqueness; retries make collisions harmless.
- **Cons:** Small retry loop to write and test.

### Option C: `nanoid`
- Library-generated short ids.
- **Pros:** Well-known API, configurable alphabet and length.
- **Cons:** Current majors are ESM-only (`nanoid@6`: `"type": "module"`, `engines` `^22 || ^24 || >=26`, which excludes the image's Node 25). Friction with the CommonJS build and ts-jest. Uniqueness still needs the DB constraint.

### Option D: Sqids encoding of a sequential id
- Encode an auto-increment integer into a short string.
- **Pros:** Short and deterministic; no collision retry.
- **Cons:** Predictable/enumerable (reveals volume, enables scraping ids). Needs an extra sequence column alongside the UUID PK.

**Recommendation:** **Option B** — Node's `crypto` gives short, unguessable ids with no dependency, and the existing unique-constraint + retry pattern from `channels` already guarantees no conflicts. nanoid's ESM-only/engines constraints and Sqids' enumerability are avoidable costs.

**Decision:** B

---

## TD-15: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, and the user must be able to download it. The architecture shows the frontend streaming from Object Storage. The delivery mechanism is a client contract (player `src`, download link). Depends on TD-06 and TD-16.

**Options:**

### Option A: API returns short-lived presigned GET URLs (JSON)
- Authorized endpoints return `{ url, expiresAt }`. Stream URLs are plain presigned GETs (storage answers `Range` with `206 Partial Content`). Download URLs add `ResponseContentDisposition: attachment; filename=...`.
- **Pros:** The API is never in the byte path. Works with Bearer-authenticated APIs (the client fetches the URL with its token, then sets `<video src>`). Seeking and range requests are handled natively by storage, and the same mechanism serves both stream and download.
- **Cons:** URLs expire, so clients re-request after expiry. Two calls (get URL, then fetch media).

### Option B: API responds `302` redirect to a presigned GET URL
- `GET /videos/:id/stream` redirects to storage.
- **Pros:** A single URL usable directly as a `<video src>`.
- **Cons:** The redirecting endpoint must be callable without custom headers (browsers do not send `Authorization` on media requests), which only works if the endpoint is public or cookie-authenticated. That conflicts with the current Bearer-token API.

### Option C: API proxies bytes with `Range` support
- The API reads from storage with a `Range` and pipes a `206` `StreamableFile`.
- **Pros:** Full control over the response (auth, headers, logging).
- **Cons:** All playback bytes flow through the API — the same throughput problem TD-02 avoids for upload.

### Option D: HLS (transcode to segments + playlist)
- The worker transcodes into HLS renditions; the client plays the `.m3u8`.
- **Pros:** Adaptive bitrate; CDN-friendly segments.
- **Cons:** Heavy transcoding (CPU, time, storage for renditions) that `project-plan.md` does not require for this phase. Download still needs the original.

**Recommendation:** **Option A** — presigned GET URLs give range-based streaming (`206`) and attachment downloads straight from storage, with the API only authorizing. It fits the Bearer-token API without making media endpoints public. HLS is out of proportion to this phase's requirements.

**Decision:** A

---

## TD-16: Access Policy for Stream and Download in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The global `JwtAuthGuard` protects everything unless `@Public()` is applied. In this phase every video is a draft (TD-11): publication and visibility belong to later phases, and anonymous viewing is planned for the watch page. Delivery must not expose drafts beyond what the phase requires. Depends on TD-11 and TD-15.

**Options:**

### Option A: Owner-only (JWT + channel ownership)
- Only the authenticated owner of the video's channel can obtain stream/download URLs; others get `404` (no existence leak) or `403`.
- **Pros:** Never exposes unpublished drafts. Reuses the existing guard. Anonymous access can be opened later by the phase that introduces publication.
- **Cons:** No anonymous playback yet, by design.

### Option B: Public for any `ready` video, keyed by the unguessable public id
- `@Public()` delivery endpoints. Possession of the id grants access.
- **Pros:** Anonymous playback works immediately.
- **Cons:** Exposes drafts that the owner never published. Pre-empts the visibility rules of later phases.

### Option C: Any authenticated user
- JWT required, no ownership check.
- **Pros:** Simple.
- **Cons:** Still exposes drafts to every account, and matches no stated requirement.

**Recommendation:** **Option A** — owner-only access is the only policy consistent with "every video is a draft" in this phase. It reuses the existing JWT guard and leaves anonymous access to the phase that introduces publication and visibility.

**Decision:** A

---

## TD-17: Test Strategy for Storage, Queue and Worker

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Project rules require integration/e2e tests against real I/O (`nestjs-project/CLAUDE.md` → Test Type Selection), run in-band inside the `nestjs-api` container. New infra (storage, Redis, worker) must be exercised for real without test jobs being consumed by the running `video-worker` container or polluting dev data.

**Options:**

### Option A: Real Compose services with test-scoped namespaces; processor booted in-process
- Integration/e2e tests use the Compose storage and Redis. Isolation comes from a test bucket and a test BullMQ `prefix`/queue name set via env, so the `video-worker` container never sees test jobs. The processor runs inside the test module. Fixture videos are generated at runtime with `ffmpeg -f lavfi -i testsrc` (ffmpeg in the shared image, TD-08/TD-10), so no binaries are committed.
- **Pros:** Exercises the real S3 API, Redis and FFmpeg as the rules require. Deterministic (no cross-container races). No new tooling.
- **Cons:** Tests depend on the Compose services being up. The test env needs extra keys (bucket/prefix overrides).

### Option B: Testcontainers (ephemeral storage/Redis per suite)
- Each suite starts its own containers.
- **Pros:** Strong isolation per suite.
- **Cons:** Requires Docker-in-Docker or a socket mount into `nestjs-api`; slow startup. Diverges from the project's shared-Compose testing model.

### Option C: Mocked S3/queue clients in integration tests (`aws-sdk-client-mock`, `ioredis-mock`)
- Replace I/O with in-memory fakes.
- **Pros:** Fast and infra-free.
- **Cons:** Violates the project's integration-test definition (real I/O required). Hides presign/multipart/range behavior, which is exactly where this phase's risk lies.

**Recommendation:** **Option A** — real Compose services with namespaced bucket/queue isolation and an in-process processor test what actually breaks (multipart, presign, range reads, FFmpeg) and follow the project's existing testing model. Mocks would hide this phase's main risks.

**Decision:** A

**Revisions:**
- 2026-10-24 — Contract re-sync is a Phase 03 deliverable: every video endpoint change regenerates the backend `openapi.json` and runs the repo-root sync script, which regenerates `next-frontend/openapi.json` and `types.gen.ts` (per next-frontend-openapi-typing/TD-02, TD-03), so the FE freshness check stays green; no FE source changes (video UI stays deferred). Rationale: IC-1 resolved in `/plan-resolve 3` (re-sync as deliverable).

---

## TD-18: Accepted Input Formats, Validation and Transcoding Stance

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Processamento automático do vídeo após upload (extração de duração e metadados); Reprodução via streaming (sem necessidade de download completo)

**Context:** Streaming plays the stored object directly in the browser through presigned GETs (TD-15), so a `ready` video only streams if its container and codecs are browser-playable. Per MDN (checked 2026-10-24), MP4 and WebM are supported in all browsers. In MP4, H.264, VP9 and AV1 are supported (AV1 needs specific hardware in Safari), and so are AAC, MP3 and Opus. In WebM, VP8, VP9, AV1, Opus and Vorbis are supported. QuickTime (MOV) is not supported outside older Safari, HEVC depends on OS/hardware, and MKV/AVI are not listed. Because parts are `PUT` straight to storage (TD-02), the API never sees the bytes. Initiate-time checks therefore cover only client-declared metadata (MIME, extension, size per TD-03). The worker's `ffprobe` (TD-09/TD-10) is the only check against the actual content. The allowlist is a client contract: the initiate DTO, its error response, and a future frontend file-picker `accept` must agree on it. Depends on TD-03, TD-09, TD-10, TD-11, TD-12, TD-15.

**Options:**

### Option A: Browser-playable allowlist, stored as uploaded, no transcoding
- `initiate` accepts only declared `video/mp4` (`.mp4`/`.m4v`) and `video/webm` (`.webm`). The worker's `ffprobe` must then confirm an MP4- or WebM-family container, a video stream in {H.264, VP8, VP9, AV1} paired with its container, and audio in {AAC, MP3, Opus, Vorbis} or none. Any mismatch, or non-video content, ends as failed with an `unsupported_format` reason that does not consume retries (TD-12).
- **Pros:** Every `ready` video streams in every browser. Processing stays range-read-only (TD-09 B), so cost does not grow with file size. No CPU-heavy encoding and no second stored rendition. The contract is small and testable.
- **Cons:** Rejects common sources: iPhone default recordings (HEVC in MOV), MKV, AVI. `ffprobe` reports MP4/MOV as one family (`mov,mp4,m4a,3gp,3g2,mj2`) and MKV/WebM as another (`matroska,webm`), so the check must look at codecs, not only `format_name`.

### Option B: Broad allowlist + conditional normalization (remux or transcode to MP4 H.264/AAC)
- `initiate` also accepts MOV, MKV and AVI. The worker inspects each file. If the codecs are already playable, it remuxes into MP4 (`-c copy`). Otherwise it transcodes to H.264/AAC MP4 and stores the result as a separate playback rendition next to the original.
- **Pros:** Accepts what users actually record. Every `ready` video still streams.
- **Cons:** Normalization reads and writes the whole object (up to 10GB), which overrides TD-09 B for those jobs and needs scratch disk or streamed multipart output. A software transcode of a long 10GB video can take hours of worker CPU. It adds a derived object to TD-05's layout and makes TD-15 choose rendition vs original for stream and download. Job duration also needs revisiting in TD-12. None of this is required by `project-plan.md`, which limits processing to extraction.

### Option C: Accept any video `ffprobe` recognizes, store as uploaded, best-effort playback
- `initiate` accepts any `video/*` MIME. The worker only rejects content that `ffprobe` cannot parse as video, and any parseable file becomes `ready`.
- **Pros:** Simplest validation and widest acceptance, with no encoding cost.
- **Cons:** `ready` stops meaning "streamable": MKV, HEVC or AVI uploads can reach `ready` and then fail to play in some or all browsers. That silently breaks the streaming capability and moves the problem to a future frontend.

**Recommendation:** **Option A** — it is the only option where every `ready` video is guaranteed to stream and processing cost stays independent of the 10GB size. It keeps TD-09's range-read worker and TD-15's direct-from-storage delivery intact. Rejecting HEVC/MOV is the explicit cost. It is reversible: a later phase can add Option B's normalization as a new TD without changing the upload contract shape.

**Decision:** A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | A (BullMQ + Redis, `@nestjs/bullmq@11.0.5`) | A |
| TD-02 | Cross-layer | Large-file Upload Protocol (10GB) | A (S3 multipart with presigned part URLs) | A |
| TD-03 | Backend | Part Sizing and Presigned-URL Issuance | A (fixed server part size + on-demand presign batches) | A |
| TD-04 | Repo-wide | Local S3-compatible Storage Server Image | A (`pgsty/minio`, pinned tag) | A |
| TD-05 | Backend | Bucket and Object-key Layout | A (single private bucket, per-video prefix) | A |
| TD-06 | Backend | Presigned-URL Host Topology | A (internal client + public signing client) | A |
| TD-07 | Backend | Processing Trigger | A (API `complete` enqueues the job) | A |
| TD-08 | Repo-wide | Video Worker Runtime Topology | A (separate service, same codebase/image, standalone Nest context) | A |
| TD-09 | Backend | Media Access Strategy for ffprobe/FFmpeg | B (presigned GET with HTTP range reads) | B |
| TD-10 | Backend | FFmpeg Integration Library and Binary Source | A (distro ffmpeg + typed `spawn` wrapper) | A |
| TD-11 | Backend | Video Status Model | B (`status` draft + `processing_status` pipeline) | B |
| TD-12 | Backend | Processing Failure and Retry Policy | A (bounded retries + backoff, then failed with reason) | A |
| TD-13 | Backend | Abandoned and Incomplete Uploads | A (abort endpoint + storage-level expiry) | A |
| TD-14 | Backend | Unique Public Video Identifier | B (`crypto.randomBytes` base64url, UNIQUE + retry) | B |
| TD-15 | Cross-layer | Streaming and Download Delivery | A (presigned GET URLs returned as JSON) | A |
| TD-16 | Backend | Access Policy for Stream and Download | A (owner-only) | A |
| TD-17 | Repo-wide | Test Strategy for Storage, Queue and Worker | A (real Compose services, namespaced, in-process processor) | A |
| TD-18 | Cross-layer | Accepted Input Formats, Validation and Transcoding Stance | A (browser-playable MP4/WebM allowlist, ffprobe-verified, no transcoding) | A |
