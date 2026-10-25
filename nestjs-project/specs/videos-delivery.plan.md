---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-delivery.e2e-spec.ts
---

# Video read and delivery — Test Plan

## Application Overview

Once a video is processed, the owner reads it and gets media through four endpoints:

- `GET /videos/:publicId` returns the `VideoResponse`, with the metadata the worker extracted (`duration`, `width`, `height`, `container`, `videoCodec`, `audioCodec`). Clients poll it to follow processing.
- `GET /videos/:publicId/stream`, `/download` and `/thumbnail` return `{ url, expiresAt }`: short-lived presigned `GetObject` URLs signed for the public storage endpoint. The API is never in the byte path:
  - **stream:** storage answers `Range` requests with `206`, so playback starts without a full download;
  - **download:** the URL carries `Content-Disposition: attachment; filename="<originalFileName>"`;
  - **thumbnail:** the URL serves the generated JPEG from the private bucket.

The three media endpoints require `processingStatus: "ready"` (`VIDEO_NOT_READY`, 409). All four are owner-only (`VIDEO_NOT_FOUND`, 404, for non-owners).

## Test Scenarios

### 1. Leitura do vídeo e URLs de streaming, download e thumbnail

**Setup:** `Test.createTestingModule({ imports: [AppModule] }).compile()` with the same global pipe and filters as `main.ts`. `beforeEach`: `cleanAllTables(dataSource)`, then register + confirm + log in an owner and a second user (helper from `test/auth.e2e-spec.ts`). Helper `seedReadyVideo(owner)` creates a `ready` video without running the worker:
1. Inserts a `videos` row in the owner's channel: `processing_status = 'ready'`, `original_file_name = 'aula final.mp4'`, `content_type = 'video/mp4'`, `size_bytes` = fixture size, `duration = 2.0`, `width = 320`, `height = 240`, `container = 'mp4'`, `video_codec = 'h264'`, `audio_codec = 'aac'`.
2. Uploads `test/fixtures/media/h264-aac.mp4` to `videos/{id}/original` and a JPEG to `videos/{id}/thumbnail.jpg`, using `StorageService.putObject`.

Helper `seedVideo(owner, processingStatus)` inserts rows in `processing` / `failed`. Test env: `STORAGE_BUCKET` = test bucket; `STORAGE_PUBLIC_ENDPOINT=http://minio:9000`; `MEDIA_URL_EXPIRES_SECONDS=5`, so the expiry scenario runs fast.

#### 1.1. detalhe-do-video-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId como owner, num vídeo `ready`
    - expect: status `200` com `publicId`, `status: "draft"`, `processingStatus: "ready"`, `failureReason: null`
    - expect: `duration: 2`, `width: 320`, `height: 240`, `container: "mp4"`, `videoCodec: "h264"`, `audioCodec: "aac"`, `originalFileName: "aula final.mp4"`
    - expect: o corpo não contém `id`, `upload_id`/`uploadId` nem `part_size`/`partSize`
  2. GET /videos/:publicId num vídeo `processing`
    - expect: status `200` com `processingStatus: "processing"` e metadados `null`

#### 1.2. stream-url-com-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/stream como owner
    - expect: status `200` com `url` string e `expiresAt` ISO-8601 no futuro
  2. HTTP `GET` na `url` com header `Range: bytes=0-1023`
    - expect: status `206`, header `Content-Range: bytes 0-1023/<fixture size>` e corpo de 1024 bytes iguais aos primeiros 1024 bytes da fixture

#### 1.3. download-url-como-anexo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/download como owner
    - expect: status `200` com `{ url, expiresAt }`
  2. HTTP `GET` na `url`
    - expect: status `200`, e o header `Content-Disposition` começa com `attachment` e contém `filename="aula final.mp4"`
    - expect: o corpo tem o tamanho da fixture

#### 1.4. thumbnail-url-entrega-jpeg

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/thumbnail como owner
    - expect: status `200` com `{ url, expiresAt }`
  2. HTTP `GET` na `url`
    - expect: status `200`, `Content-Type: image/jpeg` e corpo começando com os bytes `FF D8`

#### 1.5. midia-indisponivel-antes-de-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/stream, /download e /thumbnail num vídeo `processing`
    - expect: as três retornam `409` com `error: "VIDEO_NOT_READY"`
  2. As mesmas três rotas num vídeo `failed` (`failure_reason = 'unsupported_format'`)
    - expect: as três retornam `409` com `error: "VIDEO_NOT_READY"`

#### 1.6. acesso-somente-do-owner

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. Com o token do segundo usuário, as quatro rotas `GET` sobre o vídeo `ready` do owner
    - expect: as quatro retornam `404` com `error: "VIDEO_NOT_FOUND"`
  2. As quatro rotas sem `Authorization`
    - expect: `401`
  3. As quatro rotas como owner sobre um `publicId` inexistente
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`, com o mesmo corpo do passo 1

#### 1.7. url-expira

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-24T21:23:47Z

**Steps:**
  1. GET /videos/:publicId/stream como owner
    - expect: `expiresAt` cerca de 5 s no futuro
  2. Aguardar até 2 s depois de `expiresAt` e fazer HTTP `GET` na `url`
    - expect: status `403` (assinatura expirada)
