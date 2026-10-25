---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-upload-parts.e2e-spec.ts
---

# Upload parts, resume and abort — Test Plan

## Application Overview

After `POST /videos`, the owner drives the multipart upload through three endpoints:

- `POST /videos/:publicId/upload/part-urls` issues short-lived presigned `UploadPart` URLs on demand (1–100 part numbers per call, each ≤ `partCount`).
- `GET /videos/:publicId/upload/parts` lists the parts already stored (`ListParts`), so an interrupted client can resume.
- `DELETE /videos/:publicId/upload` aborts the upload and marks the video `failed` (`upload_aborted`).

All three require the video to be `awaiting_upload` (`VIDEO_NOT_AWAITING_UPLOAD`, 409). Non-owners get `VIDEO_NOT_FOUND` (404). When storage reports `NoSuchUpload`, the video is marked `failed` (`upload_expired`) and the call returns `UPLOAD_EXPIRED` (410). Part bytes never go through the API: the client `PUT`s them to the presigned URL and reads the `ETag` header.

## Test Scenarios

### 1. URLs presignadas, retomada e cancelamento do upload

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` with the same global pipe and filters as `main.ts`. `beforeEach`: `cleanAllTables(dataSource)`, then register + confirm + log in two users (owner and other), same helper as `test/auth.e2e-spec.ts`. Test env: `STORAGE_BUCKET` = test bucket; `STORAGE_PUBLIC_ENDPOINT=http://minio:9000` (the suite runs inside the `nestjs-api` container); `UPLOAD_PART_SIZE_BYTES=5242880` (5 MiB, the S3 minimum) to keep payloads small. A helper creates a draft via `POST /videos` with `size: 7340032` (7 MiB → `partCount: 2`) and returns `publicId`, `partSize` and `partCount`. Part payloads are `Buffer`s of the exact sizes (part 1: 5 MiB, part 2: 2 MiB), uploaded with a plain HTTP `PUT` (no SDK) to the returned URL.

#### 1.1. part-urls-emite-urls-utilizaveis

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls como owner com `{ "partNumbers": [2, 1] }`
    - expect: status `200`
    - expect: `parts` tem 2 entradas, em ordem ascendente (`partNumber` 1 e depois 2), cada uma com `url` string
    - expect: `expiresAt` é ISO-8601 entre 800 e 1000 s no futuro (default `UPLOAD_PART_URL_EXPIRES_SECONDS=900`)
  2. HTTP `PUT` dos bytes da parte 1 em `parts[0].url`, e da parte 2 em `parts[1].url`
    - expect: ambos `200`, cada um com header `ETag` não vazio

#### 1.2. part-urls-numero-fora-do-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos/:publicId/upload/part-urls com `{ "partNumbers": [3] }` num draft de `partCount: 2`
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`
  2. POST .../part-urls com `{ "partNumbers": [0] }`, `{ "partNumbers": [] }`, `{ "partNumbers": [1, 1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` em cada caso

#### 1.3. list-parts-reflete-partes-enviadas

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/upload/parts antes de qualquer `PUT`
    - expect: status `200` com `parts: []`
  2. Obter URLs para as partes 1 e 2 e fazer o `PUT` de ambas
  3. GET /videos/:publicId/upload/parts
    - expect: status `200` com `parts` = `[{ partNumber: 1, etag, size: 5242880 }, { partNumber: 2, etag, size: 2097152 }]`
    - expect: cada `etag` é igual ao header `ETag` do `PUT` correspondente

#### 1.4. abort-marca-upload-aborted

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. DELETE /videos/:publicId/upload como owner
    - expect: status `204` sem corpo
    - expect: no banco, a linha do vídeo tem `processing_status = 'failed'`, `failure_reason = 'upload_aborted'` e `upload_id = null`
  2. POST /videos/:publicId/upload/part-urls com `{ "partNumbers": [1] }`
    - expect: status `409` com `error: "VIDEO_NOT_AWAITING_UPLOAD"`
  3. DELETE /videos/:publicId/upload novamente
    - expect: status `409` com `error: "VIDEO_NOT_AWAITING_UPLOAD"`

#### 1.5. multipart-expirado-marca-upload-expired

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Abortar o multipart direto no storage: `StorageService.abortMultipartUpload` com a key `videos/{id}/original` e o `upload_id` lido do banco (simula a expiração pela regra de lifecycle)
  2. GET /videos/:publicId/upload/parts
    - expect: status `410` com `error: "UPLOAD_EXPIRED"`
    - expect: no banco, `processing_status = 'failed'` e `failure_reason = 'upload_expired'`
  3. Repetir os passos 1–2 com um novo draft, usando POST .../part-urls no passo 2
    - expect: status `410` com `error: "UPLOAD_EXPIRED"`

#### 1.6. nao-owner-recebe-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Com o token do outro usuário: POST .../part-urls, GET .../upload/parts e DELETE .../upload no `publicId` do owner
    - expect: as três retornam `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo do owner continua `awaiting_upload`
  2. Com o token do owner, as mesmas três rotas sobre um `publicId` inexistente (`"AAAAAAAAAAA"`)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`, com o mesmo corpo do passo 1
  3. As três rotas sem `Authorization`
    - expect: `401`
