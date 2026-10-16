// Publishing steps behind the TN-02 workflow (Facebook Page + Instagram; TikTok is not built).
//
//   claim  → pick ONE due publication (kill switch, platform enabled + configured, daily cap,
//            never more than slot_max_lateness_minutes late), lease it, return its first step
//   apply  → n8n reports the Graph response of a step; decide the outcome, return the next step
//   media  → the image bytes for an upload step (n8n streams them to Graph as multipart)
//
// Every apply is fenced by (publication, attempt_no, phase): a duplicate or stale report changes
// nothing. A publication's external effect is recorded the moment Graph confirms it, before any
// follow-up call, so a crash afterwards can never cause a second post.
import type { PrismaClient, PlatformPublication, Prisma } from '../generated/prisma/client.ts';
import type { CoreConfig } from './config.ts';
import { HttpError } from './service.ts';
import { getObject } from '../../scripts/lib/s3.mjs';
import {
  PUBLISHING_PHASES, backoffMinutes, classify, instagramProblems, isPublicUrl, largestImageSource, postText, sameText, startPhase, stepFor,
  type Classified, type Phase, type PubState, type Step, type StepResult,
} from './publish.ts';

type Platform = 'facebook' | 'instagram';
type Json = Record<string, unknown>;
type Outcome = 'published' | 'pending' | 'reconciling' | 'failed' | 'skipped';

const MAX_STEPS_PER_ATTEMPT = 12;
const MAX_STATUS_CHECKS = 5;

export interface ClaimResult {
  action: 'none' | 'step';
  reason?: string;
  publication_id?: string;
  post_id?: string;
  platform?: Platform;
  attempt_no?: number;
  step?: Step;
}
export interface ApplyResult {
  done: boolean;
  outcome?: Outcome;
  publication_id: string;
  attempt_no: number;
  platform?: Platform;
  step?: Step;
  message?: string;
}

export class PublishService {
  constructor(private readonly db: PrismaClient, private readonly cfg: CoreConfig) {}

  // ── config ───────────────────────────────────────────────────────────────

  private async config() {
    const rows = await this.db.appConfig.findMany({
      where: { key: { in: ['publishing_enabled', 'enabled_platforms', 'slot_max_lateness_minutes', 'daily_post_cap', 'publish_max_attempts', 'publish_lease_minutes', 'schedule'] } },
    });
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
    return {
      enabled: v.publishing_enabled === true,
      platforms: Array.isArray(v.enabled_platforms) ? (v.enabled_platforms as string[]) : [],
      lateMin: Number(v.slot_max_lateness_minutes ?? 60),
      dailyCap: Number(v.daily_post_cap ?? 8),
      maxAttempts: Number(v.publish_max_attempts ?? 5),
      leaseMin: Number(v.publish_lease_minutes ?? 10),
      timezone: String((v.schedule as { timezone?: string } | undefined)?.timezone ?? 'Africa/Tunis'),
    };
  }

  /** Platforms tn-core can actually publish to with the configured Meta ids. */
  configuredPlatforms(): Platform[] {
    const m = this.cfg.meta;
    const out: Platform[] = [];
    if (m.pageId) out.push('facebook');
    if (m.igUserId && (m.pageId || isPublicUrl(this.cfg.s3.publicBaseUrl))) out.push('instagram');
    return out;
  }

  // ── claim ────────────────────────────────────────────────────────────────

  async claim(b: { worker: string }): Promise<ClaimResult> {
    if (!b.worker) throw new HttpError(400, 'bad_request', 'worker is required');
    const c = await this.config();
    const now = new Date();

    // 1. Never publish late: queued work past its window is skipped (kill switch or not).
    const late = await this.db.$queryRaw<{ id: string; post_id: string }[]>`
      UPDATE platform_publications pp SET status = 'skipped', last_error = 'missed publish window', next_attempt_at = NULL
        FROM posts p
       WHERE pp.post_id = p.id AND pp.status = 'pending'
         AND p.scheduled_for < now() - make_interval(mins => ${c.lateMin}::int)
      RETURNING pp.id, pp.post_id`;
    for (const r of new Set(late.map((x) => x.post_id))) await this.finalizePost(r, b.worker);

    // 2. Expired leases: a publishing call may or may not have happened → reconcile; else resume.
    const stale = await this.db.platformPublication.findMany({ where: { status: 'publishing', nextAttemptAt: { lt: now } } });
    for (const p of stale) {
      const phase = (p.responseMeta as PubState | null)?.phase;
      const to = phase && PUBLISHING_PHASES.has(phase) ? 'reconciling' : 'pending';
      await this.db.platformPublication.updateMany({ where: { id: p.id, status: 'publishing', attemptCount: p.attemptCount }, data: { status: to, nextAttemptAt: now, lastError: `lease expired in ${phase ?? 'unknown phase'}` } });
      await this.finishAttempt(p.id, p.attemptCount, 'lease_expired', null, `lease expired in ${phase ?? 'unknown phase'}`);
    }

    if (!c.enabled) return { action: 'none', reason: 'publishing_disabled' };
    const platforms = this.configuredPlatforms().filter((p) => c.platforms.includes(p));
    if (!platforms.length) return { action: 'none', reason: 'no_configured_platform' };

    // 3. Lock one due publication. Reconciliation (read-only) is not bound by the window or the cap.
    const claimed = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; platform: Platform; status: string; attempt_count: number; post_id: string }[]>`
        SELECT pp.id, pp.platform::text AS platform, pp.status::text AS status, pp.attempt_count, pp.post_id
          FROM platform_publications pp JOIN posts p ON p.id = pp.post_id
         WHERE pp.status IN ('pending', 'reconciling')
           AND pp.platform::text = ANY(${platforms}::text[])
           AND (pp.next_attempt_at IS NULL OR pp.next_attempt_at <= now())
           AND p.status IN ('scheduled', 'publishing')
           AND p.scheduled_for <= now()
           AND (pp.status = 'reconciling' OR (
                 SELECT count(*) FROM platform_publications x
                  WHERE x.platform = pp.platform AND x.status = 'published'
                    AND (x.published_at AT TIME ZONE ${c.timezone})::date = (now() AT TIME ZONE ${c.timezone})::date
               ) < ${c.dailyCap}::int)
         ORDER BY (pp.status = 'reconciling') DESC, p.scheduled_for, pp.platform
         LIMIT 1
         FOR UPDATE OF pp SKIP LOCKED`;
      const row = rows[0];
      if (!row) return null;
      // Reconciliation gets extra room (it only reads), but it is bounded too.
      const limit = row.status === 'reconciling' ? c.maxAttempts * 2 : c.maxAttempts;
      if (row.attempt_count >= limit) {
        await tx.platformPublication.update({ where: { id: row.id }, data: { status: 'failed', lastError: `gave up after ${row.attempt_count} attempts (${row.status})`, nextAttemptAt: null } });
        return { ...row, attemptNo: row.attempt_count, gaveUp: true };
      }
      const attemptNo = row.attempt_count + 1;
      await tx.platformPublication.update({
        where: { id: row.id },
        data: { status: 'publishing', attemptCount: attemptNo, nextAttemptAt: new Date(Date.now() + c.leaseMin * 60_000) },
      });
      await tx.publishAttempt.create({ data: { publicationId: row.id, attemptNo, response: { worker: b.worker, reconciling: row.status === 'reconciling', steps: [] } } });
      const post = await tx.post.findUniqueOrThrow({ where: { id: row.post_id } });
      if (post.status === 'scheduled') {
        await tx.$queryRaw`SELECT 1 FROM tn_transition_post(${post.id}::uuid, 'publishing'::"PostStatus", ${`publishing to ${row.platform}`}, ${b.worker})`;
      }
      return { ...row, attemptNo, gaveUp: false };
    });
    if (!claimed) return { action: 'none', reason: 'nothing_due' };
    if (claimed.gaveUp) {
      await this.finalizePost(claimed.post_id, b.worker);
      return { action: 'none', reason: 'gave_up' };
    }

    const pub = await this.db.platformPublication.findUniqueOrThrow({ where: { id: claimed.id } });
    const state = (pub.responseMeta ?? {}) as PubState;
    const ctx = await this.textFor(pub);
    if (claimed.platform === 'instagram' && claimed.status !== 'reconciling') {
      const problems = instagramProblems(ctx.text);
      if (problems.length) return this.toClaim(await this.finish(pub, claimed.attemptNo, 'failed', { code: 'caption_invalid', message: problems.join('; ') }, b.worker));
    }
    const publicImageUrl = isPublicUrl(this.cfg.s3.publicBaseUrl) ? ctx.publicUrl : null;
    if (publicImageUrl && !state.image_url) state.image_url = publicImageUrl;
    const phase = startPhase(claimed.platform, { reconciling: claimed.status === 'reconciling', state, containerId: pub.externalContainerId, publicImageUrl });
    return this.toClaim(await this.next(pub, claimed.attemptNo, phase, state, b.worker));
  }

  private toClaim(r: ApplyResult): ClaimResult {
    if (r.done || !r.step) return { action: 'none', reason: r.outcome ? `ended_${r.outcome}` : 'ended', publication_id: r.publication_id };
    return { action: 'step', publication_id: r.publication_id, platform: r.platform, attempt_no: r.attempt_no, step: r.step };
  }

  // ── apply ────────────────────────────────────────────────────────────────

  async apply(b: { publication_id: string; attempt_no: number; phase: Phase; result: StepResult; worker?: string }): Promise<ApplyResult> {
    if (!b.publication_id || !b.attempt_no || !b.phase || !b.result) throw new HttpError(400, 'bad_request', 'publication_id, attempt_no, phase and result are required');
    const worker = b.worker ?? 'n8n';
    const pub = await this.db.platformPublication.findUnique({ where: { id: b.publication_id } });
    if (!pub) throw new HttpError(404, 'not_found', `publication ${b.publication_id} not found`);
    const state = { ...((pub.responseMeta ?? {}) as PubState) };
    const permalinkPhase = b.phase === 'fb_permalink' || b.phase === 'ig_permalink';
    const okStatus = permalinkPhase ? pub.status === 'published' : pub.status === 'publishing';
    if (!okStatus || pub.attemptCount !== b.attempt_no || state.phase !== b.phase) {
      throw new HttpError(409, 'stale_step', `publication ${pub.id}: step ${b.phase}/attempt ${b.attempt_no} is not current (status ${pub.status}, attempt ${pub.attemptCount}, phase ${state.phase ?? 'none'})`);
    }

    const r = classify(b.result);
    const steps = await this.recordStep(pub.id, b.attempt_no, b.phase, b.result, r);
    if (steps > MAX_STEPS_PER_ATTEMPT) return this.finish(pub, b.attempt_no, 'pending', { code: 'too_many_steps', message: `more than ${MAX_STEPS_PER_ATTEMPT} steps in one attempt`, backoff: true }, worker);

    const ctx = await this.textFor(pub);
    const fail = (outcomeIfPermanent: 'failed' | 'skipped' = 'failed') => this.onError(pub, b.attempt_no, r as Extract<Classified, { ok: false }>, outcomeIfPermanent, worker);
    const body = r.ok ? r.body : {};

    switch (b.phase) {
      // ── Facebook ──
      case 'fb_publish': {
        if (!r.ok) return fail();
        const postId = String(body.post_id ?? body.id ?? '');
        if (!postId) return this.finish(pub, b.attempt_no, 'reconciling', { code: 'no_id', message: 'Graph returned no post id' }, worker);
        Object.assign(state, { fb_photo_id: String(body.id ?? ''), fb_post_id: postId });
        await this.markPublished(pub, b.attempt_no, postId, null, state, worker);
        return this.next(await this.reload(pub.id), b.attempt_no, 'fb_permalink', state, worker);
      }
      case 'fb_permalink':
        if (r.ok && typeof body.permalink_url === 'string') await this.db.platformPublication.update({ where: { id: pub.id }, data: { permalink: body.permalink_url } });
        return { done: true, outcome: 'published', publication_id: pub.id, attempt_no: b.attempt_no, platform: pub.platform as Platform };
      case 'fb_reconcile': {
        if (!r.ok) return r.kind === 'auth' ? fail() : this.finish(pub, b.attempt_no, 'reconciling', { code: r.code, message: r.message, backoff: true }, worker);
        const items = (Array.isArray(body.data) ? body.data : []) as { id?: string; message?: string; permalink_url?: string }[];
        const hit = items.find((i) => sameText(i.message, ctx.text));
        if (hit?.id) {
          await this.markPublished(pub, b.attempt_no, hit.id, hit.permalink_url ?? null, state, worker, 'reconciled_published');
          return { done: true, outcome: 'published', publication_id: pub.id, attempt_no: b.attempt_no, platform: 'facebook' };
        }
        return this.finish(pub, b.attempt_no, 'pending', { code: 'reconciled_absent', message: 'post not found on the Page; will publish again', outcomeLabel: 'reconciled_absent' }, worker);
      }

      // ── Instagram ──
      case 'ig_stage':
        if (!r.ok) return fail();
        if (!body.id) return this.finish(pub, b.attempt_no, 'pending', { code: 'no_id', message: 'staging upload returned no photo id', backoff: true }, worker);
        state.staged_photo_id = String(body.id);
        return this.next(pub, b.attempt_no, 'ig_stage_url', state, worker);
      case 'ig_stage_url': {
        if (!r.ok) return fail();
        const url = largestImageSource(body);
        if (!url) return this.finish(pub, b.attempt_no, 'pending', { code: 'no_image_url', message: 'staged photo has no image URL yet', backoff: true }, worker);
        state.image_url = url;
        return this.next(pub, b.attempt_no, 'ig_container', state, worker);
      }
      case 'ig_container': {
        if (!r.ok) {
          // A staged CDN URL can expire; restage once before giving up.
          if (r.kind === 'permanent' && state.staged_photo_id && !(state as Json).restaged) {
            Object.assign(state, { image_url: undefined, staged_photo_id: undefined, restaged: true });
            await this.saveState(pub.id, state);
            return this.finish(pub, b.attempt_no, 'pending', { code: r.code, message: `${r.message} (restaging image)`, backoff: true }, worker);
          }
          return fail();
        }
        if (!body.id) return this.finish(pub, b.attempt_no, 'pending', { code: 'no_id', message: 'container creation returned no id', backoff: true }, worker);
        await this.db.platformPublication.update({ where: { id: pub.id }, data: { externalContainerId: String(body.id) } });
        state.status_checks = 0;
        return this.next(await this.reload(pub.id), b.attempt_no, 'ig_status', state, worker);
      }
      case 'ig_status': {
        if (!r.ok && r.kind === 'permanent') {
          await this.dropContainer(pub.id, state);
          return this.finish(pub, b.attempt_no, 'pending', { code: r.code, message: `${r.message} (creating a new container)`, backoff: true }, worker);
        }
        if (!r.ok) return fail();
        const code = String(body.status_code ?? '');
        if (code === 'FINISHED') return this.next(pub, b.attempt_no, 'ig_publish', state, worker);
        if (code === 'PUBLISHED') return this.next(pub, b.attempt_no, 'ig_reconcile_media', state, worker);
        if (code === 'IN_PROGRESS' && (state.status_checks ?? 0) < MAX_STATUS_CHECKS) {
          state.status_checks = (state.status_checks ?? 0) + 1;
          await this.saveState(pub.id, state);
          return this.finish(pub, b.attempt_no, 'pending', { code: 'in_progress', message: 'container still processing', retryInMinutes: 1 }, worker);
        }
        await this.dropContainer(pub.id, state);
        return this.finish(pub, b.attempt_no, 'pending', { code: `container_${code.toLowerCase() || 'unknown'}`, message: `container status ${code || 'unknown'}; creating a new one`, backoff: true }, worker);
      }
      case 'ig_publish': {
        if (!r.ok) return fail();
        if (!body.id) return this.finish(pub, b.attempt_no, 'reconciling', { code: 'no_id', message: 'media_publish returned no id' }, worker);
        state.media_id = String(body.id);
        await this.markPublished(pub, b.attempt_no, state.media_id, null, state, worker);
        return this.next(await this.reload(pub.id), b.attempt_no, 'ig_permalink', state, worker);
      }
      case 'ig_permalink':
        if (r.ok && typeof body.permalink === 'string') await this.db.platformPublication.update({ where: { id: pub.id }, data: { permalink: body.permalink } });
        return { done: true, outcome: 'published', publication_id: pub.id, attempt_no: b.attempt_no, platform: pub.platform as Platform };
      case 'ig_reconcile_status': {
        if (!r.ok) return r.kind === 'auth' ? fail() : this.finish(pub, b.attempt_no, 'reconciling', { code: r.code, message: r.message, backoff: true }, worker);
        const code = String(body.status_code ?? '');
        if (code === 'PUBLISHED') return this.next(pub, b.attempt_no, 'ig_reconcile_media', state, worker);
        if (code === 'FINISHED') return this.finish(pub, b.attempt_no, 'pending', { code: 'reconciled_absent', message: 'container not published; will publish it', outcomeLabel: 'reconciled_absent' }, worker);
        if (code === 'IN_PROGRESS') return this.finish(pub, b.attempt_no, 'reconciling', { code: 'in_progress', message: 'container still processing', retryInMinutes: 1 }, worker);
        await this.dropContainer(pub.id, state);
        return this.finish(pub, b.attempt_no, 'pending', { code: 'reconciled_absent', message: `container ${code || 'unknown'}; will publish again`, outcomeLabel: 'reconciled_absent' }, worker);
      }
      case 'ig_reconcile_media': {
        if (!r.ok) return r.kind === 'auth' ? fail() : this.finish(pub, b.attempt_no, 'reconciling', { code: r.code, message: r.message, backoff: true }, worker);
        const items = (Array.isArray(body.data) ? body.data : []) as { id?: string; caption?: string; permalink?: string }[];
        const hit = items.find((i) => sameText(i.caption, ctx.text));
        if (hit?.id) {
          state.media_id = hit.id;
          await this.markPublished(pub, b.attempt_no, hit.id, hit.permalink ?? null, state, worker, 'reconciled_published');
          return { done: true, outcome: 'published', publication_id: pub.id, attempt_no: b.attempt_no, platform: 'instagram' };
        }
        await this.dropContainer(pub.id, state);
        return this.finish(pub, b.attempt_no, 'pending', { code: 'reconciled_absent', message: 'media not found on the account; will publish again', outcomeLabel: 'reconciled_absent' }, worker);
      }
    }
  }

  // ── media ────────────────────────────────────────────────────────────────

  /** Image bytes for the current upload step (fenced like apply). */
  async media(q: { publication_id: string; attempt_no: number }): Promise<{ bytes: Buffer; mimeType: string }> {
    const pub = await this.db.platformPublication.findUnique({ where: { id: q.publication_id }, include: { post: { include: { imageAsset: true } } } });
    const phase = (pub?.responseMeta as PubState | null)?.phase;
    if (!pub || pub.status !== 'publishing' || pub.attemptCount !== Number(q.attempt_no) || (phase !== 'fb_publish' && phase !== 'ig_stage')) {
      throw new HttpError(409, 'stale_step', 'no upload step is current for this publication/attempt');
    }
    const asset = pub.post.imageAsset;
    if (!asset?.storageKey || asset.status !== 'approved') throw new HttpError(409, 'image_not_approved', 'post has no approved stored image');
    const bytes = await getObject(this.cfg.s3, asset.storageKey);
    if (!bytes) throw new HttpError(404, 'image_missing', `object ${asset.storageKey} not found`);
    return { bytes, mimeType: asset.mimeType ?? 'image/jpeg' };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private reload = (id: string) => this.db.platformPublication.findUniqueOrThrow({ where: { id } });

  private async saveState(id: string, state: PubState): Promise<void> {
    await this.db.platformPublication.update({ where: { id }, data: { responseMeta: JSON.parse(JSON.stringify(state)) } });
  }

  private async dropContainer(id: string, state: PubState): Promise<void> {
    state.status_checks = 0;
    await this.db.platformPublication.update({ where: { id }, data: { externalContainerId: null, responseMeta: JSON.parse(JSON.stringify(state)) } });
  }

  private async textFor(pub: PlatformPublication) {
    const post = await this.db.post.findUniqueOrThrow({ where: { id: pub.postId }, include: { imageAsset: true } });
    return { text: postText(post), altText: post.altText ?? '', publicUrl: post.imageAsset?.publicUrl ?? null, scheduledFor: post.scheduledFor };
  }

  /** Persist the phase and return the step for it (checking the kill switch before any publishing call). */
  private async next(pub: PlatformPublication, attemptNo: number, phase: Phase, state: PubState, worker: string): Promise<ApplyResult> {
    if (PUBLISHING_PHASES.has(phase) && !(await this.config()).enabled) {
      return this.finish(pub, attemptNo, 'pending', { code: 'kill_switch', message: 'publishing disabled before the publish call', outcomeLabel: 'aborted_kill_switch' }, worker);
    }
    const ctx = await this.textFor(pub);
    const s: PubState = { ...state, phase };
    if (phase === 'fb_publish' || phase === 'ig_publish') (s as Json).publish_started_at = Math.floor(Date.now() / 1000);
    await this.saveState(pub.id, s);
    const since = Number((s as Json).publish_started_at ?? Math.floor((ctx.scheduledFor?.getTime() ?? Date.now()) / 1000)) - 300;
    const step = stepFor(phase, this.cfg.meta, { text: ctx.text, altText: ctx.altText, state: s, containerId: pub.externalContainerId, since });
    return { done: false, publication_id: pub.id, attempt_no: attemptNo, platform: pub.platform as Platform, step };
  }

  private async recordStep(id: string, attemptNo: number, phase: Phase, result: StepResult, r: Classified): Promise<number> {
    const attempt = await this.db.publishAttempt.findUnique({ where: { publicationId_attemptNo: { publicationId: id, attemptNo } } });
    const resp = (attempt?.response ?? { steps: [] }) as { steps: unknown[] } & Json;
    const bodyText = 'body' in result ? JSON.stringify(result.body ?? null) : '';
    resp.steps = [...(resp.steps ?? []), {
      phase, at: new Date().toISOString(), http_status: 'status' in result ? result.status : null,
      ok: r.ok, ...(r.ok ? {} : { kind: r.kind, code: r.code, message: r.message }), body: bodyText.slice(0, 2000),
    }];
    await this.db.publishAttempt.update({
      where: { publicationId_attemptNo: { publicationId: id, attemptNo } },
      data: { response: resp as Prisma.InputJsonValue, httpStatus: 'status' in result ? result.status : null },
    });
    return resp.steps.length;
  }

  private onError(pub: PlatformPublication, attemptNo: number, r: Extract<Classified, { ok: false }>, permanent: 'failed' | 'skipped', worker: string): Promise<ApplyResult> {
    const phase = (pub.responseMeta as PubState | null)?.phase;
    if (r.kind === 'ambiguous' && phase && PUBLISHING_PHASES.has(phase)) {
      return this.finish(pub, attemptNo, 'reconciling', { code: r.code, message: r.message, retryInMinutes: 2, outcomeLabel: 'timeout_unknown' }, worker);
    }
    if (r.kind === 'transient' || r.kind === 'ambiguous') return this.finish(pub, attemptNo, 'pending', { code: r.code, message: r.message, backoff: true, outcomeLabel: 'transient_error' }, worker);
    return this.finish(pub, attemptNo, permanent, { code: r.kind === 'auth' ? `auth_${r.code}` : r.code, message: r.message, outcomeLabel: 'permanent_error' }, worker);
  }

  private async markPublished(pub: PlatformPublication, attemptNo: number, externalId: string, permalink: string | null, state: PubState, worker: string, label = 'success'): Promise<void> {
    await this.db.platformPublication.update({
      where: { id: pub.id },
      data: { status: 'published', externalPostId: externalId, permalink, publishedAt: new Date(), nextAttemptAt: null, lastError: null, lastErrorCode: null, responseMeta: JSON.parse(JSON.stringify(state)) },
    });
    await this.finishAttempt(pub.id, attemptNo, label, null, null);
    await this.finalizePost(pub.postId, worker);
  }

  /** End this attempt with a non-published outcome. */
  private async finish(pub: PlatformPublication, attemptNo: number, outcome: Exclude<Outcome, 'published'>,
    e: { code: string; message: string; backoff?: boolean; retryInMinutes?: number; outcomeLabel?: string }, worker: string): Promise<ApplyResult> {
    const minutes = e.retryInMinutes ?? (e.backoff ? backoffMinutes(attemptNo) : outcome === 'reconciling' ? 2 : 0);
    const nextAt = outcome === 'pending' || outcome === 'reconciling' ? new Date(Date.now() + minutes * 60_000) : null;
    await this.db.platformPublication.update({
      where: { id: pub.id },
      data: { status: outcome, nextAttemptAt: nextAt, lastErrorCode: e.code.slice(0, 100), lastError: e.message.slice(0, 1000) },
    });
    await this.finishAttempt(pub.id, attemptNo, e.outcomeLabel ?? (outcome === 'failed' ? 'permanent_error' : 'transient_error'), e.code, e.message);
    if (outcome === 'failed' || outcome === 'skipped') await this.finalizePost(pub.postId, worker);
    return { done: true, outcome, publication_id: pub.id, attempt_no: attemptNo, platform: pub.platform as Platform, message: e.message };
  }

  private async finishAttempt(id: string, attemptNo: number, outcome: string, code: string | null, message: string | null): Promise<void> {
    await this.db.publishAttempt.updateMany({
      where: { publicationId: id, attemptNo, finishedAt: null },
      data: { finishedAt: new Date(), outcome, errorCode: code?.slice(0, 100) ?? null, errorMessage: message?.slice(0, 1000) ?? null },
    });
  }

  /** Once every publication of a post is final: published if any platform published, else failed/skipped. */
  private async finalizePost(postId: string, worker: string): Promise<void> {
    const [post, pubs] = await Promise.all([
      this.db.post.findUnique({ where: { id: postId } }),
      this.db.platformPublication.findMany({ where: { postId } }),
    ]);
    if (!post || !pubs.length || pubs.some((p) => ['pending', 'publishing', 'reconciling'].includes(p.status))) return;
    const published = pubs.filter((p) => p.status === 'published').map((p) => p.platform);
    const summary = pubs.map((p) => `${p.platform}=${p.status}`).join(', ');
    let to: 'published' | 'failed' | 'skipped' | null = null;
    if (post.status === 'publishing') to = published.length ? 'published' : 'failed';
    else if (post.status === 'scheduled' && !published.length) to = 'skipped';
    if (!to) return;
    try {
      await this.db.$queryRaw`SELECT 1 FROM tn_transition_post(${postId}::uuid, ${to}::"PostStatus", ${summary}, ${worker})`;
    } catch {
      // A concurrent finalizer already moved the post; the state machine rejected the duplicate.
    }
  }
}
