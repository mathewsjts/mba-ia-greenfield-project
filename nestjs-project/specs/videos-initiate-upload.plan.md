---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` is the start of the upload. An authenticated user declares the file (`fileName`, `size`, `contentType`, optional `title`). The API pre-registers the video as a draft (`status: "draft"`, `processingStatus: "awaiting_upload"`) in the caller's channel and opens an S3 multipart upload at `videos/{id}/original`. It returns the shared `VideoResponse` plus `upload: { partSize, partCount }`. No file bytes go through the API: parts are later `PUT` straight to storage via presigned URLs. Declared sizes above 10 GiB (`VIDEO_TOO_LARGE`, 413) and formats outside the MP4/WebM allowlist (`UNSUPPORTED_VIDEO_FORMAT`, 415) are rejected before any storage call. Errors use the inherited `{ statusCode, error, message }` envelope.

## Test Scenarios

### 1. Pré-cadastro do rascunho e início do multipart

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()`. Apply the same global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) and the `DomainExceptionFilter` + `ValidationExceptionFilter` as `main.ts`. `beforeEach`: `cleanAllTables(dataSource)`, then register + confirm + log in a user (same helper pattern as `test/auth.e2e-spec.ts`) to get an `access_token`. Test env: `STORAGE_BUCKET` points to the test bucket provisioned by `minio-init`, and `STORAGE_PUBLIC_ENDPOINT=http://minio:9000`, because the suite runs inside the `nestjs-api` container where `localhost:9000` does not reach MinIO. Uses the default `UPLOAD_PART_SIZE_BYTES` (`67108864`).

#### 1.1. initiate-10gib-mp4-cria-rascunho

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ "fileName": "aula.mp4", "size": 10737418240, "contentType": "video/mp4" }`
    - expect: status `201`
    - expect: body `status: "draft"`, `processingStatus: "awaiting_upload"`, `title: "aula"`, `failureReason: null`
    - expect: body `upload.partSize: 67108864` e `upload.partCount: 160`
    - expect: body `originalFileName: "aula.mp4"`, `contentType: "video/mp4"`, `sizeBytes: 10737418240`

#### 1.2. initiate-acima-de-10gib-rejeitado

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com `size: 10737418241`, `fileName: "big.mp4"`, `contentType: "video/mp4"`
    - expect: status `413` com `error: "VIDEO_TOO_LARGE"`
    - expect: nenhuma linha em `videos`
    - expect: `ListMultipartUploads` no bucket de testes não lista nenhum upload em `videos/`

#### 1.3. initiate-formato-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com `{ "fileName": "clip.mov", "size": 1048576, "contentType": "video/quicktime" }`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
  2. POST /videos com `{ "fileName": "clip.webm", "size": 1048576, "contentType": "video/mp4" }` (extensão incoerente)
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
  3. POST /videos com `{ "fileName": "clip.WEBM", "size": 1048576, "contentType": "video/webm" }` (extensão em maiúsculas)
    - expect: status `201`

#### 1.4. initiate-body-invalido

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com body válido mais `"foo": "bar"`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` como array
  2. POST /videos com `size: 1.5`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  3. POST /videos sem `fileName`
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  4. POST /videos com `title: ""` (vazio após trim) ou `title` com 101 caracteres
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 1.5. initiate-sem-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com body válido e sem header `Authorization`
    - expect: status `401`
    - expect: nenhuma linha em `videos`

#### 1.6. initiate-public-id-unico-sem-id-interno

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos duas vezes com o mesmo body válido
    - expect: ambas `201`
    - expect: `publicId` casa `^[A-Za-z0-9_-]{11}$` nas duas respostas, e os dois valores são diferentes
    - expect: nenhuma das respostas contém a chave `id` nem um valor no formato UUID

#### 1.7. initiate-persiste-no-canal-do-caller

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. POST /videos com `{ "fileName": "intro.webm", "size": 2048, "contentType": "video/webm", "title": "  Minha intro  " }`
    - expect: status `201` com `title: "Minha intro"` (trim aplicado)
  2. Consultar `videos` pelo `public_id` retornado
    - expect: `channel_id` é o id do canal do usuário autenticado
    - expect: `upload_id` não nulo e `part_size = 67108864`
  3. `ListParts` no bucket de testes com a key `videos/{id}/original` e o `upload_id` persistido
    - expect: a chamada sucede (multipart aberto), com zero partes
