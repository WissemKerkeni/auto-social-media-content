// Production steps behind the TN-01 workflow. Every mutating step is fenced by the slot lease:
// a worker that lost its lease gets LeaseLostError and changes nothing.
import type { PrismaClient } from '../generated/prisma/client.ts';
import type { CoreConfig } from './config.ts';
import { checkImage, makePreview } from './images.ts';
import { chooseSceneBrief, compilePrompt, contentHash, decideAudit, humanizeLandscape, timeOfDay, type ImageAudit, type ImageOrigin } from './rules.ts';
// Shared, already unit-tested JS libraries
import {
  buildImageRequest, parseImageResponse, buildClaudeJsonRequest, claudeImageBlock, parseClaudeJson, parseCaptionResponse, validateCaption,
} from '../../scripts/lib/models.mjs';
import { buildDisclosure, composeCaption } from '../../scripts/lib/content.mjs';
import { putObject, getObject } from '../../scripts/lib/s3.mjs';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class LeaseLostError extends HttpError {
  constructor(slotId: string) { super(409, 'lease_lost', `slot ${slotId}: lease lost or slot not claimed by this worker`); }
}

interface Fence { slot_id: string; worker: string }
interface ProductionContext {
  image_origin: ImageOrigin;
  scene_brief: string;
  time_of_day: string;
  source_asset_id: string | null;
  cooldown_fallback: boolean;
  image_prompt_name: string;
}
type Json = Record<string, unknown>;

const CAP_KEYS = {
  gemini_image: ['cap_gemini_image_per_day', 12],
  anthropic: ['cap_anthropic_per_day', 30],
} as const;

export class ProductionService {
  constructor(private readonly db: PrismaClient, private readonly cfg: CoreConfig) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Verify + extend the lease. Throws LeaseLostError if this worker no longer holds the slot. */
  private async fence({ slot_id, worker }: Fence): Promise<void> {
    if (!slot_id || !worker) throw new HttpError(400, 'bad_request', 'slot_id and worker are required');
    const rows = await this.db.$queryRaw<{ ok: boolean }[]>`SELECT tn_heartbeat_slot(${slot_id}::uuid, ${worker}) AS ok`;
    if (!rows[0]?.ok) throw new LeaseLostError(slot_id);
  }

  private async transition(postId: string, to: string, reason: string, actor: string): Promise<void> {
    await this.db.$queryRaw`SELECT 1 FROM tn_transition_post(${postId}::uuid, ${to}::"PostStatus", ${reason}, ${actor})`;
  }

  private async completeSlot(f: Fence, outcome: 'produced' | 'skipped' | 'failed', note: string | null): Promise<boolean> {
    const r = await this.db.$queryRaw<{ ok: boolean }[]>`SELECT tn_complete_slot(${f.slot_id}::uuid, ${f.worker}, ${outcome}::"SlotStatus", ${note}) AS ok`;
    return Boolean(r[0]?.ok);
  }

  /** Atomically consume one call from the daily cap. */
  private async reserve(provider: keyof typeof CAP_KEYS): Promise<void> {
    const [key, def] = CAP_KEYS[provider];
    const r = await this.db.$queryRaw<{ ok: boolean }[]>`SELECT tn_reserve_api_call(${provider}, ${key}, ${def}::int) AS ok`;
    if (!r[0]?.ok) throw new HttpError(429, 'daily_cap', `daily ${provider} call cap reached (${key})`);
  }

  async logError(e: { stage: string; message: string; slot_id?: string | null; post_id?: string | null; location_id?: string | null; code?: string | null; retryable?: boolean; details?: Json | null }): Promise<void> {
    await this.db.generationError.create({
      data: {
        stage: e.stage, message: e.message.slice(0, 2000), slotId: e.slot_id ?? null, postId: e.post_id ?? null,
        locationId: e.location_id ?? null, errorCode: e.code ?? null, retryable: Boolean(e.retryable), details: (e.details ?? undefined) as object | undefined,
      },
    });
  }

  private async loadPost(postId: string) {
    const post = await this.db.post.findUnique({ where: { id: postId }, include: { location: true, imageAsset: true, slot: true } });
    if (!post) throw new HttpError(404, 'not_found', `post ${postId} not found`);
    return post;
  }

  private ctx(post: { productionContext: unknown }): ProductionContext {
    const c = post.productionContext as ProductionContext | null;
    if (!c?.image_origin) throw new HttpError(409, 'no_context', 'post has no production context; call prepare first');
    return c;
  }

  // ── 1. prepare ───────────────────────────────────────────────────────────

  /** Create or resume the slot's post, pick destination + image source, return everything n8n needs. */
  async prepare(f: Fence) {
    await this.fence(f);
    const slot = await this.db.publishSlot.findUniqueOrThrow({ where: { id: f.slot_id } });
    let post = await this.db.post.findUnique({ where: { slotId: f.slot_id }, include: { imageAsset: true } });

    if (post && ['validated', 'scheduled', 'publishing', 'published'].includes(post.status)) {
      await this.completeSlot(f, 'produced', null);
      return { action: 'already_done' as const, post_id: post.id, status: post.status };
    }
    if (post && ['needs_review', 'skipped'].includes(post.status)) {
      await this.completeSlot(f, 'skipped', `post is ${post.status}`);
      return { action: 'skip' as const, post_id: post.id, status: post.status };
    }
    if (post?.status === 'failed') await this.transition(post.id, 'draft', 'retry after failure', f.worker);

    let cooldownFallback = false;
    if (!post) {
      const picked = await this.db.$queryRaw<{ location_id: string; cooldown_fallback: boolean }[]>`SELECT * FROM tn_pick_location()`;
      const choice = picked[0];
      if (!choice) throw new HttpError(409, 'no_location', 'no active destination');
      cooldownFallback = choice.cooldown_fallback;
      post = await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('tn.actor', ${f.worker}, true)`;
        return tx.post.create({ data: { slotId: f.slot_id, locationId: choice.location_id }, include: { imageAsset: true } });
      });
    }

    const location = await this.db.location.findUniqueOrThrow({ where: { id: post.locationId } });
    let context = post.productionContext as ProductionContext | null;
    if (!context) {
      // Prefer an approved, rights-verified licensed photo not used in the last 30 days.
      const source = await this.db.imageAsset.findFirst({
        where: {
          locationId: location.id, origin: 'licensed_photo', status: 'approved', rightsVerified: true,
          children: { none: { posts: { some: { createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
      const priorPosts = await this.db.post.count({ where: { locationId: location.id, id: { not: post.id } } });
      const origin: ImageOrigin = source ? 'licensed_photo_enhanced' : 'ai_generated';
      context = {
        image_origin: origin,
        scene_brief: chooseSceneBrief(location.sceneBriefs, priorPosts),
        time_of_day: timeOfDay(slot.localTime),
        source_asset_id: source?.id ?? null,
        cooldown_fallback: cooldownFallback,
        image_prompt_name: origin === 'ai_generated' ? 'tn-image-original' : 'tn-image-enhance',
      };
      await this.db.post.update({ where: { id: post.id }, data: { productionContext: context as object } });
    }

    const hasApprovedImage = post.imageAsset?.status === 'approved';
    return {
      action: 'produce' as const,
      post_id: post.id,
      slot: { id: slot.id, slot_at: slot.slotAt, local_date: slot.localDate, local_time: slot.localTime },
      location: { id: location.id, slug: location.slug, name_en: location.nameEn, name_ar: location.nameAr, landscape_type: location.landscapeType },
      ...context,
      needs_image: !hasApprovedImage,
      trace_key: `post:${post.id}`,
    };
  }

  // ── 2. image request ─────────────────────────────────────────────────────

  async imageRequest(f: Fence & { post_id: string; prompt_text: string }) {
    await this.fence(f);
    const post = await this.loadPost(f.post_id);
    const c = this.ctx(post);
    const vars: Record<string, string> = {
      destination_name_en: post.location.nameEn,
      region: `${post.location.governorate}, ${post.location.region} Tunisia`,
      landscape_type: humanizeLandscape(post.location.landscapeType),
      scene_brief: c.scene_brief,
      time_of_day: c.time_of_day,
    };
    let inputImage: { mimeType: string; base64: string } | null = null;
    if (c.image_origin === 'licensed_photo_enhanced') {
      const src = await this.db.imageAsset.findUniqueOrThrow({ where: { id: c.source_asset_id! } });
      const bytes = src.storageKey ? await getObject(this.cfg.s3, src.storageKey) : null;
      if (!bytes) throw new HttpError(409, 'source_missing', `licensed source ${src.id} has no stored file`);
      inputImage = { mimeType: src.mimeType ?? 'image/jpeg', base64: bytes.toString('base64') };
      vars.source_description = (src.auditResult as { audit?: { description?: string } } | null)?.audit?.description ?? 'a real landscape photograph';
    }
    const prompt = compilePrompt(f.prompt_text, vars);
    await this.reserve('gemini_image');
    const request = buildImageRequest({
      model: this.cfg.models.imageModel, prompt, aspectRatio: this.cfg.models.aspectRatio, imageSize: this.cfg.models.imageSize, inputImage,
    });
    return { request, model: this.cfg.models.imageModel, prompt };
  }

  // ── 3. ingest generated image + audit request ────────────────────────────

  async ingestImage(f: Fence & { post_id: string; response: Json; prompt_version?: number | null; audit_prompt_text: string; started_at?: string }) {
    await this.fence(f);
    const post = await this.loadPost(f.post_id);
    const c = this.ctx(post);

    const parsed = parseImageResponse(f.response);
    if (!parsed.ok) return { ok: false as const, reason: `image_${parsed.reason}`, detail: parsed.detail, retryable: parsed.retryable !== false };

    const checked = await checkImage(Buffer.from(parsed.base64, 'base64'), {
      aspectRatio: this.cfg.models.aspectRatio, aspectTolerance: 0.03, minWidth: 1080, maxBytes: 8 * 1024 * 1024,
    });
    if (!checked.ok) return { ok: false as const, reason: 'image_invalid', detail: checked.reason, retryable: true };

    if (await this.db.imageAsset.findUnique({ where: { sha256: checked.sha256 } })) {
      return { ok: false as const, reason: 'duplicate_exact', detail: 'identical image already stored', retryable: true };
    }
    const similar = await this.db.$queryRaw<{ asset_id: string; distance: number }[]>`SELECT asset_id, distance FROM tn_similar_assets(${checked.phash}, 6)`;
    if (similar.length) {
      return { ok: false as const, reason: 'duplicate_near', detail: `perceptual match with ${similar[0]!.asset_id} (distance ${similar[0]!.distance})`, retryable: true };
    }

    const d = new Date();
    const key = `images/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${checked.sha256}.jpg`;
    await putObject(this.cfg.s3, key, checked.buffer, checked.mimeType, { cacheControl: 'public, max-age=31536000, immutable' });

    let rights: Record<string, unknown> = {};
    if (c.image_origin === 'licensed_photo_enhanced') {
      const src = await this.db.imageAsset.findUniqueOrThrow({ where: { id: c.source_asset_id! } });
      rights = {
        parentAssetId: src.id, sourceUrl: src.sourceUrl, sourcePageUrl: src.sourcePageUrl, author: src.author, licenseCode: src.licenseCode,
        licenseUrl: src.licenseUrl, attributionText: src.attributionText, attributionRequired: src.attributionRequired,
        rightsVerified: src.rightsVerified, rightsVerifiedAt: src.rightsVerifiedAt,
      };
    }
    const asset = await this.db.imageAsset.create({
      data: {
        locationId: post.locationId, origin: c.image_origin, status: 'pending',
        aiGenerated: c.image_origin === 'ai_generated', aiEdited: c.image_origin === 'licensed_photo_enhanced',
        aiModel: this.cfg.models.imageModel, promptName: c.image_prompt_name, promptVersion: f.prompt_version ?? null,
        generationParams: { scene_brief: c.scene_brief, time_of_day: c.time_of_day, image_size: this.cfg.models.imageSize, aspect_ratio: this.cfg.models.aspectRatio, usage: parsed.usage, reencoded: checked.reencoded },
        langfuseTraceId: `post:${post.id}`,
        storageKey: key, publicUrl: `${this.cfg.s3.publicBaseUrl}/${key}`, mimeType: checked.mimeType,
        width: checked.width, height: checked.height, bytes: checked.bytes, sha256: checked.sha256, phash: checked.phash,
        ...rights,
      },
    });
    await this.db.post.update({ where: { id: post.id }, data: { imageAssetId: asset.id } });

    const preview = await makePreview(checked.buffer);
    const auditPrompt = compilePrompt(f.audit_prompt_text, {
      image_origin: c.image_origin, destination_name_en: post.location.nameEn,
      landscape_type: humanizeLandscape(post.location.landscapeType), scene_brief: c.scene_brief,
    });
    await this.reserve('anthropic');
    const auditRequest = buildClaudeJsonRequest({
      model: this.cfg.models.textModel, effort: this.cfg.models.auditEffort, maxTokens: 8000,
      content: [claudeImageBlock(preview.base64, preview.mimeType), { type: 'text', text: auditPrompt }],
      schema: this.cfg.auditSchema,
    });
    return {
      ok: true as const, asset_id: asset.id, public_url: asset.publicUrl, sha256: checked.sha256, phash: checked.phash,
      width: checked.width, height: checked.height, bytes: checked.bytes, audit_request: auditRequest,
      trace: { generation_name: 'image-generate', model: this.cfg.models.imageModel, input: { scene_brief: c.scene_brief, time_of_day: c.time_of_day, origin: c.image_origin }, output: { sha256: checked.sha256, width: checked.width, height: checked.height, bytes: checked.bytes, storage_key: key }, usage_input: parsed.usage?.promptTokenCount ?? 0, usage_output: parsed.usage?.candidatesTokenCount ?? 0 },
    };
  }

  // ── 4. apply the vision audit ────────────────────────────────────────────

  async applyAudit(f: Fence & { post_id: string; response: Json }) {
    await this.fence(f);
    const post = await this.loadPost(f.post_id);
    const c = this.ctx(post);
    if (!post.imageAsset) throw new HttpError(409, 'no_image', 'post has no image to audit');

    const parsed = parseClaudeJson(f.response);
    if (!parsed.ok) {
      return { ok: false as const, approved: false, reason: `audit_${parsed.reason}`, detail: parsed.detail, retryable: parsed.retryable };
    }
    const audit = parsed.json as ImageAudit;
    const decision = decideAudit(audit, c.image_origin);
    await this.db.imageAsset.update({
      where: { id: post.imageAsset.id },
      data: { status: decision.approved ? 'approved' : 'quarantined', auditResult: { audit, decision, model: parsed.model, usage: parsed.usage } as object },
    });
    return {
      ok: true as const, approved: decision.approved, problems: decision.problems, warnings: decision.warnings, description: audit.description,
      trace: { generation_name: 'image-audit', model: parsed.model, input: { asset_id: post.imageAsset.id }, output: { approved: decision.approved, problems: decision.problems, warnings: decision.warnings, audit }, usage_input: parsed.usage?.input_tokens ?? 0, usage_output: parsed.usage?.output_tokens ?? 0 },
    };
  }

  // ── 5. caption request ───────────────────────────────────────────────────

  private async captionInputs(postId: string) {
    const post = await this.loadPost(postId);
    const c = this.ctx(post);
    const asset = post.imageAsset;
    if (!asset || asset.status !== 'approved') throw new HttpError(409, 'image_not_approved', 'caption requires an approved image');
    const facts = await this.db.locationFact.findMany({
      where: { locationId: post.locationId, status: 'verified' }, include: { source: true }, orderBy: { createdAt: 'asc' },
    });
    const disclosure = buildDisclosure({
      origin: c.image_origin, placeAr: post.location.nameAr, placeEn: post.location.nameEn, attribution: asset.attributionText ?? null,
    }, this.cfg.promptsConfig);
    return { post, c, asset, facts, disclosure };
  }

  async captionRequest(f: Fence & { post_id: string; system_prompt_text: string; request_prompt_text: string }) {
    await this.fence(f);
    const { post, c, asset, facts, disclosure } = await this.captionInputs(f.post_id);
    const audit = (asset.auditResult as { audit?: ImageAudit } | null)?.audit;
    const userPrompt = compilePrompt(f.request_prompt_text, {
      destination_name_ar: post.location.nameAr,
      destination_name_en: post.location.nameEn,
      region: `${post.location.governorate}, ${post.location.region} Tunisia`,
      landscape_type: humanizeLandscape(post.location.landscapeType),
      image_origin: c.image_origin,
      image_description: audit?.description ?? c.scene_brief,
      verified_facts_json: JSON.stringify(facts.map((x) => ({ id: x.id, claim_en: x.claimEn, claim_ar: x.claimAr, source: x.source.url }))),
      source_attribution: asset.attributionText ?? '',
      disclosure_text: disclosure.text,
    });
    await this.reserve('anthropic');
    const request = buildClaudeJsonRequest({
      model: this.cfg.models.textModel, effort: this.cfg.models.captionEffort, maxTokens: this.cfg.models.maxTokens,
      systemPrompt: f.system_prompt_text, content: userPrompt, schema: this.cfg.captionSchema,
    });
    return { request, verified_fact_count: facts.length };
  }

  // ── 6. apply caption: gates, compose, hash, validate ─────────────────────

  async applyCaption(f: Fence & { post_id: string; response: Json; prompt_version?: number | null }) {
    await this.fence(f);
    const { post, c, asset, facts, disclosure } = await this.captionInputs(f.post_id);
    const parsed = parseCaptionResponse(f.response);
    if (!parsed.ok) return { ok: false as const, status: 'draft', reason: `caption_${parsed.reason}`, detail: parsed.detail, retryable: parsed.retryable };

    const caption = parsed.caption as Record<string, unknown> & { caption_derja: string; caption_en: string; hashtags: string[] };
    const gate = validateCaption(caption, {
      image_origin: c.image_origin, source_attribution: asset.attributionText ?? null, disclosure_text: disclosure.text, fact_ids: facts.map((x) => x.id),
    }, this.cfg.promptsConfig);
    const finalText = composeCaption(caption, disclosure);
    const hash = contentHash(finalText, asset.sha256!);
    const problems = [...gate.problems];
    if (await this.db.post.findFirst({ where: { contentHash: hash, id: { not: post.id } } })) problems.push('duplicate content (same caption and image as an existing post)');

    await this.db.post.update({
      where: { id: post.id },
      data: {
        title: String(caption.title ?? ''), captionDerja: caption.caption_derja, captionEn: caption.caption_en, hashtags: caption.hashtags,
        altText: String(caption.alt_text ?? ''), disclosureDerja: disclosure.derja, disclosureEn: disclosure.en,
        supportedClaims: (caption.supported_claims ?? []) as object, reviewReasons: problems,
        contentHash: problems.length ? null : hash, captionModel: parsed.model, captionPromptVersion: f.prompt_version ?? null,
        langfuseTraceId: `post:${post.id}`,
      },
    });
    const status = problems.length ? 'needs_review' : 'validated';
    await this.transition(post.id, status, problems.length ? problems.join('; ').slice(0, 500) : 'all caption gates passed', f.worker);
    return {
      ok: true as const, status, problems, final_text: finalText,
      trace: { generation_name: 'caption', model: parsed.model, input: { origin: c.image_origin, facts: facts.length }, output: { status, problems, caption }, usage_input: parsed.usage?.input_tokens ?? 0, usage_output: parsed.usage?.output_tokens ?? 0 },
    };
  }

  // ── 7. schedule ──────────────────────────────────────────────────────────

  async schedule(f: Fence & { post_id: string }) {
    await this.fence(f);
    const post = await this.loadPost(f.post_id);
    if (post.status !== 'validated') throw new HttpError(409, 'not_validated', `post is ${post.status}`);
    const when = post.slot.slotAt > new Date() ? post.slot.slotAt : new Date();
    await this.db.post.update({ where: { id: post.id }, data: { scheduledFor: when } });
    const created = await this.db.$queryRaw<{ n: number }[]>`SELECT tn_create_publications(${post.id}::uuid) AS n`;
    await this.transition(post.id, 'scheduled', `scheduled for ${when.toISOString()}`, f.worker);
    await this.completeSlot(f, 'produced', null);
    return { ok: true as const, post_id: post.id, scheduled_for: when, publications: Number(created[0]?.n ?? 0) };
  }

  // ── 8. park: stop this attempt safely ────────────────────────────────────

  /**
   * retry       → release the lease; the next trigger re-claims (bounded by slot_max_attempts)
   * needs_review/skipped/failed → park the post, close the slot, never publish
   */
  async park(f: Fence & { post_id?: string | null; outcome: 'retry' | 'needs_review' | 'skipped' | 'failed'; stage: string; reason: string; details?: Json }) {
    const post = f.post_id ? await this.db.post.findUnique({ where: { id: f.post_id } }) : null;
    await this.logError({
      stage: f.stage, message: f.reason, slot_id: f.slot_id, post_id: post?.id ?? null, location_id: post?.locationId ?? null,
      code: f.outcome, retryable: f.outcome === 'retry', details: f.details ?? null,
    });
    if (f.outcome === 'retry') {
      const released = await this.db.$executeRaw`
        UPDATE publish_slots SET lease_expires_at = now() - interval '1 millisecond', last_error = ${f.reason.slice(0, 500)}
         WHERE id = ${f.slot_id}::uuid AND status = 'claimed' AND claimed_by = ${f.worker} AND lease_expires_at > now()`;
      return { ok: true as const, outcome: 'retry', released: released > 0 };
    }
    if (post && !['needs_review', 'skipped', 'failed', 'published'].includes(post.status)) {
      try {
        await this.transition(post.id, f.outcome, `${f.stage}: ${f.reason}`.slice(0, 500), f.worker);
      } catch (err) {
        await this.logError({ stage: 'park', message: `could not move post to ${f.outcome}: ${(err as Error).message}`, slot_id: f.slot_id, post_id: post.id });
      }
    }
    const completed = await this.completeSlot(f, f.outcome === 'failed' ? 'failed' : 'skipped', `${f.stage}: ${f.reason}`.slice(0, 500));
    return { ok: true as const, outcome: f.outcome, slot_completed: completed };
  }
}
