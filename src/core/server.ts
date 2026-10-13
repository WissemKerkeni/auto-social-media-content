// tn-core HTTP API (internal; called by n8n with a bearer token).
//   GET  /healthz
//   POST /v1/production/prepare        { slot_id, worker }
//   POST /v1/production/image-request  { slot_id, worker, post_id, prompt_text }
//   POST /v1/production/ingest-image   { slot_id, worker, post_id, response, prompt_version, audit_prompt_text }
//   POST /v1/production/apply-audit    { slot_id, worker, post_id, response }
//   POST /v1/production/caption-request{ slot_id, worker, post_id, system_prompt_text, request_prompt_text }
//   POST /v1/production/apply-caption  { slot_id, worker, post_id, response, prompt_version }
//   POST /v1/production/schedule       { slot_id, worker, post_id }
//   POST /v1/production/park           { slot_id, worker, post_id?, outcome, stage, reason, details? }
// Logs are one JSON object per line; request bodies (images, prompts) are never logged.
import 'dotenv/config';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.ts';
import { createPrisma } from '../db.ts';
import { HttpError, ProductionService } from './service.ts';

const MAX_BODY = 25 * 1024 * 1024;

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, service: 'tn-core', ...extra }));

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', `body exceeds ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'bad_json', 'body must be a JSON object');
  }
}

export function createServer() {
  const cfg = loadConfig();
  const db = createPrisma(cfg.databaseUrl);
  const svc = new ProductionService(db, cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: Record<string, (b: any) => Promise<unknown>> = {
    '/v1/production/prepare': (b) => svc.prepare(b),
    '/v1/production/image-request': (b) => svc.imageRequest(b),
    '/v1/production/ingest-image': (b) => svc.ingestImage(b),
    '/v1/production/apply-audit': (b) => svc.applyAudit(b),
    '/v1/production/caption-request': (b) => svc.captionRequest(b),
    '/v1/production/apply-caption': (b) => svc.applyCaption(b),
    '/v1/production/schedule': (b) => svc.schedule(b),
    '/v1/production/park': (b) => svc.park(b),
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', { method: req.method, path, status, ms: Date.now() - started });
    };
    try {
      if (req.method === 'GET' && path === '/healthz') {
        await db.$queryRaw`SELECT 1`;
        return send(200, { ok: true });
      }
      const handler = routes[path];
      if (!handler || req.method !== 'POST') return send(404, { error: 'not_found' });
      if (!authorized(req.headers.authorization, cfg.token)) return send(401, { error: 'unauthorized' });
      const body = await readJson(req);
      return send(200, await handler(body));
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.code, message: err.message });
      log('error', 'unhandled', { path, error: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 4).join(' | ') });
      return send(500, { error: 'internal', message: (err as Error).message });
    }
  });
  return { server, cfg, db };
}
