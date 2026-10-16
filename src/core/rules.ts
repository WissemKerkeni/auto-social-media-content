// Deterministic content rules used by tn-core. Pure functions.
import { createHash } from 'node:crypto';

export type ImageOrigin = 'ai_generated' | 'licensed_photo' | 'licensed_photo_enhanced';

/** Light matching the slot's local time, so the image fits when it is posted. */
export function timeOfDay(localTime: string): string {
  const h = Number(localTime.slice(0, 2));
  if (h < 8) return 'soft early-morning light with a low sun and gentle haze';
  if (h < 10) return 'clear fresh morning light';
  if (h < 14) return 'bright natural midday light with a few soft clouds';
  if (h < 17) return 'warm afternoon light with long gentle shadows';
  if (h < 19) return 'golden-hour light, warm and low';
  if (h < 21) return 'sunset glow with soft pink and orange tones';
  return 'calm blue-hour twilight just after sunset';
}

/** Rotate through a destination's scene briefs: n-th post at a destination gets brief n mod len. */
export function chooseSceneBrief(briefs: string[], postsAtLocation: number): string {
  if (!briefs.length) throw new Error('destination has no scene_briefs');
  return briefs[postsAtLocation % briefs.length]!;
}

export const humanizeLandscape = (t: string): string => t.replace(/_/g, ' ');

/** Fill {{var}} placeholders; throws if any declared placeholder is left unfilled. */
export function compilePrompt(template: string, vars: Record<string, string | number | null | undefined>): string {
  const missing = new Set<string>();
  const out = template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null) { missing.add(k); return ''; }
    return String(v);
  });
  if (missing.size) throw new Error(`prompt variables missing: ${[...missing].join(', ')}`);
  return out;
}

/** SHA-256 over the normalized final post text plus the image hash: identical posts collide. */
export function contentHash(finalText: string, imageSha256: string): string {
  const normalized = finalText.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${normalized}\n${imageSha256}`).digest('hex');
}

export interface ImageAudit {
  description: string;
  contains_text_or_letters: boolean;
  contains_watermark_logo_or_signature: boolean;
  contains_people: boolean;
  contains_animals: boolean;
  contains_buildings_or_infrastructure: boolean;
  buildings_detail: string;
  contains_paths_or_tracks: boolean;
  looks_photorealistic: boolean;
  has_visual_defects: boolean;
  defects_detail: string;
  plausible_for_landscape_type: boolean;
  matches_scene_brief: boolean;
  overall_quality: 'excellent' | 'good' | 'acceptable' | 'poor';
  notes: string;
}

/**
 * Decide from the vision audit. Any hard rule failing quarantines the image; nothing is
 * published on a model's say-so alone — the model reports observations, this code decides.
 */
export function decideAudit(a: ImageAudit, origin: ImageOrigin): { approved: boolean; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (a.contains_text_or_letters) problems.push('text or letters in the image');
  if (a.contains_watermark_logo_or_signature) problems.push('watermark, logo or signature');
  if (a.contains_people) problems.push('people in the image');
  if (a.has_visual_defects) problems.push(`visual defects: ${a.defects_detail || 'unspecified'}`);
  if (a.overall_quality === 'poor') problems.push('poor overall quality');

  if (origin === 'ai_generated') {
    // AI scenes must not invent wildlife or human presence, and must look like real photography.
    if (a.contains_animals) problems.push('animals in an AI scene (no invented wildlife)');
    if (a.contains_buildings_or_infrastructure) problems.push(`buildings or infrastructure in an AI scene: ${a.buildings_detail || 'unspecified'}`);
    if (a.contains_paths_or_tracks) warnings.push('faint paths or tracks (natural-looking; allowed)');
    if (!a.looks_photorealistic) problems.push('not photorealistic');
    if (!a.plausible_for_landscape_type) problems.push('not plausible for this Tunisian landscape type');
    if (!a.matches_scene_brief) warnings.push('does not closely match the scene brief');
  } else {
    if (!a.plausible_for_landscape_type) warnings.push('audit doubts the landscape type (real photo kept)');
  }
  if (!a.description?.trim()) problems.push('audit returned no description');
  return { approved: problems.length === 0, problems, warnings };
}
