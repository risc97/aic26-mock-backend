# AIC26 Mock API Server

Mock implementation of the backend

## What is mocked

- Video files are served from `data/videos` with HTTP range support.
- Keyframes are deterministic mock records and return generated JPEG placeholders.
- OCR and transcript text use Lorem Ipsum-style mock text.
- Semantic/exact/temporal/detection/similarity queries return deterministic mock results; no ML model is executed.
- Requests are recorded in an in-memory log store exposed through `/logs`.

## Add your videos

Put your video files under `data` folder

The API accepts `.mp4` and `.webm` and can be configured

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

## Deploy
```bash
docker compose up -d --build
```

Default URL: `http://localhost:3000`

## Useful endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | `GET` | Check API health status |
| `/video/{video_id}` | `GET` | Stream or download a video file with HTTP range support |
| `/keyframe/{video_id}/keyframes` | `GET` | List keyframes for a video within an optional time range (`start_ms`, `end_ms`) |
| `/keyframe/{video_id}/{keyframe_id}` | `GET` | Retrieve a generated JPEG keyframe image |
| `/query/keyframe` | `POST` | Perform keyframe text/semantic query |
| `/query/transcript/semantic` | `POST` | Perform semantic search on transcript texts |
| `/query/transcript/exact` | `POST` | Perform exact/fuzzy text search on transcripts |
| `/query/ocr` | `POST` | Query OCR text extracted from video frames |
| `/query/temporal` | `POST` | Perform multi-stage temporal query across video segments |
| `/query/detect` | `POST` | Detect visual objects in frames based on text phrase queries and spatial constraints |
| `/query/temporal/detect` | `POST` | Perform combined temporal and object detection queries |
| `/similar/{video_id}/{keyframe_id}` | `GET` | Find visually similar keyframes for a given keyframe |
| `/similar/upload` | `POST` | Upload an image file to find visually similar keyframes |
| `/logs` | `GET` | Retrieve the in-memory log of recent API requests |
| `/logs/{request_id}` | `GET` | Retrieve details for a specific recorded request |

The endpoint shapes, response property names, enums, defaults, and major validation constraints follow the OpenAPI of the actual backend server
