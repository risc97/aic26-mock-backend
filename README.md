# AIC26 Mock API Server (TypeScript)

Mock implementation of the uploaded `AIC26 - Backend` OpenAPI contract.

## What is mocked

- Video files are served from `data/videos` with HTTP range support.
- Three video slots are recognized by default: `L21_V005`, `L21_V006`, `L21_V007`.
- Keyframes are deterministic mock records and return generated JPEG placeholders.
- OCR and transcript text use Lorem Ipsum-style mock text.
- Semantic/exact/temporal/detection/similarity queries return deterministic mock results; no ML model is executed.
- Requests are recorded in an in-memory log store exposed through `/logs`.

## Add your three videos

Put your files here and rename them to:

```text
data/videos/L21_V005.webm
data/videos/L21_V006.webm
data/videos/L21_V007.webm
```

The API also accepts `.mp4`, `.mkv`, and `.mov` if configured through `VIDEO_EXTENSIONS`.

## Run

```bash
npm install
npm run dev
```

Production-style run:

```bash
npm run build
npm start
```

Default URL: `http://localhost:3000`

## Useful endpoints

- `GET /health`
- `GET /video/:video_id`
- `GET /keyframe/:video_id/keyframes?start_ms=0&end_ms=60000`
- `GET /keyframe/:video_id/:keyframe_id`
- `POST /query/keyframe`
- `POST /query/transcript/semantic`
- `POST /query/transcript/exact`
- `POST /query/ocr`
- `POST /query/temporal`
- `POST /query/detect`
- `POST /query/temporal/detect`
- `GET /similar/:video_id/:keyframe_id?model=siglip2&limit=100`
- `POST /similar/upload?model=siglip2&limit=100`
- `GET /logs?limit=50&offset=0`
- `GET /logs/:request_id`

The endpoint shapes, response property names, enums, defaults, and major validation constraints follow the OpenAPI `openapi.json`
