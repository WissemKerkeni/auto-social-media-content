// Meta (Facebook Page + Instagram) setup helpers. Pure functions, unit-tested in tests/meta.test.mjs.

/** Permissions the Page access token needs for Phase D (Facebook Login path). */
export const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];

export const missingScopes = (granted) => REQUIRED_SCOPES.filter((s) => !(granted ?? []).includes(s));

/**
 * Choose the Page from GET /me/accounts. With an explicit id, that one; otherwise the only Page,
 * or the one named `preferName`. Returns { page } or { error }.
 */
export function pickPage(pages, { pageId, preferName } = {}) {
  if (!Array.isArray(pages) || !pages.length) return { error: 'this user manages no Pages (or pages_show_list was not granted)' };
  if (pageId) {
    const page = pages.find((p) => p.id === pageId);
    return page ? { page } : { error: `Page ${pageId} is not among the Pages this user manages: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}` };
  }
  if (pages.length === 1) return { page: pages[0] };
  const named = preferName ? pages.filter((p) => p.name?.toLowerCase() === preferName.toLowerCase()) : [];
  if (named.length === 1) return { page: named[0] };
  return { error: `several Pages found; re-run with --page-id <id>: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}` };
}

/**
 * Set KEY=value lines in dotenv text: replaces an existing assignment (first occurrence) or
 * appends it. Comments and every other line are kept as they are.
 */
export function setEnvValues(text, values) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(String(value))) throw new Error(`${key}: value must be a single line`);
    const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else {
      if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${value}`);
      else lines.push(`${key}=${value}`);
    }
  }
  return lines.join(eol);
}
