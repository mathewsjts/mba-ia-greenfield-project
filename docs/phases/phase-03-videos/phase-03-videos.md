---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T17:24:33-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-24T17:24:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T17:21:42-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-10T15:30:11-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-10T15:30:11-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-10-10T15:30:11-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-10-10T15:30:11-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for "Upload e Processamento de Vídeos": a "Serviço de armazenamento de arquivos (vídeos e thumbnails)" and a "Serviço de processamento em segundo plano (filas)" running as real Compose services. The phase covers "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" with "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", a "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário". Done means: upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Infra: storage S3 (MinIO), Redis e FFmpeg no ambiente Docker

**Description:** Sobe a infraestrutura real exigida pela fase (object storage, broker da fila e binários FFmpeg) no `compose.yaml`/imagem de dev, antes de qualquer código que dependa dela.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `minio`. Imagem `pgsty/minio` com tag de release fixa, portas `9000` (S3) e `9001` (console), volume nomeado, credenciais vindas do `.env` e healthcheck HTTP em `/minio/health/ready` (per `phase-03-videos/TD-04`)
2. Adicionar o serviço one-shot `minio-init` (imagem `minio/mc` fixada), com `depends_on: minio: condition: service_healthy`. Ele cria idempotentemente o bucket da aplicação e o bucket de testes, aplica CORS expondo o header `ETag` e aplica a regra de lifecycle `AbortIncompleteMultipartUpload` no prefixo `videos/` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, `phase-03-videos/TD-13`, `phase-03-videos/TD-17`)
3. Adicionar o serviço `redis` com imagem fixa, `command: redis-server --maxmemory-policy noeviction --appendonly yes`, volume nomeado e healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`, library-refs `bullmq`)
4. Atualizar `nestjs-api.depends_on` para aguardar `redis` (healthy), `minio` (healthy) e `minio-init` (`service_completed_successfully`). Toda referência entre containers usa o nome do serviço Compose (`minio`, `redis`), nunca `localhost` (per CLAUDE.md § Docker Networking)
5. Instalar `ffmpeg` via `apt` em `nestjs-project/Dockerfile.dev`, junto com os pacotes já instalados, para que `ffprobe`/`ffmpeg` existam na imagem compartilhada por API, worker e testes (per `phase-03-videos/TD-10`, `phase-03-videos/TD-17`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio`, `redis`, `db` e `mailpit` com status `running`/`healthy`, e `minio-init` sai com código `0`
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction`, e `CONFIG GET appendonly` retorna `yes`
- O bucket da aplicação e o bucket de testes existem; a regra de lifecycle de multipart incompleto em `videos/` e o CORS com `ETag` exposto aparecem na inspeção via `mc`
- Rodar `minio-init` uma segunda vez também termina com código `0` (provisionamento idempotente)
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` saem com código `0`

---

### SI-03.2 — Configuração: variáveis de storage, fila e upload

**Description:** Define o conjunto canônico de variáveis de ambiente da fase, validado no boot e exposto por factories `registerAs` tipadas. É contrato entre schema Joi, `.env.example` e Compose.

**Technical actions:**

1. Adicionar ao schema Joi em `src/config/env.validation.ts` as chaves `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `UPLOAD_PART_SIZE_BYTES` (default `67108864`, mínimo `5242880`), `UPLOAD_PART_URL_EXPIRES_SECONDS` (default `900`) e `MEDIA_URL_EXPIRES_SECONDS` (default `3600`) (per `phase-01-configuracao-base/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-06`, `phase-03-videos/TD-15`)
2. Criar `src/config/storage.config.ts` (`registerAs('storage')`: endpoint interno, endpoint público, região, credenciais, bucket) e `src/config/queue.config.ts` (`registerAs('queue')`: host e porta do Redis), seguindo o padrão namespaced (per `phase-01-configuracao-base/TD-03`)
3. Criar `src/config/videos.config.ts` (`registerAs('videos')`: `partSizeBytes`, `partUrlExpiresSeconds`, `mediaUrlExpiresSeconds`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-15`)
4. Registrar as três factories em `ConfigModule.forRoot({ load: [...] })` no `AppModule`
5. Atualizar `.env.example` e `.env` com valores de dev: `STORAGE_ENDPOINT=http://minio:9000`, `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`, bucket da aplicação, e as mesmas credenciais usadas pelo serviço `minio` (per CLAUDE.md § Docker Networking, `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: chaves obrigatórias ausentes rejeitam o boot; `UPLOAD_PART_SIZE_BYTES` abaixo de 5 MiB é rejeitado; defaults aplicados | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- O boot da aplicação sem `STORAGE_BUCKET` (ou qualquer outra chave obrigatória nova) falha na validação de env, com mensagem que cita a chave ausente
- `UPLOAD_PART_SIZE_BYTES=1048576` é rejeitado no boot (abaixo do mínimo S3 de 5 MiB por parte)
- Sem `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_PART_URL_EXPIRES_SECONDS` e `MEDIA_URL_EXPIRES_SECONDS`, a configuração resolvida usa `67108864`, `900` e `3600`
- `.env.example` lista todas as chaves novas, com hosts de container (`minio`, `redis`) e só o endpoint público apontando para `localhost`

---

### SI-03.3 — StorageModule: clientes S3 interno/público e StorageService

**Description:** Encapsula todo acesso ao object storage num módulo próprio (multipart, presign, head, put/delete). Nenhum outro módulo fala com o SDK S3 diretamente.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@^3.1156.0` e `@aws-sdk/s3-request-presigner@^3.1156.0` na mesma versão (per `phase-03-videos/TD-02`, library-refs `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.module.ts`, que provê dois `S3Client` por tokens distintos. O interno usa `STORAGE_ENDPOINT` e serve para todas as operações e para assinar URLs do worker. O público usa `STORAGE_PUBLIC_ENDPOINT` e só assina URLs entregues a clientes. Ambos com `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` e `responseChecksumValidation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-06`, library-refs `@aws-sdk/client-s3`)
3. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `presignUploadPart`, `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `putObject`, `deleteObject` e `presignGetObject(key, { audience: 'public' | 'internal', contentDisposition? })`, usando o bucket de `storage.config` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-09`, `phase-03-videos/TD-15`)
4. Mapear erros do SDK para erros tipados do módulo (`StorageUploadNotFoundError` para `NoSuchUpload`, `StorageInvalidPartsError` para `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`, `StorageObjectNotFoundError` para `NotFound`/`NoSuchKey`), para os consumidores não dependerem do SDK
5. Criar `src/storage/storage-keys.ts` com `originalKey(videoId)` → `videos/{id}/original` e `thumbnailKey(videoId)` → `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: multipart completo contra o MinIO real (create → `PUT` via URL presignada → list → complete → head), abort, mapeamento de `NoSuchUpload`, GET presignado com `Range` retornando `206` e com `Content-Disposition: attachment` (per `phase-03-videos/TD-17`) | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com config de teste | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO e buckets precisam existir), SI-03.2 (config `storage`)

**Acceptance criteria:**

- Um `PUT` HTTP simples (sem headers de checksum) numa URL de `UploadPart` presignada pelo cliente público retorna `200` com header `ETag`
- `completeMultipartUpload` com os `ETag`s retornados produz o objeto `videos/{id}/original`, cujo `ContentLength` no `headObject` é igual à soma das partes
- URLs entregues a clientes têm o host de `STORAGE_PUBLIC_ENDPOINT`; URLs do worker têm o host `minio`
- `GET` numa URL presignada com `Range: bytes=0-1023` retorna `206 Partial Content` com 1024 bytes
- `presignGetObject` com `contentDisposition` produz uma resposta com `Content-Disposition: attachment; filename="..."`
- `listParts`/`completeMultipartUpload` sobre um `UploadId` abortado lançam `StorageUploadNotFoundError`

---

### SI-03.4 — Infra: QueueModule (BullMQ + Redis)

**Description:** Configura a conexão BullMQ compartilhada e as constantes da fila `video-processing`, usadas pelo produtor (API) e pelo consumidor (worker).

**Technical actions:**

1. Instalar `@nestjs/bullmq@^11.0.5` e `bullmq@^6.4.2`. A linha 12.x do `@nestjs/bullmq` é ESM-only e não serve ao build CommonJS (per `phase-03-videos/TD-01`, library-refs `@nestjs/bullmq`)
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })`, conexão `{ host, port, maxRetriesPerRequest: null }` vinda de `queue.config` (per `phase-03-videos/TD-01`, `phase-01-configuracao-base/TD-01`, library-refs `bullmq`)
3. Criar `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` e `PROCESS_VIDEO_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` (per `### Events/Messages`, `phase-03-videos/TD-12`)
4. Importar `QueueModule` no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação do módulo com config de teste | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 (serviço `redis`), SI-03.2 (config `queue`)

**Acceptance criteria:**

- Com o `redis` no ar, a API sobe sem erros de conexão BullMQ no log de boot
- `PROCESS_VIDEO_JOB_OPTIONS` declara exatamente `attempts: 3` e backoff exponencial com `delay: 5000`

---

### SI-03.5 — Entidade Video, migração CreateVideos e gerador de public id

**Description:** Materializa o modelo de dados de `videos`: enums de status, metadados de processamento e `public_id` único. É a base de todos os endpoints e do worker.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com exatamente as colunas, tipos e constraints de `### Data Model → Video`: enums `videos_status_enum` e `videos_processing_status_enum`, `size_bytes` `bigint` com transformer para `number`, e relação `ManyToOne` → `Channel` via `channel_id` com `onDelete: 'CASCADE'` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-14`)
2. Adicionar `Channel.videos` (`OneToMany`) em `src/channels/entities/channel.entity.ts`
3. Gerar a migração `src/database/migrations/<timestamp>-CreateVideos.ts` via `npm run migration:generate`, revisando que crie os dois enums, a tabela, o unique em `public_id`, o índice em `channel_id` e a FK com `ON DELETE CASCADE`, e que o `down` desfaça tudo
4. Criar `src/videos/public-id.ts` com `generatePublicId()` → `crypto.randomBytes(8).toString('base64url')` (11 chars) e o helper `isPublicIdUniqueViolation(err)`, no mesmo padrão `23505` + coluna usado em `channels.service.ts` (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`status = draft`, `processing_status = awaiting_upload`), unique de `public_id`, FK + cascade ao remover o canal, `size_bytes` > 2^31 lido como `number`, colunas de metadados nulas por padrão | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 chars, alfabeto base64url, valores distintos entre chamadas | `src/videos/public-id.spec.ts` |
| Migrações | Integration: `CreateVideos` aplica e reverte limpo | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com os enums `videos_status_enum` (`draft`) e `videos_processing_status_enum` (`awaiting_upload`, `processing`, `ready`, `failed`), e `npm run migration:revert` remove tabela e enums
- Inserir um vídeo só com os campos obrigatórios persiste `status = 'draft'` e `processing_status = 'awaiting_upload'`
- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique (`23505`)
- Remover um canal remove em cascata os seus vídeos
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`

---

### SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated (cria no canal do próprio caller)

**Description:** Ao iniciar o upload, cria o vídeo como rascunho no canal do usuário e abre o multipart upload no storage. Devolve `partSize`/`partCount` sem que nenhum byte do arquivo passe pela API.

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` (lookup do canal do caller; o domínio de canais continua dono da query)
2. Criar `src/videos/exceptions/video.exceptions.ts` com uma subclasse de `DomainException` por código do `### Error Catalog` (`VIDEO_TOO_LARGE`, `UNSUPPORTED_VIDEO_FORMAT`, `VIDEO_NOT_FOUND`, `VIDEO_NOT_AWAITING_UPLOAD`, `INVALID_PART_NUMBER`, `INVALID_UPLOAD_PARTS`, `UPLOAD_EXPIRED`, `UPLOAD_SIZE_MISMATCH`, `VIDEO_NOT_READY`) (per `phase-02-auth/TD-07`)
3. Criar `src/videos/dto/initiate-upload.dto.ts` (`fileName`, `size`, `contentType`, `title?` com as regras de `#### Validation Rules — videos`) e os DTOs de resposta `VideoResponseDto` e `InitiateUploadResponseDto` em `src/videos/dto/` (per `phase-02-auth/TD-06`, `phase-03-videos/TD-11`)
4. Criar `src/videos/videos.service.ts` → `initiateUpload(userId, dto)`. Passos: rejeita `size` > 10737418240 com `VIDEO_TOO_LARGE`; rejeita formato fora da allowlist/extensão incoerente com `UNSUPPORTED_VIDEO_FORMAT`; calcula `partCount = ceil(size / partSize)`; gera o `id` (uuid) e chama `createMultipartUpload` em `originalKey(id)` com `ContentType`; persiste o rascunho (`public_id` com retry em violação unique, `title` default = `fileName` sem extensão truncado a 100, `upload_id`, `part_size`). Se a persistência falhar, aborta o multipart (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-11`, `phase-03-videos/TD-14`, `phase-03-videos/TD-18`)
5. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`, `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`) com `POST /videos` → `201`, os decoradores `@ApiOperation`/`@ApiResponse` por status com `ApiErrorEnvelope`, e `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`) registrado no `AppModule` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: limite de 10 GiB, pares contentType/extensão, título default e truncamento, cálculo de `partCount`, abort do multipart quando a persistência falha (repo e storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB + MinIO reais — rascunho persistido com `upload_id` e `part_size`, multipart existente no bucket de testes (per `phase-03-videos/TD-17`) | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário e `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (StorageService), SI-03.5 (entidade Video)

**Acceptance criteria:**

- `POST /videos` com `{ fileName: "aula.mp4", size: 10737418240, contentType: "video/mp4" }` retorna `201` com `processingStatus: "awaiting_upload"`, `status: "draft"`, `title: "aula"`, `upload.partSize: 67108864` e `upload.partCount: 160`
- `POST /videos` com `size: 10737418241` retorna `413` com `error: "VIDEO_TOO_LARGE"`, e nenhum multipart upload é criado no storage
- `POST /videos` com `contentType: "video/quicktime"`, ou com `fileName: "clip.webm"` + `contentType: "video/mp4"`, retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
- `POST /videos` com campo desconhecido ou `size` não inteiro retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- A resposta expõe `publicId` (11 chars base64url) e nunca o `id` interno; dois uploads consecutivos recebem `publicId`s distintos
- Após o `201`, a linha em `videos` pertence ao canal do caller e o `upload_id` persistido corresponde a um multipart aberto em `videos/{id}/original`

---

### SI-03.7 — Endpoints de upload: URLs de partes, listagem para retomada e abort

**Route:** POST /videos/:publicId/upload/part-urls, GET /videos/:publicId/upload/parts, DELETE /videos/:publicId/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (non-owner → `404 VIDEO_NOT_FOUND`)

**Description:** Entrega URLs presignadas de `UploadPart` sob demanda, lista as partes já armazenadas para retomar uploads interrompidos e permite cancelar o upload, mantendo o banco coerente quando o multipart expira.

**Technical actions:**

1. Adicionar `VideosService.findOwnedOrFail(publicId, userId)`, que lança `VIDEO_NOT_FOUND` para vídeo inexistente ou de outro canal, e o guard de estado `assertAwaitingUpload(video)`, que lança `VIDEO_NOT_AWAITING_UPLOAD` (per `phase-03-videos/TD-16`)
2. Adicionar `VideosService.requestPartUrls(publicId, userId, partNumbers)`. Rejeita número > `partCount` com `INVALID_PART_NUMBER` e presigna cada parte no cliente público com `UPLOAD_PART_URL_EXPIRES_SECONDS`. Retorna `{ parts, expiresAt }` em ordem ascendente (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
3. Adicionar `VideosService.listUploadedParts` (`listParts` → `{ partNumber, etag, size }[]`) e `VideosService.abortUpload` (`abortMultipartUpload`, depois `processing_status = failed`, `failure_reason = upload_aborted`, `upload_id = null`; `NoSuchUpload` é tratado como já abortado). Em `requestPartUrls`/`listUploadedParts`, um `StorageUploadNotFoundError` marca `failed` (`upload_expired`) e lança `UPLOAD_EXPIRED` (per `phase-03-videos/TD-13`)
4. Criar `src/videos/dto/request-part-urls.dto.ts` (`partNumbers`: 1–100 inteiros únicos ≥ 1) e os DTOs de resposta `PartUrlsResponseDto`/`UploadedPartsResponseDto`
5. Adicionar ao `VideosController` as três rotas com os status de `### API Contracts` (`200`, `200`, `204`) e `@ApiResponse` por código de erro (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (part URLs / list / abort) | Unit: ownership → 404, guard de estado → 409, `partNumber` fora do range → 400, `NoSuchUpload` → `failed` + 410, abort idempotente | `src/videos/videos.service.spec.ts` |
| `VideosService` (part URLs / list / abort) | Integration: DB + MinIO reais — URL presignada aceita `PUT`, `listParts` reflete as partes enviadas, abort remove o multipart e marca `upload_aborted` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (VideosModule, rascunho com `upload_id`)

**Acceptance criteria:**

- `POST /videos/:publicId/upload/part-urls` com `{ partNumbers: [1, 2] }` retorna `200` com duas entradas `{ partNumber, url }` e `expiresAt` cerca de 900 s no futuro; um `PUT` dos bytes de cada parte na `url` retorna `200` com `ETag`
- `POST .../part-urls` com `partNumbers: [161]` num vídeo de `partCount: 160` retorna `400` com `error: "INVALID_PART_NUMBER"`
- `GET /videos/:publicId/upload/parts` depois de enviar as partes 1 e 2 retorna `200` com essas duas partes, cada uma com `etag` e `size`
- `DELETE /videos/:publicId/upload` retorna `204`, e o vídeo passa a `processingStatus: "failed"` com `failureReason: "upload_aborted"`; um novo `POST .../part-urls` retorna `409` com `error: "VIDEO_NOT_AWAITING_UPLOAD"`
- Depois de o multipart ser abortado direto no storage, `GET .../upload/parts` retorna `410` com `error: "UPLOAD_EXPIRED"`, e o vídeo fica `failed` com `failureReason: "upload_expired"`
- Qualquer uma das três rotas chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, idêntico ao de um `publicId` inexistente

---

### SI-03.8 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (non-owner → `404 VIDEO_NOT_FOUND`)

**Description:** Fecha o multipart, confere o tamanho armazenado contra o declarado, move o vídeo para `processing` e publica o job `process-video`. É o gatilho do processamento automático.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: 1–10000 itens `{ partNumber, etag }`, validação aninhada com `@ValidateNested` + `@Type`)
2. Registrar a fila em `VideosModule` com `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` e injetar `@InjectQueue(VIDEO_PROCESSING_QUEUE)` no `VideosService`. A API só produz; nenhum processor é registrado aqui (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
3. Adicionar `VideosService.completeUpload(publicId, userId, parts)`:
   - Exige `parts` cobrindo exatamente `1..partCount`, senão `INVALID_UPLOAD_PARTS`.
   - Chama `completeMultipartUpload`, mapeando `StorageInvalidPartsError` → `INVALID_UPLOAD_PARTS`.
   - Em `StorageUploadNotFoundError`, aplica a retry safety: segue se `videos/{id}/original` existir com o tamanho declarado; senão marca `failed` (`upload_expired`) e lança `UPLOAD_EXPIRED`.
   - Compara `headObject` com `size_bytes`. Na divergência, apaga o objeto, marca `failed` (`size_mismatch`) e lança `UPLOAD_SIZE_MISMATCH`.

   (per `phase-03-videos/TD-03`, `phase-03-videos/TD-07`, `phase-03-videos/TD-13`)
4. No mesmo método, depois da verificação: `processing_status = processing`, `upload_id = null`, depois `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id })` (per `### Events/Messages`, `phase-03-videos/TD-07`, `phase-03-videos/TD-12`)
5. Adicionar a rota ao `VideosController` → `202` com `VideoResponseDto` e `@ApiResponse` para `400`/`404`/`409`/`410`/`422` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: cobertura de partes, mapeamento de erros de storage, retry safety (`NoSuchUpload` + objeto existente segue; sem objeto → 410), divergência de tamanho → apaga + 422, ordem DB-update-antes-do-enqueue | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB + MinIO + Redis reais — upload pequeno completo, job `process-video` na fila `video-processing` com `jobId = video.id` e `data = { videoId }`; segunda chamada não cria job duplicado (per `phase-03-videos/TD-17`) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (QueueModule), SI-03.7 (fluxo de partes)

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` com os `{ partNumber, etag }` de todas as partes enviadas retorna `202` com `processingStatus: "processing"`, e existe exatamente um job `process-video` com `jobId` igual ao id interno do vídeo e payload `{ videoId }`
- `POST .../complete` faltando uma parte de `1..partCount` retorna `400` com `error: "INVALID_UPLOAD_PARTS"`, e o vídeo continua `awaiting_upload`
- `POST .../complete` com `etag` incorreto para uma parte retorna `400` com `error: "INVALID_UPLOAD_PARTS"`
- Quando os bytes enviados não somam o `size` declarado, `POST .../complete` retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`, o objeto `videos/{id}/original` não existe mais e o vídeo fica `failed` com `failureReason: "size_mismatch"`
- Um segundo `POST .../complete` num vídeo já em `processing` retorna `409` com `error: "VIDEO_NOT_AWAITING_UPLOAD"`, e a fila continua com um único job para o vídeo
- Depois de o multipart expirar sem objeto completo, `POST .../complete` retorna `410` com `error: "UPLOAD_EXPIRED"`

---

### SI-03.9 — MediaModule: wrapper tipado de ffprobe/ffmpeg e allowlist de formatos

**Description:** Isola a integração com os binários FFmpeg (probe de metadados, extração de frame) e a regra de formatos aceitos, para o worker consumir sem conhecer flags de CLI.

**Technical actions:**

1. Criar `src/media/media-probe.service.ts` → `probe(inputUrl)`. Executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.spawn` (sem shell), com timeout, e converte a saída em `ProbeResult` tipado (`duration`, `width`, `height`, `formatName`, `videoCodec`, `audioCodec`). Erro de parse ou ausência de stream de vídeo vira `MediaUnreadableError` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-09`)
2. Criar `src/media/media-format.ts` → `classifyFormat(probe)`, função pura que aplica a allowlist de `phase-03-videos/TD-18`. Container família MP4 (`mov,mp4,…`) só com vídeo `h264`/`vp9`/`av1`; família WebM (`matroska,webm`) só com `vp8`/`vp9`/`av1`; áudio `aac`/`mp3`/`opus`/`vorbis` ou ausente. Retorna `{ supported: true, container: 'mp4' | 'webm' }` ou `{ supported: false }`
3. Criar `src/media/media-thumbnail.service.ts` → `extractFrame(inputUrl, atSeconds)`. Roda `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=1280:-2 -f image2 -c:v mjpeg pipe:1` (input seek antes de `-i`, para ler só o trecho necessário) e retorna um `Buffer` JPEG. Também expõe `thumbnailOffset(duration)` → `duration * 0.1`, ou `0` quando `duration < 1` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-09`)
4. Criar `src/media/media.module.ts`, que exporta os dois serviços
5. Gerar com `ffmpeg -f lavfi` e commitar fixtures pequenas (< 200 KB cada) em `test/fixtures/media/`: `h264-aac.mp4`, `vp9-opus.webm`, `h264-noaudio.mp4`, `hevc.mp4` (fora da allowlist), `short-0_5s.mp4` e `not-a-video.mp4` (bytes aleatórios)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `classifyFormat` | Unit: cada combinação aceita e cada rejeição (HEVC, VP8 em MP4, H.264 em WebM, áudio fora da lista), áudio ausente aceito | `src/media/media-format.spec.ts` |
| `thumbnailOffset` | Unit: 10% da duração; `0` abaixo de 1 s | `src/media/media-thumbnail.service.spec.ts` |
| `MediaProbeService` | Integration: binário `ffprobe` real sobre as fixtures — metadados de `h264-aac.mp4` e `vp9-opus.webm`, `audioCodec` nulo em `h264-noaudio.mp4`, `MediaUnreadableError` em `not-a-video.mp4` | `src/media/media-probe.service.integration-spec.ts` |
| `MediaThumbnailService` | Integration: binário `ffmpeg` real — JPEG válido de 1280 px de largura, a partir de `h264-aac.mp4` e de `short-0_5s.mp4` | `src/media/media-thumbnail.service.integration-spec.ts` |

**Dependencies:** SI-03.1 (ffmpeg na imagem)

**Acceptance criteria:**

- `probe` sobre `h264-aac.mp4` retorna `duration` > 0, `width`/`height` da fixture, `videoCodec: 'h264'` e `audioCodec: 'aac'`
- `classifyFormat` sobre o probe de `hevc.mp4` retorna `{ supported: false }`; sobre `vp9-opus.webm` retorna `{ supported: true, container: 'webm' }`
- `probe` sobre `not-a-video.mp4` lança `MediaUnreadableError`, não um erro genérico de processo
- `extractFrame` sobre `short-0_5s.mp4` com `thumbnailOffset(0.5)` retorna um JPEG (magic bytes `FF D8`) com 1280 px de largura
- Um binário ffprobe/ffmpeg que não termina dentro do timeout configurado é encerrado, e a chamada falha com erro de timeout

---

### SI-03.10 — VideoProcessor: metadados, thumbnail e política de falha

**Description:** Implementa o consumidor do job `process-video`: lê o original por range requests, valida o formato, extrai metadados e thumbnail, e grava `ready` ou `failed` com motivo, conforme `### Events/Messages`.

**Technical actions:**

1. Adicionar ao `VideosService` `markReady(id, metadata)` (persiste `duration`, `width`, `height`, `container`, `video_codec`, `audio_codec` e `processing_status = ready`) e `markProcessingFailed(id, reason)`. Ambos só atuam quando `processing_status = processing`. Exportar `VideosService` em `VideosModule` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
2. Criar `src/video-processing/video.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE)`, `extends WorkerHost`) com os passos 1–6 de `### Events/Messages`:
   - guard de reentrega;
   - `presignGetObject(originalKey, { audience: 'internal' })`;
   - `probe`, depois `classifyFormat`, lançando `UnrecoverableError` quando não suportado ou ilegível;
   - `extractFrame` no `thumbnailOffset` e `putObject(thumbnailKey, jpeg, 'image/jpeg')`;
   - `markReady`.

   (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`, `phase-03-videos/TD-18`, library-refs `bullmq`)
3. Adicionar `@OnWorkerEvent('failed')`. Se o erro é `UnrecoverableError`, chama `markProcessingFailed(videoId, 'unsupported_format')`. Se `job.attemptsMade >= job.opts.attempts`, usa `'processing_error'`. Falhas intermediárias não alteram o banco (per `phase-03-videos/TD-12`)
4. Criar `src/video-processing/video-processing.module.ts` (imports `VideosModule`, `StorageModule`, `MediaModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; provider `VideoProcessor`). Esse módulo **não** é importado pelo `AppModule`, para que a API não consuma jobs (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: guard de reentrega (status ≠ `processing` → no-op), formato não suportado → `UnrecoverableError`, classificação no evento `failed` (unrecoverable vs. tentativas esgotadas vs. tentativa intermediária) (deps mockadas) | `src/video-processing/video.processor.spec.ts` |
| `VideoProcessor` | Integration: DB + MinIO + ffmpeg reais — fixture enviada ao bucket de testes, `process(job)` chamado direto: `h264-aac.mp4` termina `ready` com metadados e `videos/{id}/thumbnail.jpg` armazenado; `hevc.mp4` lança `UnrecoverableError` e o handler `failed` grava `unsupported_format` (per `phase-03-videos/TD-17`) | `src/video-processing/video.processor.integration-spec.ts` |
| `VideosService.markReady` / `markProcessingFailed` | Integration: só alteram vídeos em `processing`; colunas de metadados persistidas | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 (vídeos em `processing` + job), SI-03.9 (MediaModule)

**Acceptance criteria:**

- Processar o job de um vídeo `h264-aac.mp4` deixa a linha com `processing_status = 'ready'`, `container = 'mp4'`, `video_codec = 'h264'`, `audio_codec = 'aac'`, `duration` > 0, `width`/`height` da fixture, e cria o objeto `videos/{id}/thumbnail.jpg` (JPEG, 1280 px de largura)
- Processar o job de um vídeo `hevc.mp4` ou `not-a-video.mp4` deixa a linha `failed` com `failure_reason = 'unsupported_format'` já na primeira tentativa (`attemptsMade = 1`)
- Um job cujo erro transitório persiste nas 3 tentativas deixa a linha `failed` com `failure_reason = 'processing_error'`; antes da última tentativa, o vídeo permanece `processing`
- Reentregar o job de um vídeo já `ready` não altera a linha nem o thumbnail
- O processamento de um original grande transfere do storage só os bytes lidos pelo ffprobe/ffmpeg, nunca o objeto inteiro: o volume lido nos logs de acesso do MinIO é muito menor que `size_bytes`

---

### SI-03.11 — Runtime do Video Worker: contexto Nest standalone e serviço Compose

**Description:** Empacota o consumidor num processo próprio: mesmo código e imagem, contexto Nest sem HTTP e serviço `video-worker` no Compose. O processamento roda isolado da API.

**Technical actions:**

1. Extrair as opções compartilhadas de `ConfigModule.forRoot(...)` e o `useFactory` do `TypeOrmModule.forRootAsync(...)` do `AppModule` para `src/config/root-config.module.ts` (ou equivalente), reutilizados pela API e pelo worker sem duplicar parâmetros de conexão (per `phase-01-configuracao-base/TD-04`, Inherited Conventions — `databaseConfig` única)
2. Criar `src/worker.module.ts` (config raiz + TypeORM + `QueueModule` + `VideoProcessingModule`; sem controllers) e `src/worker.ts` com `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`, para que o BullMQ feche o worker de forma graciosa no `SIGTERM` (per `phase-03-videos/TD-08`, library-refs `bullmq`)
3. Adicionar ao `package.json` os scripts `start:worker` (`node dist/worker`) e `start:worker:dev` (`nest start --watch --entryFile worker`)
4. Adicionar ao `compose.yaml` o serviço `video-worker` (mesmo `build`/volume do `nestjs-api`, `command: npm run start:worker:dev`, `depends_on` `db`/`redis`/`minio` healthy e `minio-init` completed), sem porta publicada (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação do módulo; o grafo contém `VideoProcessor` e nenhum controller | `src/worker.module.spec.ts` |
| `AppModule` | Unit: o grafo da API não contém `VideoProcessor` (só produtor) | `src/app.module.spec.ts` |

**Dependencies:** SI-03.10 (VideoProcessingModule)

**Acceptance criteria:**

- `docker compose up -d video-worker` deixa o serviço `running`, e o log indica o worker conectado à fila `video-processing`, sem servidor HTTP escutando
- Com o `video-worker` no ar, um vídeo `h264-aac.mp4` enviado pelo fluxo `POST /videos` → `PUT` das partes → `POST .../complete` chega a `processingStatus: "ready"` em `GET /videos/:publicId` sem nenhuma ação manual
- Com o `video-worker` parado, o mesmo fluxo deixa o vídeo em `processing`; ao subir o worker, o job pendente é consumido e o vídeo chega a `ready`
- `docker compose stop video-worker` durante o processamento encerra o processo de forma graciosa (exit code 0), e o job é retomado na próxima subida

---

### SI-03.12 — Endpoints de leitura e entrega: detalhe, streaming, download e thumbnail

**Route:** GET /videos/:publicId, GET /videos/:publicId/stream, GET /videos/:publicId/download, GET /videos/:publicId/thumbnail
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner (non-owner → `404 VIDEO_NOT_FOUND`)

**Description:** Dá ao dono o estado do vídeo (para acompanhar o processamento) e URLs presignadas de curta duração: streaming por range, download como anexo e thumbnail. Os bytes vão direto do storage para o cliente.

**Technical actions:**

1. Adicionar `VideosService.getOwned(publicId, userId)` → `VideoResponseDto` (via `findOwnedOrFail`) (per `phase-03-videos/TD-16`)
2. Adicionar `VideosService.getMediaUrl(publicId, userId, kind: 'stream' | 'download' | 'thumbnail')`:
   - exige `processing_status = ready`, senão `VIDEO_NOT_READY`;
   - presigna no cliente público com `MEDIA_URL_EXPIRES_SECONDS`: `originalKey` para `stream`; `originalKey` + `contentDisposition: attachment; filename="{original_file_name}"` para `download`; `thumbnailKey` para `thumbnail`;
   - retorna `{ url, expiresAt }`.

   (per `phase-03-videos/TD-15`, `phase-03-videos/TD-06`, `phase-03-videos/TD-05`)
3. Criar `src/videos/dto/signed-url-response.dto.ts` (`url`, `expiresAt`)
4. Adicionar ao `VideosController` as quatro rotas `GET` → `200`, com `@ApiResponse` para `404`/`409` (per `openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwned` / `getMediaUrl` | Unit: ownership → 404, status ≠ `ready` → 409, chave + disposition por `kind`, cálculo de `expiresAt` | `src/videos/videos.service.spec.ts` |
| `VideosService.getMediaUrl` | Integration: MinIO real — a URL de `stream` responde a `Range: bytes=0-1023` com `206`; a de `download` responde com `Content-Disposition: attachment; filename="..."`; a de `thumbnail` responde `200` com `Content-Type: image/jpeg` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10 (vídeos `ready` com thumbnail), SI-03.7 (`findOwnedOrFail`)

**Acceptance criteria:**

- `GET /videos/:publicId` retorna `200` com o `VideoResponse` do dono, incluindo `duration`, `width`, `height`, `container`, `videoCodec` e `audioCodec` quando `processingStatus` é `ready`
- `GET /videos/:publicId/stream` num vídeo `ready` retorna `200` com `{ url, expiresAt }`, e um `GET` na `url` com `Range: bytes=0-1023` retorna `206 Partial Content` com 1024 bytes
- `GET /videos/:publicId/download` retorna `200` com uma `url` cuja resposta traz `Content-Disposition: attachment; filename="<originalFileName>"`
- `GET /videos/:publicId/thumbnail` retorna `200` com uma `url` que entrega `image/jpeg`
- `GET /videos/:publicId/stream`, `/download` ou `/thumbnail` num vídeo `processing` ou `failed` retorna `409` com `error: "VIDEO_NOT_READY"`
- Qualquer uma das quatro rotas chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`; sem `Authorization`, retorna `401`
- Depois de `expiresAt`, a `url` retornada deixa de funcionar (o storage responde `403`)

---

### SI-03.13 — Contrato OpenAPI re-sincronizado e documentação da fase

**Description:** Fecha a fase com o contrato publicado (backend `openapi.json` e cópias do frontend regeneradas, sem código FE) e com os `CLAUDE.md` descrevendo o que a fase entregou de fato.

**Technical actions:**

1. Rodar `npm run openapi:export` no container `nestjs-api` e commitar o `nestjs-project/openapi.json` com as rotas `/videos/**`, schemas de resposta e envelopes de erro (per `openapi-docs-nestjs/TD-02`)
2. Rodar `scripts/sync-openapi.sh` (host) e `npm run openapi:types` no `next-frontend`, commitando `next-frontend/openapi.json` e `next-frontend/lib/api/types.gen.ts` regenerados. Nenhum arquivo-fonte do frontend muda; a UI de vídeo segue diferida (per `phase-03-videos/TD-17` Revisions, `next-frontend-openapi-typing/TD-02`, `next-frontend-openapi-typing/TD-03`)
3. Atualizar `nestjs-project/CLAUDE.md`:
   - Serviços `minio`, `minio-init`, `redis` e `video-worker`, com seus readiness checks (`redis-cli ping`, health do MinIO).
   - Scripts `start:worker*`.
   - Nova seção "Videos": fluxo de upload multipart presignado, `status`/`processing_status`, fila `video-processing`, layout de chaves no bucket, variáveis `STORAGE_*`/`REDIS_*`/`UPLOAD_*`/`MEDIA_*` e allowlist MP4/WebM.
4. Atualizar o `CLAUDE.md` raiz e `docs/diagrams/software-arch.mermaid`, substituindo "Message Queue (TBD)" por BullMQ + Redis e registrando o Video Worker como serviço `video-worker` do Compose (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `exportSpec` | Integration: o documento exportado contém `/videos`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}/stream` e os códigos de erro dessas rotas | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.12 (todas as rotas implementadas), SI-03.11 (serviço `video-worker` a documentar)

**Acceptance criteria:**

- `nestjs-project/openapi.json` commitado é idêntico ao produzido por `npm run openapi:export` sobre o código final
- `next-frontend/openapi.json` é idêntico ao `nestjs-project/openapi.json`, e `next-frontend/lib/api/types.gen.ts` regenerado não mostra diff; o freshness check do frontend passa
- `git diff` da fase no `next-frontend/` contém só `openapi.json` e `lib/api/types.gen.ts`
- Os serviços, scripts, variáveis de ambiente, rotas e status descritos em `nestjs-project/CLAUDE.md` existem com esses nomes em `compose.yaml`, `package.json`, `env.validation.ts` e no código de `src/videos/`
- O `CLAUDE.md` raiz e o diagrama de arquitetura não citam mais a Message Queue como "TBD"

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Migration `<timestamp>-CreateVideos.ts`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated. Internal only, never exposed in URLs or responses (per phase-03-videos/TD-14) |
| public_id | varchar(11) | unique, not null. 11-char base64url string from `crypto.randomBytes(8)`; generated on insert, retried on unique violation, same pattern as `channels.nickname` (per phase-03-videos/TD-14) |
| channel_id | uuid | FK → `channels.id` ON DELETE CASCADE, not null. Taken from the caller's channel at initiate (per phase-03-videos/TD-11) |
| title | varchar(100) | not null. Default: `fileName` without its extension, truncated to 100 chars (per phase-03-videos/TD-11) |
| status | enum `videos_status_enum` (`draft`) | not null, default `draft`. Owned by the API; Phase 03 never writes any other value (per phase-03-videos/TD-11) |
| processing_status | enum `videos_processing_status_enum` (`awaiting_upload`, `processing`, `ready`, `failed`) | not null, default `awaiting_upload`. Owned by the upload/processing pipeline (per phase-03-videos/TD-11) |
| failure_reason | varchar(32) | nullable. Set only when `processing_status = failed`. One of: `unsupported_format`, `processing_error`, `size_mismatch`, `upload_expired`, `upload_aborted` |
| original_file_name | varchar(255) | not null. The `fileName` sent at initiate |
| content_type | varchar(32) | not null. `video/mp4` or `video/webm` (per phase-03-videos/TD-18) |
| size_bytes | bigint | not null, > 0, ≤ 10737418240. The declared size, checked against `HeadObject` at complete. Mapped to `number` with a column transformer, since the value fits in 2^53 (per phase-03-videos/TD-03, TD-10) |
| upload_id | text | nullable. S3 `UploadId` from `CreateMultipartUpload`; set to null once the upload is completed or aborted (per phase-03-videos/TD-02) |
| part_size | integer | not null. Server-defined part size used for this upload, recorded so a resume uses the same size even if config changes (per phase-03-videos/TD-03) |
| duration | double precision | nullable. Seconds, from `ffprobe` `format.duration` (per phase-03-videos/TD-10) |
| width | integer | nullable. Video stream width (per phase-03-videos/TD-10) |
| height | integer | nullable. Video stream height (per phase-03-videos/TD-10) |
| container | varchar(32) | nullable. Normalized container family, `mp4` or `webm` (per phase-03-videos/TD-10, TD-18) |
| video_codec | varchar(32) | nullable. `ffprobe` `codec_name` of the video stream: `h264`, `vp8`, `vp9` or `av1` (per phase-03-videos/TD-10, TD-18) |
| audio_codec | varchar(32) | nullable. `ffprobe` `codec_name` of the first audio stream (`aac`, `mp3`, `opus`, `vorbis`); null when the file has no audio (per phase-03-videos/TD-10, TD-18) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on write |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel` → `channels.id`).
**Indexes:** unique on `public_id`; btree on `channel_id`.

**State transitions (`processing_status`, per phase-03-videos/TD-11, TD-12, TD-13):**

| From | To | Actor | When |
|------|----|-------|------|
| — | `awaiting_upload` | API (initiate) | Draft row created together with `CreateMultipartUpload` |
| `awaiting_upload` | `processing` | API (complete) | `CompleteMultipartUpload` succeeded and `HeadObject` size equals `size_bytes`; the job is enqueued in the same step |
| `awaiting_upload` | `failed` (`size_mismatch`) | API (complete) | Stored size ≠ `size_bytes`; the object is deleted |
| `awaiting_upload` | `failed` (`upload_expired`) | API (any upload call) | Storage reports `NoSuchUpload` and no completed object exists |
| `awaiting_upload` | `failed` (`upload_aborted`) | API (abort) | Owner aborts the upload |
| `processing` | `ready` | Worker | Metadata persisted and thumbnail stored |
| `processing` | `failed` (`unsupported_format`) | Worker | `ffprobe` cannot parse the file, or the container/codecs are outside the allowlist; no retries (per phase-03-videos/TD-18) |
| `processing` | `failed` (`processing_error`) | Worker | Retries exhausted on a transient error (per phase-03-videos/TD-12) |

`ready` and `failed` are terminal in Phase 03. Phase 04 owns `status` transitions beyond `draft`.

**Object storage layout (per phase-03-videos/TD-05):** a single private bucket (name from config), with one prefix per video keyed by the internal `id`:

| Object | Key | Written by |
|--------|-----|------------|
| Original upload | `videos/{id}/original` | Client, via presigned `UploadPart` URLs, assembled by `CompleteMultipartUpload` (per phase-03-videos/TD-02) |
| Thumbnail | `videos/{id}/thumbnail.jpg` | Worker. JPEG, 1280px wide preserving aspect ratio, frame at 10% of `duration` (first frame when `duration` < 1s) (per phase-03-videos/TD-10) |

Bucket configuration (provisioned by the storage init job, per phase-03-videos/TD-04, TD-13):
- CORS exposes the `ETag` header to browser clients (per phase-03-videos/TD-02).
- A lifecycle rule `AbortIncompleteMultipartUpload` applies to prefix `videos/`.

### API Contracts

All endpoints below require `Authorization: Bearer <access_token>` (the global `JwtAuthGuard`; none is `@Public()`). The caller's channel comes from the JWT `sub` (per phase-03-videos/TD-11, TD-16). `:publicId` is the video's `public_id` (per phase-03-videos/TD-14). The API never receives file bytes: it only signs URLs and drives the multipart lifecycle (per phase-03-videos/TD-02). Video JSON fields use camelCase, as fixed by the TD-11 initiate contract (`fileName`, `size`, `contentType`, `title`) and the TD-15 delivery contract (`url`, `expiresAt`).

**`VideoResponse`** (shared response body):
- publicId: string — 11-char base64url
- title: string
- status: `"draft"`
- processingStatus: `"awaiting_upload" | "processing" | "ready" | "failed"`
- failureReason: string | null
- originalFileName: string
- contentType: `"video/mp4" | "video/webm"`
- sizeBytes: number
- duration: number | null — seconds
- width: number | null
- height: number | null
- container: string | null
- videoCodec: string | null
- audioCodec: string | null
- createdAt: string (ISO-8601)

**`SignedUrlResponse`** (per phase-03-videos/TD-15):
- url: string — presigned on the public storage endpoint (per phase-03-videos/TD-06)
- expiresAt: string (ISO-8601)

---

#### POST /videos (SI-03.6)

Creates the draft and starts the multipart upload (per phase-03-videos/TD-02, TD-03, TD-11, TD-18).

**Request headers:**
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1–255 chars. Extension `.mp4`, `.m4v` or `.webm` (case-insensitive), consistent with `contentType`
- size: integer, required — ≥ 1 bytes. Above 10737418240 (10 GiB) → `VIDEO_TOO_LARGE`
- contentType: string, required — `video/mp4` or `video/webm`
- title: string, optional — trimmed, 1–100 chars. Default: `fileName` without its extension, truncated to 100 chars

**Response 201:**
- `VideoResponse` (with `processingStatus: "awaiting_upload"`), plus:
- upload: object
  - partSize: number — bytes; server-defined from config (per phase-03-videos/TD-03)
  - partCount: number — `ceil(size / partSize)`, ≤ 10000

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 413 VIDEO_TOO_LARGE: `size` > 10737418240
- 415 UNSUPPORTED_VIDEO_FORMAT: `contentType` not in the allowlist, or the `fileName` extension does not match `contentType`
- 401: missing or invalid access token (inherited `JwtAuthGuard` behavior)

---

#### POST /videos/:publicId/upload/part-urls (SI-03.7)

Issues short-lived presigned `UploadPart` URLs on demand, for upload and for resume (per phase-03-videos/TD-03, TD-06).

**Request headers:**
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1–100 unique integers, each ≥ 1

**Response 200:**
- parts: `{ partNumber: number, url: string }[]` — one per requested part number, in ascending order
- expiresAt: string (ISO-8601) — shared expiry of the batch

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 400 INVALID_PART_NUMBER: a part number > the video's `partCount`
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_AWAITING_UPLOAD: `processingStatus` ≠ `awaiting_upload`
- 410 UPLOAD_EXPIRED: storage reports `NoSuchUpload`; the video is marked `failed` (`upload_expired`)

---

#### GET /videos/:publicId/upload/parts (SI-03.7)

Lists the parts already stored, so a client can resume (`ListParts`, per phase-03-videos/TD-02, TD-03).

**Response 200:**
- parts: `{ partNumber: number, etag: string, size: number }[]` — ascending by `partNumber`; empty when nothing is uploaded yet

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_AWAITING_UPLOAD: `processingStatus` ≠ `awaiting_upload`
- 410 UPLOAD_EXPIRED: storage reports `NoSuchUpload`; the video is marked `failed` (`upload_expired`)

---

#### POST /videos/:publicId/upload/complete (SI-03.8)

Assembles the upload, checks the stored size, moves the video to `processing` and enqueues the processing job (per phase-03-videos/TD-03, TD-07).

**Request headers:**
- Content-Type: application/json

**Request body:**
- parts: `{ partNumber: integer ≥ 1, etag: string non-empty }[]`, required — 1–10000 entries; must cover exactly part numbers `1..partCount`

**Response 202:**
- `VideoResponse` with `processingStatus: "processing"`

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 400 INVALID_UPLOAD_PARTS: `parts` does not cover `1..partCount`, or storage rejects the list (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`)
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_AWAITING_UPLOAD: `processingStatus` ≠ `awaiting_upload`
- 410 UPLOAD_EXPIRED: storage reports `NoSuchUpload` and no completed object exists; the video is marked `failed` (`upload_expired`)
- 422 UPLOAD_SIZE_MISMATCH: the `HeadObject` `ContentLength` ≠ `sizeBytes`; the object is deleted and the video is marked `failed` (`size_mismatch`)

**Retry safety (per phase-03-videos/TD-07, TD-13):** if storage reports `NoSuchUpload` but `videos/{id}/original` already exists with the declared size, a previous call completed the upload and failed before the DB update. The call then proceeds to the DB update and enqueue. Because the enqueue uses `jobId = video id`, a repeated enqueue is ignored.

---

#### DELETE /videos/:publicId/upload (SI-03.7)

Aborts an in-progress upload: `AbortMultipartUpload`, then the video is marked `failed` (`upload_aborted`) (per phase-03-videos/TD-13).

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_AWAITING_UPLOAD: `processingStatus` ≠ `awaiting_upload`

`NoSuchUpload` from storage is treated as already aborted: the call still marks the video and returns 204.

---

#### GET /videos/:publicId (SI-03.12)

Returns the owner's view of the video; clients poll it for processing progress.

**Response 200:**
- `VideoResponse`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel

---

#### GET /videos/:publicId/stream (SI-03.12)

Returns a short-lived presigned `GetObject` URL for playback. Storage answers `Range` requests with `206 Partial Content`, so playback starts without downloading the whole file (per phase-03-videos/TD-15, TD-06).

**Response 200:**
- `SignedUrlResponse` — key `videos/{id}/original`, signed with the public-endpoint client

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_READY: `processingStatus` ≠ `ready`

---

#### GET /videos/:publicId/download (SI-03.12)

Returns a short-lived presigned `GetObject` URL that downloads the original as an attachment (per phase-03-videos/TD-15).

**Response 200:**
- `SignedUrlResponse` — key `videos/{id}/original`, signed with `ResponseContentDisposition: attachment; filename="{originalFileName}"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_READY: `processingStatus` ≠ `ready`

---

#### GET /videos/:publicId/thumbnail (SI-03.12)

Returns a short-lived presigned `GetObject` URL for the generated thumbnail; the bucket is private (per phase-03-videos/TD-05, TD-15).

**Response 200:**
- `SignedUrlResponse` — key `videos/{id}/thumbnail.jpg`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown `publicId`, or the video belongs to another channel
- 409 VIDEO_NOT_READY: `processingStatus` ≠ `ready`

---

#### Validation Rules — videos

- `fileName`: required string, 1–255 chars, extension in {`.mp4`, `.m4v`, `.webm`} (case-insensitive)
- `size`: required integer, ≥ 1. The 10 GiB ceiling is a domain rule (`VIDEO_TOO_LARGE`), not schema validation
- `contentType`: required string. The allowlist {`video/mp4`, `video/webm`} and its pairing with the extension (`.mp4`/`.m4v` ↔ `video/mp4`, `.webm` ↔ `video/webm`) are a domain rule (`UNSUPPORTED_VIDEO_FORMAT`) (per phase-03-videos/TD-18)
- `title`: optional string, trimmed, 1–100 chars
- `partNumbers`: required array, 1–100 unique integers ≥ 1
- `parts`: required array, 1–10000 items; each item has `partNumber` (integer ≥ 1) and `etag` (non-empty string)
- Unknown body properties are rejected (inherited global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`)
- The client-side `PUT` of each part to its presigned URL is outside the API contract. Clients must read the `ETag` response header of each `PUT` and send it back at complete; browsers can only do this because the bucket CORS exposes `ETag`. Presigned part URLs are signed without flexible checksums (`requestChecksumCalculation: 'WHEN_REQUIRED'`), so the client's `PUT` carries only the part bytes (per library-refs `@aws-sdk/client-s3`)

### Authorization Matrix

Owner = the authenticated user whose channel is the video's `channel_id` (per phase-03-videos/TD-16). Non-owners get `404 VIDEO_NOT_FOUND`, not 403, so they cannot tell whether a `publicId` exists (per phase-03-videos/TD-14, TD-16). Anonymous callers get the inherited 401 from `JwtAuthGuard`.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ — creates a video in the caller's own channel | n/a |
| POST /videos/:publicId/upload/part-urls | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:publicId/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:publicId/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/stream | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/download | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/thumbnail | ✗ (401) | ✗ (404) | ✓ |

Presigned storage URLs are bearer capabilities: whoever holds an unexpired URL can use it. They are only issued to the owner, and they expire (`expiresAt`) (per phase-03-videos/TD-15, TD-16).

### Error Catalog

Envelope `{ statusCode, error, message }`, inherited from phase-02-auth/TD-07 (`DomainException` + `DomainExceptionFilter`; `error` carries the code below). Schema validation failures keep the inherited `400 VALIDATION_ERROR` with `message: string[]`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 413 | Initiate with `size` > 10737418240 (10 GiB). Rejected before any storage call (per phase-03-videos/TD-02, TD-03) |
| UNSUPPORTED_VIDEO_FORMAT | 415 | Initiate with `contentType` ∉ {`video/mp4`, `video/webm`}, or a `fileName` extension that does not match `contentType` (per phase-03-videos/TD-18) |
| VIDEO_NOT_FOUND | 404 | `publicId` does not exist, or the video belongs to another channel (per phase-03-videos/TD-16) |
| VIDEO_NOT_AWAITING_UPLOAD | 409 | Part URLs, list parts, complete or abort requested while `processing_status` ≠ `awaiting_upload` |
| INVALID_PART_NUMBER | 400 | A requested part number exceeds the video's `partCount` (per phase-03-videos/TD-03) |
| INVALID_UPLOAD_PARTS | 400 | The complete `parts` list does not cover `1..partCount`, or storage rejects it (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) (per phase-03-videos/TD-02) |
| UPLOAD_EXPIRED | 410 | Storage reports `NoSuchUpload` and no completed object exists; the video becomes `failed` (`upload_expired`) (per phase-03-videos/TD-13) |
| UPLOAD_SIZE_MISMATCH | 422 | At complete, the `HeadObject` `ContentLength` ≠ declared `size_bytes`; the object is deleted and the video becomes `failed` (`size_mismatch`) (per phase-03-videos/TD-03) |
| VIDEO_NOT_READY | 409 | Stream, download or thumbnail requested while `processing_status` ≠ `ready` (per phase-03-videos/TD-15) |

**Processing failure reasons** (persisted in `videos.failure_reason`; exposed as `failureReason` and never sent as an HTTP error):

| failure_reason | Set by | Trigger |
|----------------|--------|---------|
| unsupported_format | Worker | `ffprobe` cannot parse the input, or it is outside the allowlist: container family MP4 or WebM; video codec `h264`/`vp8`/`vp9`/`av1` paired with its container; audio `aac`/`mp3`/`opus`/`vorbis` or none. Thrown as BullMQ `UnrecoverableError`, so no retries are spent (per phase-03-videos/TD-18, TD-12) |
| processing_error | Worker | Any other processing error after the job's attempts are exhausted (per phase-03-videos/TD-12) |
| size_mismatch | API | See `UPLOAD_SIZE_MISMATCH` |
| upload_expired | API | See `UPLOAD_EXPIRED` |
| upload_aborted | API | Owner called `DELETE /videos/:publicId/upload` (per phase-03-videos/TD-13) |

### Events/Messages

#### video-processing → `process-video`

BullMQ queue `video-processing`, job name `process-video` (per phase-03-videos/TD-01).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (complete upload, SI-03.8). The job is enqueued after the row moves to `processing`, with `jobId = videoId`, so a repeated enqueue is ignored. Options: `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per phase-03-videos/TD-07, TD-12).
**Consumer:** `VideoProcessor` (`@Processor('video-processing')` extending `WorkerHost`, SI-03.10). It runs only in the `video-worker` Compose service, which boots a standalone Nest application context from the same codebase and image. The API process registers the queue as a producer only (per phase-03-videos/TD-08).
**Trigger:** `POST /videos/:publicId/upload/complete` succeeded (assembled object verified with `HeadObject`) (per phase-03-videos/TD-07).
**Processing steps:**
1. Load the video. If `processing_status` ≠ `processing`, return without changes (redelivery guard).
2. Presign an internal `GetObject` URL for `videos/{id}/original` (internal client; per phase-03-videos/TD-06, TD-09).
3. Run `ffprobe -print_format json -show_format -show_streams` on the URL. FFmpeg's HTTP input reads only the byte ranges it needs (per phase-03-videos/TD-09, TD-10).
4. Validate against the TD-18 allowlist. On violation, throw `UnrecoverableError`.
5. Run `ffmpeg -ss <10% of duration, or 0 when duration < 1s> -i <url> -frames:v 1 -vf scale=1280:-2` → JPEG, uploaded to `videos/{id}/thumbnail.jpg` (per phase-03-videos/TD-10).
6. Persist `duration`, `width`, `height`, `container`, `video_codec`, `audio_codec`, and set `processing_status = ready`.

**Final failure:** in the `failed` worker event, when the error is an `UnrecoverableError` (`unsupported_format`) or `job.attemptsMade` reaches `job.opts.attempts` (`processing_error`), set `processing_status = failed` and `failure_reason` (per phase-03-videos/TD-12, library-refs `bullmq`).
**Delivery semantics:** at-least-once (per phase-03-videos/TD-01, TD-12). Idempotency comes from the step-1 guard plus deterministic overwrite of the thumbnail key and metadata columns. Redis runs with `maxmemory-policy noeviction` and AOF enabled (per library-refs `bullmq`).

---

## Dependency Map

```
SI-03.1 (root — Compose: MinIO, minio-init, Redis; ffmpeg na imagem)
├── SI-03.3 — depends on SI-03.1 + SI-03.2 (StorageService precisa do MinIO e da config storage)
│   └── SI-03.6 — depends on SI-03.3 + SI-03.5 (initiate cria o multipart e persiste o rascunho)
│       └── SI-03.7 — depends on SI-03.6 (part URLs/list/abort operam sobre o rascunho com upload_id)
│           └── SI-03.8 — depends on SI-03.7 + SI-03.4 (complete fecha o multipart e enfileira o job)
│               └── SI-03.10 — depends on SI-03.8 + SI-03.9 (processor consome vídeos em processing)
│                   ├── SI-03.11 — depends on SI-03.10 (worker hospeda o VideoProcessingModule)
│                   │   └── SI-03.13 — depends on SI-03.11 + SI-03.12 (contrato e docs finais)
│                   └── SI-03.12 — depends on SI-03.10 + SI-03.7 (entrega exige vídeos ready + findOwnedOrFail)
│                       └── SI-03.13 — (ver acima)
├── SI-03.4 — depends on SI-03.1 + SI-03.2 (QueueModule precisa do Redis e da config queue)
│   └── SI-03.8 — (ver acima)
└── SI-03.9 — depends on SI-03.1 (ffprobe/ffmpeg instalados na imagem)
    └── SI-03.10 — (ver acima)
SI-03.2 (root — env + config factories)
├── SI-03.3 — (ver acima)
└── SI-03.4 — (ver acima)
SI-03.5 (root — entidade Video + migração CreateVideos)
└── SI-03.6 — (ver acima)
```

**Ordem de execução sugerida:** SI-03.1 → SI-03.2 → SI-03.5 → SI-03.3 → SI-03.4 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13

---

## Deliverables

- [ ] SI-03.1 — Infra: storage S3 (MinIO), Redis e FFmpeg no ambiente Docker
- [ ] SI-03.2 — Configuração: variáveis de storage, fila e upload
- [ ] SI-03.3 — StorageModule: clientes S3 interno/público e StorageService
- [ ] SI-03.4 — Infra: QueueModule (BullMQ + Redis)
- [ ] SI-03.5 — Entidade Video, migração CreateVideos e gerador de public id
- [ ] SI-03.6 — Endpoint POST /videos (pré-cadastro do rascunho + início do multipart)
- [ ] SI-03.7 — Endpoints de upload: URLs de partes, listagem para retomada e abort
- [ ] SI-03.8 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)
- [ ] SI-03.9 — MediaModule: wrapper tipado de ffprobe/ffmpeg e allowlist de formatos
- [ ] SI-03.10 — VideoProcessor: metadados, thumbnail e política de falha
- [ ] SI-03.11 — Runtime do Video Worker: contexto Nest standalone e serviço Compose
- [ ] SI-03.12 — Endpoints de leitura e entrega: detalhe, streaming, download e thumbnail
- [ ] SI-03.13 — Contrato OpenAPI re-sincronizado e documentação da fase

**Full test suites:**

- [ ] Backend unit + integration tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Frontend contract freshness passes — `next-frontend/openapi.json` and `next-frontend/lib/api/types.gen.ts` show no diff after `scripts/sync-openapi.sh` + `npm run openapi:types` (per `next-frontend-openapi-typing/TD-03`)
