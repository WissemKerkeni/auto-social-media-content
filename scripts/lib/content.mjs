// Deterministic post text: disclosure lines and the final Derja-first / English-second caption.
// Disclosure is never written by the model — it is filled from prompts/config.json templates.

export const IMAGE_ORIGINS = ['ai_generated', 'licensed_photo_enhanced', 'licensed_photo'];

const fill = (template, values) => template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => values[k] ?? '').replace(/\s+$/u, '').replace(/\s{2,}/g, ' ');

/**
 * Bilingual disclosure for an image origin.
 * @returns {{ derja: string, en: string, text: string }} text = derja + "\n" + en (what the model must echo)
 */
export function buildDisclosure({ origin, placeAr, placeEn, attribution = null }, config) {
  const tpl = config.disclosure?.[origin];
  if (!tpl) throw new Error(`no disclosure template for image origin "${origin}"`);
  if (origin !== 'ai_generated' && !attribution) throw new Error(`origin "${origin}" requires an attribution (license credit)`);
  const values = { place_ar: placeAr, place_en: placeEn, attribution: attribution ?? '' };
  const derja = fill(tpl.derja, values);
  const en = fill(tpl.en, values);
  return { derja, en, text: `${derja}\n${en}` };
}

/**
 * Final caption body: Derja block first, English block second, each followed by its own
 * disclosure line, then hashtags. Order is fixed here and never left to the model.
 */
export function composeCaption({ caption_derja, caption_en, hashtags }, disclosure) {
  return [
    caption_derja.trim(),
    disclosure.derja,
    '',
    caption_en.trim(),
    disclosure.en,
    '',
    hashtags.join(' '),
  ].join('\n');
}
