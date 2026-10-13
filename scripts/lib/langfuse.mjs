// Minimal Langfuse public-API client (no SDK dependency). Works with self-hosted v3/v4
// and Langfuse Cloud: prompts (/api/public/v2/prompts), ingestion, traces, health.
// Keys are only ever sent in the Authorization header; errors never include them.

export function createLangfuseClient({ baseUrl, publicKey, secretKey, timeoutMs = 10_000, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

  async function request(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  return {
    baseUrl: base,
    request,
    health: () => request('GET', '/api/public/health'),
    /** Current project for these keys (validates the key pair). */
    projects: () => request('GET', '/api/public/projects'),
    getPrompt: (name, label = 'production') =>
      request('GET', `/api/public/v2/prompts/${encodeURIComponent(name)}?label=${encodeURIComponent(label)}`),
    createPrompt: (prompt) => request('POST', '/api/public/v2/prompts', prompt),
    ingest: (batch) => request('POST', '/api/public/ingestion', { batch }),
    /**
     * Observations of one trace. Langfuse v4 (events_only) removed the v1 /traces and
     * /observations read APIs, so use /v2/observations and fall back to v1 for v3 deployments.
     * Resolves to an array (possibly empty).
     */
    async getTraceObservations(traceId) {
      const v2 = await request('GET', `/api/public/v2/observations?traceId=${encodeURIComponent(traceId)}&limit=50&fields=core,basic,io,usage,prompt,model,metadata`);
      if (v2.status === 200) return v2.json?.data ?? [];
      const v1 = await request('GET', `/api/public/traces/${encodeURIComponent(traceId)}`);
      return v1.status === 200 ? v1.json?.observations ?? [] : [];
    },
  };
}

/** Poll fn() until it returns a truthy value or the deadline passes. */
export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* retry until deadline */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
