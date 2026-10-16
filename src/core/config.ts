// tn-core configuration from environment + repo prompt files. No third-party API keys here:
// model and Graph API calls are made by n8n with its own credentials; tn-core only builds the requests.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface CoreConfig {
  port: number;
  token: string;
  databaseUrl: string;
  s3: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; publicBaseUrl: string };
  models: {
    textModel: string; captionEffort: string; auditEffort: string; maxTokens: number;
    imageModel: string; imageSize: string; aspectRatio: string;
  };
  /** Meta Graph API ids (not secrets). The access token is an n8n credential, never seen here. */
  meta: { graphBaseUrl: string; graphVersion: string; pageId: string | null; igUserId: string | null };
  promptsConfig: Record<string, unknown> & {
    hashtag_max: number; caption_derja_max_chars: number; caption_en_max_chars: number; alt_text_max_chars: number;
    ai_alt_text_prefix: string; disclosure: Record<string, { derja: string; en: string }>;
  };
  captionSchema: object;
  auditSchema: object;
}

const req = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const promptsDir = env.PROMPTS_DIR ?? resolve(repoRoot, 'prompts');
  const json = (p: string) => JSON.parse(readFileSync(resolve(promptsDir, p), 'utf8'));
  const token = req(env, 'TN_CORE_TOKEN');
  if (token.length < 32) throw new Error('TN_CORE_TOKEN must be at least 32 characters');
  return {
    port: Number(env.TN_CORE_PORT ?? 8080),
    token,
    databaseUrl: req(env, 'DATABASE_URL'),
    s3: {
      endpoint: req(env, 'S3_ENDPOINT'),
      bucket: req(env, 'S3_BUCKET'),
      region: env.S3_REGION || 'auto',
      accessKeyId: req(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: req(env, 'S3_SECRET_ACCESS_KEY'),
      publicBaseUrl: req(env, 'S3_PUBLIC_BASE_URL').replace(/\/$/, ''),
    },
    models: {
      textModel: env.ANTHROPIC_TEXT_MODEL || 'claude-opus-5-5',
      captionEffort: env.ANTHROPIC_EFFORT || 'medium',
      auditEffort: env.ANTHROPIC_AUDIT_EFFORT || 'low',
      maxTokens: Number(env.ANTHROPIC_MAX_TOKENS || 16000),
      imageModel: env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
      imageSize: env.GEMINI_IMAGE_SIZE || '2K',
      aspectRatio: env.GEMINI_IMAGE_ASPECT_RATIO || '4:5',
    },
    meta: {
      graphBaseUrl: env.META_GRAPH_BASE_URL || 'https://graph.facebook.com',
      graphVersion: env.META_GRAPH_VERSION || 'v26.0',
      pageId: env.META_PAGE_ID?.trim() || null,
      igUserId: env.META_IG_USER_ID?.trim() || null,
    },
    promptsConfig: json('config.json'),
    captionSchema: json('schemas/caption.schema.json'),
    auditSchema: json('schemas/image-audit.schema.json'),
  };
}
