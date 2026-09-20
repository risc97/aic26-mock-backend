import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();
const VIDEO_DIR = path.join(ROOT, 'data', 'videos');
const KEYFRAME_DIR = path.join(ROOT, 'data', 'keyframes', 'generated');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(KEYFRAME_DIR, { recursive: true });

type SimilarModel = 'siglip' | 'siglip2' | 'pe';
type QueryModel = SimilarModel | 'gte' | 'owlv2-base' | 'owlv2-large';
type LogMode = 'keyframe' | 'transcript_semantic' | 'transcript_exact' | 'ocr_exact' | 'temporal' | 'detect' | 'temporal_detect';

type Item = { keyframe_id: string; video_id: string; timestamp_ms: number; frame_idx: number; video_fps: number; score?: number | null };
type OcrItem = Item & { score: number; text: string };
type TranscriptItem = { video_id: string; transcript_id: string; text: string; time_start_ms: number; time_end_ms: number; keyframes: Item[] };
type TemporalMatch = Item & { score: number; stage: number; query: string; rank: number };
type TemporalItem = { rank: number; video_id: string; score: number; length: number; matches?: TemporalMatch[]; skipped_stages?: number[] };
type LogEntry = { request_id: string; timestamp: string; query: string; limit: number; mode: LogMode; model?: QueryModel | null; results: unknown[]; total: number };

type VideoInfo = { id: string; fps: number; durationMs: number; ext: string };

const VIDEOS: VideoInfo[] = [
  { id: 'L21_V005', fps: 30, durationMs: (15*60+43)*1000, ext: '.webm' },
  { id: 'L21_V006', fps: 30, durationMs: (17*60+15)*1000, ext: '.webm' },
  { id: 'L21_V007', fps: 30, durationMs: 14*60*1000, ext: '.webm' },
];

const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.',
  'Curabitur blandit tempus porttitor praesent commodo cursus magna.',
];

const logs: LogEntry[] = [];
const cache = new Map<string, Promise<Buffer>>();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function requestId() { return `req_${crypto.randomUUID()}`; }
function hashNumber(value: string) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0);
}
function randomFromSeed(seed: string) {
  let value = hashNumber(seed);

  return () => {
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    value ^= value >>> 16;
    return (value >>> 0) / 0x100000000;
  };
}

function colorfulKeyframeSvg(videoId: string, keyframeId: string) {
  const random = randomFromSeed(`${videoId}:${keyframeId}`);
  const color = () => Math.floor(random() * 256);
  const x = () => Math.floor(random() * 260) + 30;
  const y = () => Math.floor(random() * 170) + 30;
  const size = () => Math.floor(random() * 90) + 30;

  const background = `rgb(${color()}, ${color()}, ${color()})`;
  const shapes = Array.from({ length: 5 }, (_, index) => {
    const fill = `rgb(${color()}, ${color()}, ${color()})`;

    if (index % 3 === 0) {
      return `<circle cx="${x()}" cy="${y()}" r="${size() / 2}" fill="${fill}" />`;
    }

    if (index % 3 === 1) {
      return `<rect x="${x()}" y="${y()}" width="${size()}" height="${size()}"
        rx="${Math.floor(random() * 20)}" fill="${fill}"
        transform="rotate(${Math.floor(random() * 90)} ${x()} ${y()})" />`;
    }

    return `<polygon points="${x()},${y()} ${x()},${y()} ${x()},${y()}"
      fill="${fill}" />`;
  }).join('\n');

  return `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="${background}" />
      ${shapes}
      <text x="20" y="335"
            font-family="monospace"
            font-size="20"
            fill="white"
            font-weight="bold">
        ${videoId} / ${keyframeId}
      </text>
    </svg>
  `;
}

async function keyframeImageBuffer(videoId: string, keyframeId: string) {
  const cacheKey = `${videoId}:${keyframeId}`;
  const existing = cache.get(cacheKey);

  if (existing) return existing;

  const generation = sharp(
    Buffer.from(colorfulKeyframeSvg(videoId, keyframeId)),
  )
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  cache.set(cacheKey, generation);
  return generation;
}

async function ensureKeyframeImage(videoId: string, keyframeId: string) {
  const filename = `${videoId}_${keyframeId}.jpg`;
  const filePath = path.join(KEYFRAME_DIR, filename);

  if (!fs.existsSync(filePath)) {
    const image = await keyframeImageBuffer(videoId, keyframeId);
    await fs.promises.writeFile(filePath, image);
  }

  return filePath;
}
function scoreFor(...parts: string[]) { return 0.45 + (hashNumber(parts.join('|')) % 5000) / 10000; }
function lorem(seed: number) { return LOREM[seed % LOREM.length]; }
function videoFor(id: string) { return VIDEOS.find(v => v.id === id); }
function keyframesFor(video: VideoInfo): Item[] {
  const everyMs = 2677;
  const count = Math.ceil(video.durationMs / everyMs);
  return Array.from({ length: count }, (_, i) => ({
    keyframe_id: `${String(i + 1).padStart(4, '0')}`,
    video_id: video.id,
    timestamp_ms: Math.min(i * everyMs, video.durationMs - 1),
    frame_idx: Math.floor((Math.min(i * everyMs, video.durationMs - 1) / 1000) * video.fps),
    video_fps: video.fps,
  }));
}
function keyframeById(videoId: string, keyframeId: string) {
  const video = videoFor(videoId);
  return video ? keyframesFor(video).find(k => k.keyframe_id === keyframeId) : undefined;
}
function nearestKeyframes(video: VideoInfo, start: number, end: number) {
  return keyframesFor(video).filter(k => k.timestamp_ms >= start && k.timestamp_ms <= end);
}
function queryTokens(q: string) { return q.toLowerCase().split(/[^a-z0-9À-ỹ]+/i).filter(Boolean); }
function matchesText(text: string, query: string, phrase: boolean) {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return false;
  if (phrase) return t.includes(q);
  return queryTokens(q).every(tok => t.includes(tok));
}
function paged<T>(items: T[], limit = 100) { return items.slice(0, Math.max(1, limit)); }
function addLog(input: Omit<LogEntry, 'request_id' | 'timestamp'>) {
  const entry: LogEntry = { ...input, request_id: requestId(), timestamp: new Date().toISOString() };
  logs.unshift(entry);
  if (logs.length > 100) logs.length = 100;
  return entry;
}

function contentTypeFor(ext: string) {
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  return 'application/octet-stream';
}
function videoPath(video: VideoInfo) {
  const preferred = path.join(VIDEO_DIR, `${video.id}${video.ext}`);
  if (fs.existsSync(preferred)) return preferred;
  for (const ext of ['.webm', '.mp4', '.mov', '.mkv']) {
    const p = path.join(VIDEO_DIR, `${video.id}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function validateLimit(value: unknown, fallback = 100, max?: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || (max !== undefined && n > max)) throw new ValidationError('limit must be a positive integer');
  return n;
}
class ValidationError extends Error { status = 422; }
function jsonError(res: Response, status: number, message: string) {
  res.status(status).json({ detail: [{ loc: [], msg: message, type: 'value_error' }] });
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/video/:video_id', (req, res) => {
  const video = videoFor(req.params.video_id);
  if (!video) return res.status(404).send('Not found');
  const p = videoPath(video);
  if (!p) return res.status(404).send('Video file not found. Add it under data/videos.');
  const stat = fs.statSync(p);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentTypeFor(path.extname(p)));
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(p).pipe(res);
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return res.status(416).end();
  const start = Number(match[1] || 0);
  const end = Math.min(Number(match[2] || stat.size - 1), stat.size - 1);
  if (start > end || start >= stat.size) return res.status(416).end();
  res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(p, { start, end }).pipe(res);
});

app.head('/video/:video_id', (req, res) => {
  const video = videoFor(req.params.video_id);
  if (!video) return res.status(404).end();
  const p = videoPath(video);
  if (!p) return res.status(404).end();
  const stat = fs.statSync(p);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentTypeFor(path.extname(p)));
  res.setHeader('Content-Length', stat.size);
  res.end();
});

app.get('/keyframe/:video_id/keyframes', (req, res) => {
  const video = videoFor(req.params.video_id);
  if (!video) return res.status(404).send('Not found');
  const start = req.query.start_ms === undefined ? 0 : Number(req.query.start_ms);
  const end = req.query.end_ms === undefined ? video.durationMs : Number(req.query.end_ms);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) return jsonError(res, 422, 'start_ms and end_ms must be non-negative integers');
  const keyframes = nearestKeyframes(video, start, end);
  res.json({ video_id: video.id, total: keyframes.length, keyframes });
});

app.head('/keyframe/:video_id/:keyframe_id', (req, res) => {
  const keyframe = keyframeById(
    req.params.video_id,
    req.params.keyframe_id,
  );

  if (!keyframe) return res.status(404).end();

  res.type('jpeg').end();
});
app.get('/keyframe/:video_id/:keyframe_id', async (req, res, next) => {
  try {
    const { video_id: videoId, keyframe_id: keyframeId } = req.params;
    const keyframe = keyframeById(videoId, keyframeId);

    if (!keyframe) return res.status(404).send('Not found');

    const filePath = await ensureKeyframeImage(videoId, keyframeId);

    res.type('jpeg').sendFile(path.resolve(filePath));
  } catch (error) {
    next(error);
  }
});

app.post('/query/keyframe', async (req, res) => {
  const { query } = req.body ?? {};
  if (typeof query !== 'string') return jsonError(res, 422, 'query is required');
  const randomDelay = Math.floor(Math.random() * 800) + 200;
  await delay(randomDelay);
  const limit = validateLimit(req.body.limit, 100);
  const model: SimilarModel = ['siglip', 'siglip2', 'pe'].includes(req.body.model) ? req.body.model : 'siglip2';
  const all = VIDEOS.flatMap(v => keyframesFor(v).map(k => ({ ...k, score: scoreFor(query, k.keyframe_id, model) })));
  all.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const results = paged(all, limit);
  const entry = addLog({ query, limit, mode: 'keyframe', model, results, total: all.length });
  res.json({ request_id: entry.request_id, mode: 'keyframe', model, total: all.length, results });
});

function transcriptResults(query: string, limit: number, semantic: boolean) {
  const out: TranscriptItem[] = [];
  for (const video of VIDEOS) {
    const kfs = keyframesFor(video);
    for (let i = 0; i < Math.ceil(video.durationMs / 15000); i++) {
      const start = i * 15000;
      const text = `${lorem(i + video.id.length)} ${lorem(i + 2)}`;
      if (!semantic && !matchesText(text, query, Boolean(false))) continue;
      if (semantic || matchesText(text, query, false)) {
        const keyframes = nearestKeyframes(video, start, Math.min(start + 15000, video.durationMs)).slice(0, 3);
        out.push({ video_id: video.id, transcript_id: `${video.id}-tr-${String(i + 1).padStart(4, '0')}`, text, time_start_ms: start, time_end_ms: Math.min(start + 15000, video.durationMs), keyframes });
      }
    }
  }
  return out.map((x, i) => semantic ? ({ ...x, _score: scoreFor(query, x.transcript_id) }) : x);
}

app.post('/query/transcript/semantic', async (req, res) => {
  if (typeof req.body?.query !== 'string') return jsonError(res, 422, 'query is required');
  const randomDelay = Math.floor(Math.random() * 800) + 200;
  await delay(randomDelay);
  const query = req.body.query; const limit = validateLimit(req.body.limit); const model = 'gte' as const;
  const raw = transcriptResults(query, limit, true) as (TranscriptItem & { _score?: number })[];
  raw.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  const results = raw.slice(0, limit).map(({ _score, ...x }) => x);
  const total = raw.length; const entry = addLog({ query, limit, mode: 'transcript_semantic', model, results, total });
  res.json({ request_id: entry.request_id, mode: 'transcript_semantic', model, total, results });
});

app.post('/query/transcript/exact', async (req, res) => {
  if (typeof req.body?.query !== 'string') return jsonError(res, 422, 'query is required');
  const randomDelay = Math.floor(Math.random() * 800) + 200;
  await delay(randomDelay);
  const query = req.body.query; const limit = validateLimit(req.body.limit); const phrase = Boolean(req.body.phrase);
  const results = VIDEOS.flatMap(v => keyframesFor(v).filter((k, i) => matchesText(`${lorem(i + v.id.length)} ${lorem(i + 2)}`, query, phrase)).map((k, i) => ({
    video_id: v.id, transcript_id: `${v.id}-tr-${String(i + 1).padStart(4, '0')}`, text: `${lorem(i + v.id.length)} ${lorem(i + 2)}`,
    time_start_ms: k.timestamp_ms, time_end_ms: Math.min(k.timestamp_ms + 5000, v.durationMs), keyframes: [k]
  })));
  const pagedResults = paged(results, limit); const entry = addLog({ query, limit, mode: 'transcript_exact', model: null, results: pagedResults, total: results.length });
  res.json({ request_id: entry.request_id, mode: 'transcript_exact', model: null, total: results.length, results: pagedResults });
});

app.post('/query/ocr', (req, res) => {
  if (typeof req.body?.query !== 'string') return jsonError(res, 422, 'query is required');
  const query = req.body.query; const limit = validateLimit(req.body.limit); const phrase = Boolean(req.body.phrase);
  const raw: OcrItem[] = VIDEOS.flatMap(v => keyframesFor(v).map((k, i) => ({ ...k, score: scoreFor(query, k.keyframe_id), text: `${lorem(i)} ${lorem(i + 1)}` }))).filter(x => matchesText(x.text, query, phrase));
  const results = paged(raw.sort((a, b) => b.score - a.score), limit); const entry = addLog({ query, limit, mode: 'ocr_exact', model: null, results, total: raw.length });
  res.json({ request_id: entry.request_id, mode: 'ocr_exact', model: null, total: raw.length, results });
});

function temporalFromStages(stages: Array<{ query: string; variants?: string[] }>, limit: number, mode: 'temporal' | 'temporal_detect', model: QueryModel) {
  const targetCount = Math.max(VIDEOS.length, Math.ceil(limit * 3 / 8));
  const results: TemporalItem[] = [];

  for (let i = 0; i < targetCount; i++) {
    const video = VIDEOS[i % VIDEOS.length];
    const offsetIndex = Math.floor(i / VIDEOS.length);
    
    const matches: TemporalMatch[] = stages.map((s, si) => {
      const kfs = keyframesFor(video); 
      const idx = Math.min(kfs.length - 1, si * 3 + offsetIndex); 
      const k = kfs[idx];
      return { 
        ...k, 
        score: scoreFor(s.query, video.id, String(si), String(i)), 
        stage: si, 
        query: s.query, 
        rank: idx + 1 
      };
    });

    results.push({
      rank: i + 1,
      video_id: video.id,
      score: scoreFor(video.id, JSON.stringify(stages), model, String(i)),
      length: stages.length,
      matches,
      skipped_stages: [] as number[]
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

app.post('/query/temporal', async (req, res) => {
  const randomDelay = Math.floor(Math.random() * 800) + 700;
  await delay(randomDelay);
  if (!Array.isArray(req.body?.stages) || req.body.stages.length < 2) return jsonError(res, 422, 'stages must contain at least 2 items');
  const limit = validateLimit(req.body.limit); const model: QueryModel = req.body.model ?? 'siglip2';
  const results = temporalFromStages(req.body.stages, limit, 'temporal', model); const entry = addLog({ query: JSON.stringify(req.body.stages), limit, mode: 'temporal', model, results, total: VIDEOS.length });
  res.json({ mode: 'temporal', results });
});

function buildDetectObjects(req: any) {
  if (!Array.isArray(req?.objects) || req.objects.length < 1) throw new ValidationError('objects must contain at least 1 item');
  return req.objects as Array<{ phrase: string; min_count?: number; min_score?: number; region?: string | null; min_area?: number; max_area?: number }>;
}

app.post('/query/detect', (req, res) => {
  try {
    const objects = buildDetectObjects(req.body); const limit = validateLimit(req.body.limit); const model = (req.body.model ?? 'owlv2-base') as 'owlv2-base' | 'owlv2-large';
    const all: any[] = VIDEOS.flatMap(v => keyframesFor(v).map((k, i) => ({ ...k, score: scoreFor(JSON.stringify(objects), k.keyframe_id), counts: objects.map(() => 1), boxes: objects.map((_, oi) => [[0.1 + oi * 0.1, 0.1, 0.4 + oi * 0.1, 0.4, 0.8]]) })));
    all.sort((a, b) => b.score - a.score); const results = paged(all, limit); const entry = addLog({ query: JSON.stringify(req.body), limit, mode: 'detect', model, results, total: all.length });
    res.json({ request_id: entry.request_id, mode: 'detect', model, total: all.length, results });
  } catch (e) { if (e instanceof ValidationError) return jsonError(res, 422, e.message); throw e; }
});

app.post('/query/temporal/detect', (req, res) => {
  try {
    if (!Array.isArray(req.body?.stages) || req.body.stages.length < 2) throw new ValidationError('stages must contain at least 2 items');
    for (const stage of req.body.stages) buildDetectObjects(stage);
    const limit = validateLimit(req.body.limit); const model = (req.body.model ?? 'owlv2-base') as 'owlv2-base' | 'owlv2-large';
    const stages = req.body.stages.map((s: any, i: number) => ({ query: s.objects.map((o: any) => o.phrase).join(', '), variants: [], stageIndex: i }));
    const results = temporalFromStages(stages, limit, 'temporal_detect', model); const entry = addLog({ query: JSON.stringify(req.body), limit, mode: 'temporal_detect', model, results, total: results.length });
    res.json({ request_id: entry.request_id, mode: 'temporal_detect', model, total: results.length, results });
  } catch (e) { if (e instanceof ValidationError) return jsonError(res, 422, e.message); throw e; }
});

app.get('/similar/:video_id/:keyframe_id', (req, res) => {
  const k = keyframeById(req.params.video_id, req.params.keyframe_id);
  if (!k) return res.status(404).send('Not found');
  const model = (['siglip', 'siglip2', 'pe'].includes(String(req.query.model)) ? req.query.model : 'siglip2') as SimilarModel;
  const limit = validateLimit(req.query.limit, 100);
  const all = VIDEOS.flatMap(v => keyframesFor(v).map(x => ({ ...x, score: scoreFor(k.keyframe_id, x.keyframe_id, model) }))).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  res.json({ video_id: k.video_id, keyframe_id: k.keyframe_id, model, total: all.length, results: paged(all, limit) });
});

app.post('/similar/upload', upload.single('file'), (req, res) => {
  const model = (['siglip', 'siglip2', 'pe'].includes(String(req.query.model)) ? req.query.model : 'siglip2') as SimilarModel;
  const limit = validateLimit(req.query.limit, 100);
  if (!req.file) return jsonError(res, 422, 'file is required');
  const all = VIDEOS.flatMap(v => keyframesFor(v).map(x => ({ ...x, score: scoreFor(req.file!.originalname, x.keyframe_id, model) }))).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  res.json({ video_id: 'upload', keyframe_id: req.file.originalname, model, total: all.length, results: paged(all, limit) });
});

app.get('/logs', (req, res) => {
  const limit = validateLimit(req.query.limit, 50, 500); const offset = Number(req.query.offset ?? 0);
  res.json(logs.slice(offset, offset + limit));
});
app.get('/logs/:request_id', (req, res) => {
  const found = logs.find(x => x.request_id === req.params.request_id);
  if (!found) return res.status(404).send('Not found');
  res.json(found);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ValidationError) return jsonError(res, 422, err.message);
  console.error(err);
  res.status(500).json({ detail: 'Internal mock server error' });
});

app.listen(PORT, () => {
  console.log(`AIC26 mock API listening on http://localhost:${PORT}`);
  console.log(`Video files: ${VIDEO_DIR}`);
});
