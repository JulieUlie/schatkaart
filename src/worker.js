// Schatkaart Worker: serves the app from ./site and answers /api/* for the optional sync.
// Collections live in each visitor's own browser. Sync only stores an encrypted blob under the
// SHA-256 of a random code the visitor generated; the Worker never sees the code or the contents.

const MAX_BYTES = 8 * 1024 * 1024;
const SYNC_PATH = /^\/api\/sync\/([a-f0-9]{64})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

async function api(request, env, url) {
  if (url.pathname === '/api/health') return json({ ok: true, sync: !!env.SYNC });

  const m = url.pathname.match(SYNC_PATH);
  if (!m) return json({ error: 'not_found' }, 404);
  if (!env.SYNC) return json({ error: 'sync_not_configured' }, 503);
  const key = 'c:' + m[1];

  switch (request.method) {
    case 'GET': {
      const value = await env.SYNC.get(key, 'json');
      return value ? json(value) : json({ error: 'empty' }, 404);
    }
    case 'PUT': {
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > MAX_BYTES) return json({ error: 'too_large' }, 413);
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: 'too_large' }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400); }
      const box = body?.box;
      if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string' || box.iv.length > 64) {
        return json({ error: 'bad_body' }, 400);
      }
      const current = await env.SYNC.get(key, 'json');
      const rev = current?.rev ?? 0;
      if ((body.baseRev ?? 0) !== rev) return json({ error: 'conflict', rev }, 409);
      const next = { rev: rev + 1, updatedAt: new Date().toISOString(), box: { iv: box.iv, ct: box.ct } };
      await env.SYNC.put(key, JSON.stringify(next));
      return json({ rev: next.rev });
    }
    case 'DELETE':
      await env.SYNC.delete(key);
      return json({ ok: true });
    default:
      return json({ error: 'method_not_allowed' }, 405, { allow: 'GET, PUT, DELETE' });
  }
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
