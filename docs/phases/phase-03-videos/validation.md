---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-24T17:24:33-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-24T17:21:42-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "next-frontend deferred, but inherited OpenAPI sync TDs force FE re-sync"
    resolved_by: clarification
  - id: AMB-1
    status: resolved
    summary: "\"sem impacto na performance\" has no operational/testable definition"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Draft pre-registration fields and Phase 03/04 boundary unspecified"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Processing outputs underspecified: which metadata, which thumbnail frame"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "No TD on accepted input formats/validation and transcoding stance"
    resolved_by: phase-03-videos/TD-18
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Message Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large-file Upload Protocol (10GB)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Part Sizing and Presigned-URL Issuance"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Local S3-compatible Storage Server Image"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Bucket and Object-key Layout"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Presigned-URL Host Topology"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Processing Trigger"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Media Access Strategy for ffprobe/FFmpeg"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — FFmpeg Integration Library and Binary Source"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Video Status Model"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Processing Failure and Retry Policy"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Abandoned and Incomplete Uploads"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Unique Public Video Identifier"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-16
    status: resolved
    summary: "TD-16 pending — Access Policy for Stream and Download in Phase 03"
    resolved_by: phase-03-videos/TD-16
  - id: OQ-17
    status: resolved
    summary: "TD-17 pending — Test Strategy for Storage, Queue and Worker"
    resolved_by: phase-03-videos/TD-17
  - id: OQ-18
    status: resolved
    summary: "TD-18 pending — Accepted Input Formats, Validation and Transcoding Stance"
    resolved_by: phase-03-videos/TD-18
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(No `## UI Inventory` in context.md — UI not in scope for this phase; Check 7 not applicable.)_

## Resolved Issues

- **IC-1** _(resolved_by clarification)_ — next-frontend deferred, but inherited OpenAPI sync TDs force FE re-sync. Chosen: (a) keep video UI deferred; the mechanical contract re-sync (backend `openapi.json` + repo-root sync script → `next-frontend/openapi.json` + `types.gen.ts`) is a Phase 03 deliverable, no FE source changes. Persisted as a Revisions entry on phase-03-videos/TD-17.
- **AMB-1** _(resolved_by clarification)_ — "sem impacto na performance" pinned: API never receives/buffers file bytes; API memory and request time independent of file size; >10 GiB rejected at initiate before any part URL; worker reads only needed byte ranges. Persisted as a Revisions entry on phase-03-videos/TD-02.
- **AMB-2** _(resolved_by clarification)_ — Draft fields: `fileName`, `size`, `contentType`, optional `title` (defaults to file name without extension), channel from JWT; Phase 03 owns transitions up to `ready | failed`, draft → published is Phase 04. Persisted as a Revisions entry on phase-03-videos/TD-11.
- **AMB-3** _(resolved_by clarification)_ — Persist duration, width, height, size_bytes, container, video_codec, audio_codec (nullable); thumbnail at 10% of duration (first frame if < 1s), JPEG 1280px wide. Persisted as a Revisions entry on phase-03-videos/TD-10.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Message Queue Technology. Decided: A (BullMQ + Redis).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Large-file Upload Protocol (10GB). Decided: A (S3 multipart with presigned part URLs).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Part Sizing and Presigned-URL Issuance. Decided: A (fixed server part size + on-demand presign batches).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Local S3-compatible Storage Server Image. Decided: A (`pgsty/minio`, pinned tag).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Bucket and Object-key Layout. Decided: A (single private bucket, per-video prefix).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Presigned-URL Host Topology (internal vs public endpoint). Decided: A (internal client + public signing client).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Processing Trigger. Decided: A (API `complete` enqueues the job).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Video Worker Runtime Topology. Decided: A (separate service, same codebase/image, standalone Nest context).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Media Access Strategy for ffprobe/FFmpeg. Decided: B (presigned GET with HTTP range reads).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — FFmpeg Integration Library and Binary Source. Decided: A (distro ffmpeg + typed `spawn` wrapper).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Video Status Model. Decided: B (`status` draft + `processing_status` pipeline).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Processing Failure and Retry Policy. Decided: A (bounded retries + backoff, then failed with reason).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Abandoned and Incomplete Uploads. Decided: A (abort endpoint + storage-level expiry).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Unique Public Video Identifier. Decided: B (`crypto.randomBytes` base64url, UNIQUE + retry).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 pending — Streaming and Download Delivery. Decided: A (presigned GET URLs returned as JSON).
- **OQ-16** _(resolved_by phase-03-videos/TD-16)_ — TD-16 pending — Access Policy for Stream and Download in Phase 03. Decided: A (owner-only).
- **OQ-17** _(resolved_by phase-03-videos/TD-17)_ — TD-17 pending — Test Strategy for Storage, Queue and Worker. Decided: A (real Compose services, namespaced, in-process processor).
- **OQ-18** _(resolved_by phase-03-videos/TD-18)_ — TD-18 pending — Accepted Input Formats, Validation and Transcoding Stance. Decided: A (browser-playable MP4/WebM allowlist, ffprobe-verified, no transcoding).
- **MD-1** _(resolved_by phase-03-videos/TD-18)_ — No TD on accepted input formats/validation and transcoding stance. Closed by `/research` adding TD-18 (allowlist, initiate vs. worker `ffprobe` validation, transcoding stance) to the phase-scope doc; the decision itself is tracked as OQ-18.
