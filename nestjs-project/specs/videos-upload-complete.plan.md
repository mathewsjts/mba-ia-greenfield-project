---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete — Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` closes the direct-to-storage upload. The owner sends the `{ partNumber, etag }` of every part.

- **Part list:** it must cover `1..partCount` exactly; otherwise the call returns `INVALID_UPLOAD_PARTS` (400), which also covers a part list rejected by storage.
- **Assembly:** the API runs `CompleteMultipartUpload`, then checks the stored object with `HeadObject` against the declared `size`. On a mismatch it deletes the object, marks the video `failed` (`size_mismatch`) and returns `UPLOAD_SIZE_MISMATCH` (422).
- **Enqueue:** the video moves to `processing` and a BullMQ job `process-video` is added to queue `video-processing` with `jobId = <internal video id>` and payload `{ videoId }`. The response is `202` with the `VideoResponse`.
- **Rejected calls:** a second call returns `VIDEO_NOT_AWAITING_UPLOAD` (409). If the multipart upload no longer exists and there is no completed object, the call returns `UPLOAD_EXPIRED` (410).

The API process only produces jobs; no worker consumes them in this suite.

## Test Scenarios

### 1. Conclusão do upload e enfileiramento do processamento

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` with the same global pipe and filters as `main.ts`.

`beforeEach`:
- `cleanAllTables(dataSource)`.
- Obliterate queue `video-processing`: `app.get<Queue>(getQueueToken('video-processing')).obliterate({ force: true })`.
- Register + confirm + log in an owner and a second user (helper from `test/auth.e2e-spec.ts`).

Test env:
- `STORAGE_BUCKET` = test bucket.
- `STORAGE_PUBLIC_ENDPOINT=http://minio:9000`.
- `UPLOAD_PART_SIZE_BYTES=5242880`.
- `REDIS_HOST=redis`.

Helper `uploadAllParts(publicId, sizes)`:
1. Gets part URLs.
2. `PUT`s `Buffer`s of the given sizes.
3. Returns `[{ partNumber, etag }]` from the `ETag` headers.

The default draft is `size: 7340032` (`partCount: 2`; parts of 5 MiB + 2 MiB).

#### 1.1. complete-move-para-processing-e-enfileira

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Criar o draft e fazer `uploadAllParts(publicId, [5242880, 2097152])`
  2. POST /videos/:publicId/upload/complete como owner com `{ "parts": [{ partNumber: 1, etag }, { partNumber: 2, etag }] }`
    - expect: status `202` com `processingStatus: "processing"` e `status: "draft"`
    - expect: no banco, `processing_status = 'processing'` e `upload_id = null`
    - expect: `HeadObject` em `videos/{id}/original` retorna `ContentLength = 7340032`
  3. Inspecionar a fila `video-processing` (`getJobs(['waiting', 'delayed', 'active'])`)
    - expect: exatamente 1 job, com `name = 'process-video'`, `id` igual ao id interno do vídeo e `data = { videoId: <id interno> }`
    - expect: `opts.attempts = 3` e `opts.backoff = { type: 'exponential', delay: 5000 }`

#### 1.2. complete-faltando-parte

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Criar o draft e enviar só a parte 1
  2. POST .../complete com `{ "parts": [{ partNumber: 1, etag }] }`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: o vídeo continua `processing_status = 'awaiting_upload'` com `upload_id` não nulo
    - expect: a fila não tem jobs
  3. POST .../complete com `{ "parts": [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 1.3. complete-etag-incorreto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Criar o draft e enviar as duas partes
  2. POST .../complete com o `etag` da parte 2 trocado por `"\"00000000000000000000000000000000\""`
    - expect: status `400` com `error: "INVALID_UPLOAD_PARTS"`
    - expect: o vídeo continua `awaiting_upload`, e a fila não tem jobs

#### 1.4. complete-tamanho-divergente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Criar o draft com `size: 7340032` e fazer `uploadAllParts(publicId, [5242880, 1048576])` (total de 6 MiB armazenados)
  2. POST .../complete com as duas partes
    - expect: status `422` com `error: "UPLOAD_SIZE_MISMATCH"`
    - expect: `HeadObject` em `videos/{id}/original` falha com not found (objeto apagado)
    - expect: no banco, `processing_status = 'failed'` e `failure_reason = 'size_mismatch'`
    - expect: a fila não tem jobs

#### 1.5. complete-repetido-nao-duplica-job

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Executar o fluxo do cenário 1.1 até o `202`
  2. Repetir o mesmo POST .../complete
    - expect: status `409` com `error: "VIDEO_NOT_AWAITING_UPLOAD"`
    - expect: a fila continua com exatamente 1 job para o vídeo
  3. Com o token do segundo usuário, POST .../complete sobre o `publicId` do owner
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.6. complete-multipart-expirado

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Criar o draft, enviar as duas partes e abortar o multipart direto no storage (`StorageService.abortMultipartUpload`)
  2. POST .../complete com as duas partes
    - expect: status `410` com `error: "UPLOAD_EXPIRED"`
    - expect: no banco, `processing_status = 'failed'` e `failure_reason = 'upload_expired'`
    - expect: a fila não tem jobs
