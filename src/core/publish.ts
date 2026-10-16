// Meta (Facebook Page + Instagram) publishing rules. Pure functions: no DB, no network.
//
// n8n makes every Graph API call with its `meta-graph` credential; tn-core decides which call
// comes next and what a response means. A publication moves through phases:
//
//   facebook   fb_publish ─► fb_permalink ─► done
//   instagram  [ig_stage ─► ig_stage_url] ─► ig_container ─► ig_status ─► ig_publish ─► ig_permalink ─► done
//
// ig_stage uploads the image to the Page as an UNPUBLISHED photo so Instagram can fetch it from
// Facebook's CDN. It is skipped when the media store has a public https URL (R2 in production).
// The two publishing calls (fb_publish, ig_publish) are not idempotent: an ambiguous result
// (timeout, 5xx) goes to `reconciling`, and the platform is queried before anything is retried.
import { composeCaption } from '../../scripts/lib/content.mjs';

export type Phase =
  | 'fb_publish' | 'fb_permalink' | 'fb_reconcile'
  | 'ig_stage' | 'ig_stage_url' | 'ig_container' | 'ig_status' | 'ig_publish' | 'ig_permalink'
  | 'ig_reconcile_status' | 'ig_reconcile_media';

/** What n8n must execute next. `upload_*` steps need the image bytes (GET /v1/publish/media). */
export type Step =
  | { kind: 'graph_get'; phase: Phase; url: string }
  | { kind: 'graph_post'; phase: Phase; url: string; body: Record<string, string> }
  | { kind: 'upload_publish'; phase: Phase; url: string; message: string }
  | { kind: 'upload_stage'; phase: Phase; url: string };

/** Non-idempotent phases: an unknown outcome must be reconciled, never blindly retried. */
export const PUBLISHING_PHASES: ReadonlySet<Phase> = new Set(['fb_publish', 'ig_publish']);

export interface MetaConfig {
  graphBaseUrl: string;
  graphVersion: string;
  pageId: string | null;
  igUserId: string | null;
}

/** State persisted in platform_publications.response_meta between steps and runs. */
export interface PubState {
  phase?: Phase;
  staged_photo_id?: string;
  image_url?: string;
  media_id?: string;
  fb_post_id?: string;
  fb_photo_id?: string;
  status_checks?: number;
}

export const INSTAGRAM_CAPTION_MAX = 2200;
export const INSTAGRAM_HASHTAG_MAX = 30;

export function graphUrl(m: MetaConfig, path: string, query: Record<string, string> = {}): string {
  const u = new URL(`${m.graphBaseUrl.replace(/\/$/, '')}/${m.graphVersion}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

/** The published text, identical on both platforms (Derja first, English second, hashtags last). */
export function postText(p: { captionDerja: string | null; captionEn: string | null; hashtags: string[]; disclosureDerja: string | null; disclosureEn: string | null }): string {
  if (!p.captionDerja || !p.captionEn || !p.disclosureDerja || !p.disclosureEn) throw new Error('post text is incomplete');
  return composeCaption({ caption_derja: p.captionDerja, caption_en: p.captionEn, hashtags: p.hashtags }, { derja: p.disclosureDerja, en: p.disclosureEn });
}

/** Instagram-specific limits the caption gates do not cover. Returns problems (empty = ok). */
export function instagramProblems(text: string): string[] {
  const problems: string[] = [];
  if ([...text].length > INSTAGRAM_CAPTION_MAX) problems.push(`caption is ${[...text].length} characters (Instagram max ${INSTAGRAM_CAPTION_MAX})`);
  const tags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length > INSTAGRAM_HASHTAG_MAX) problems.push(`${tags.length} hashtags (Instagram max ${INSTAGRAM_HASHTAG_MAX})`);
  return problems;
}

/** Whitespace/Unicode-insensitive comparison used to find our own post during reconciliation. */
export const sameText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.normalize('NFC').replace(/\s+/g, ' ').trim() === b.normalize('NFC').replace(/\s+/g, ' ').trim();

/** True when the media store URL is reachable by Meta (https and not a local host). */
export function isPublicUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(u.hostname) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

// ── Graph responses ─────────────────────────────────────────────────────────

/**
 * What n8n reports back for one step: a Graph HTTP response, a transport failure on the Graph
 * call (timeout, DNS…: outcome unknown), or a local failure before Graph was called (e.g. the
 * image download from tn-core: nothing reached Meta, safe to retry).
 */
export type StepResult =
  | { status: number; body: unknown }
  | { transport_error: string }
  | { local_error: string };

export type Classified =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: 'transient' | 'permanent' | 'ambiguous' | 'auth'; code: string; message: string; httpStatus: number | null };

// Graph error codes that mean "try again later": API too busy / rate limits / temporary,
// and 9007 (Instagram: media not ready for publishing yet).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613, 9007, 80001, 80002, 80005, 80008]);
const AUTH_CODES = new Set([10, 102, 190, 200, 210, 220, 230, 270, 299]);

export function classify(r: StepResult): Classified {
  if ('local_error' in r) return { ok: false, kind: 'transient', code: 'local', message: r.local_error.slice(0, 500), httpStatus: null };
  if ('transport_error' in r) return { ok: false, kind: 'ambiguous', code: 'transport', message: r.transport_error.slice(0, 500), httpStatus: null };
  const body = (typeof r.body === 'object' && r.body !== null ? r.body : { raw: String(r.body ?? '') }) as Record<string, unknown>;
  const err = body.error as { message?: string; code?: number; error_subcode?: number; is_transient?: boolean; type?: string } | undefined;
  if (r.status >= 200 && r.status < 300 && !err) return { ok: true, body };
  const code = err?.code ?? null;
  const label = code !== null ? `graph_${code}${err?.error_subcode ? `_${err.error_subcode}` : ''}` : `http_${r.status}`;
  const message = (err?.message ?? `HTTP ${r.status}`).slice(0, 500);
  if (r.status >= 500 && !err) return { ok: false, kind: 'ambiguous', code: label, message, httpStatus: r.status };
  if (err?.is_transient || (code !== null && TRANSIENT_CODES.has(code)) || r.status === 429) return { ok: false, kind: 'transient', code: label, message, httpStatus: r.status };
  if ((code !== null && AUTH_CODES.has(code)) || err?.type === 'OAuthException' || r.status === 401 || r.status === 403) return { ok: false, kind: 'auth', code: label, message, httpStatus: r.status };
  if (r.status >= 500) return { ok: false, kind: 'ambiguous', code: label, message, httpStatus: r.status };
  return { ok: false, kind: 'permanent', code: label, message, httpStatus: r.status };
}

/** Largest rendition of an uploaded Page photo (`GET /{photo}?fields=images`). */
export function largestImageSource(body: Record<string, unknown>): string | null {
  const images = Array.isArray(body.images) ? (body.images as { source?: string; width?: number }[]) : [];
  const best = images.filter((i) => typeof i.source === 'string').sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.source ?? null;
}

/** Exponential backoff for transient failures: 2, 4, 8 … minutes, capped at 30. */
export const backoffMinutes = (attempt: number): number => Math.min(30, 2 ** Math.max(1, attempt));

// ── Steps ──────────────────────────────────────────────────────────────────

export function stepFor(phase: Phase, m: MetaConfig, ctx: { text: string; altText: string; state: PubState; containerId: string | null; since: number }): Step {
  const page = m.pageId!;
  const ig = m.igUserId!;
  switch (phase) {
    case 'fb_publish':
      return { kind: 'upload_publish', phase, url: graphUrl(m, `${page}/photos`), message: ctx.text };
    case 'fb_permalink':
      return { kind: 'graph_get', phase, url: graphUrl(m, ctx.state.fb_post_id!, { fields: 'id,permalink_url' }) };
    case 'fb_reconcile':
      return { kind: 'graph_get', phase, url: graphUrl(m, `${page}/published_posts`, { fields: 'id,message,created_time,permalink_url', since: String(ctx.since), limit: '25' }) };
    case 'ig_stage':
      return { kind: 'upload_stage', phase, url: graphUrl(m, `${page}/photos`) };
    case 'ig_stage_url':
      return { kind: 'graph_get', phase, url: graphUrl(m, ctx.state.staged_photo_id!, { fields: 'images' }) };
    case 'ig_container':
      return { kind: 'graph_post', phase, url: graphUrl(m, `${ig}/media`), body: { image_url: ctx.state.image_url!, caption: ctx.text, alt_text: ctx.altText } };
    case 'ig_status':
    case 'ig_reconcile_status':
      return { kind: 'graph_get', phase, url: graphUrl(m, ctx.containerId!, { fields: 'status_code' }) };
    case 'ig_publish':
      return { kind: 'graph_post', phase, url: graphUrl(m, `${ig}/media_publish`), body: { creation_id: ctx.containerId! } };
    case 'ig_permalink':
      return { kind: 'graph_get', phase, url: graphUrl(m, ctx.state.media_id!, { fields: 'id,permalink' }) };
    case 'ig_reconcile_media':
      return { kind: 'graph_get', phase, url: graphUrl(m, `${ig}/media`, { fields: 'id,caption,permalink,timestamp', limit: '25' }) };
  }
}

/** Where a fresh (or resumed) attempt starts, from what earlier attempts left behind. */
export function startPhase(platform: 'facebook' | 'instagram', s: { reconciling: boolean; state: PubState; containerId: string | null; publicImageUrl: string | null }): Phase {
  if (platform === 'facebook') return s.reconciling ? 'fb_reconcile' : 'fb_publish';
  if (s.reconciling) return s.containerId ? 'ig_reconcile_status' : 'ig_reconcile_media';
  if (s.containerId) return 'ig_status';
  if (s.publicImageUrl || s.state.image_url) return 'ig_container';
  return 'ig_stage';
}
