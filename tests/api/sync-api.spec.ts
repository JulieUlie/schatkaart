import { test, expect, APIRequestContext } from '@playwright/test';
import { randomBytes } from 'node:crypto';

/**
 * The sync endpoint stores one encrypted blob per sync code, under the SHA-256 of that code.
 * It never sees the code or the contents: it only checks the shape, the size and the revision.
 */
const newId = () => randomBytes(32).toString('hex'); // what the browser sends: a 64-character hex hash
const box = (ct = 'c2VjcmV0') => ({ iv: 'AAAAAAAAAAAAAAAA', ct });
const put = (request: APIRequestContext, id: string, data: unknown) => request.put(`/api/sync/${id}`, { data });

test.describe('Health', () => {
  test('reports that sync is available', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sync: true });
  });
});

test.describe('Storing and reading', () => {
  test('an unknown code is empty (404)', async ({ request }) => {
    const res = await request.get(`/api/sync/${newId()}`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'empty' });
  });

  test('stores a blob and gives it back with revision 1', async ({ request }) => {
    const id = newId();

    const saved = await put(request, id, { box: box(), baseRev: 0 });
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toEqual({ rev: 1 });

    const res = await request.get(`/api/sync/${id}`);
    const body = await res.json();
    expect(body).toMatchObject({ rev: 1, box: box() });
    expect(Date.parse(body.updatedAt)).not.toBeNaN();
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('every save raises the revision by one', async ({ request }) => {
    const id = newId();
    for (let rev = 0; rev < 3; rev++) {
      expect(await (await put(request, id, { box: box(`v${rev}`), baseRev: rev })).json()).toEqual({ rev: rev + 1 });
    }
    expect((await (await request.get(`/api/sync/${id}`)).json()).box.ct).toBe('v2');
  });

  test('a save based on an old revision is refused (409), so devices cannot overwrite each other', async ({ request }) => {
    const id = newId();
    await put(request, id, { box: box('phone'), baseRev: 0 });

    const stale = await put(request, id, { box: box('laptop'), baseRev: 0 });

    expect(stale.status()).toBe(409);
    expect(await stale.json()).toEqual({ error: 'conflict', rev: 1 });
    expect((await (await request.get(`/api/sync/${id}`)).json()).box.ct).toBe('phone');
  });

  test('stores only the iv and the ciphertext, nothing else that is sent', async ({ request }) => {
    const id = newId();
    await put(request, id, { box: { ...box(), name: 'Charizard' }, baseRev: 0, note: 'hello' });

    const stored = await (await request.get(`/api/sync/${id}`)).json();

    expect(Object.keys(stored).sort()).toEqual(['box', 'rev', 'updatedAt']);
    expect(Object.keys(stored.box).sort()).toEqual(['ct', 'iv']);
  });

  test('delete removes the blob', async ({ request }) => {
    const id = newId();
    await put(request, id, { box: box(), baseRev: 0 });

    const del = await request.delete(`/api/sync/${id}`);

    expect(await del.json()).toEqual({ ok: true });
    expect((await request.get(`/api/sync/${id}`)).status()).toBe(404);
  });
});

test.describe('Refused requests', () => {
  const bad: [string, unknown, string][] = [
    ['no box', { baseRev: 0 }, 'bad_body'],
    ['a box without ciphertext', { box: { iv: 'AAAA' } }, 'bad_body'],
    ['an iv that is not text', { box: { iv: 12, ct: 'x' } }, 'bad_body'],
    ['an iv longer than 64 characters', { box: { iv: 'A'.repeat(65), ct: 'x' } }, 'bad_body'],
  ];
  for (const [title, data, error] of bad) {
    test(`400 for ${title}`, async ({ request }) => {
      const res = await put(request, newId(), data);
      expect(res.status()).toBe(400);
      expect(await res.json()).toEqual({ error });
    });
  }

  test('400 for a body that is not JSON', async ({ request }) => {
    const res = await request.put(`/api/sync/${newId()}`, { data: Buffer.from('{"box":'), headers: { 'content-type': 'application/json' } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_json' });
  });

  test('413 for a collection over 8 MB', async ({ request }) => {
    const res = await put(request, newId(), { box: box('x'.repeat(8 * 1024 * 1024 + 1)), baseRev: 0 });
    expect(res.status()).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
  });

  for (const [title, path] of [['a code that is not a 64-character hash', '/api/sync/abc'], ['upper-case hex', `/api/sync/${newId().toUpperCase()}`], ['an unknown endpoint', '/api/cards']]) {
    test(`404 for ${title}`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });
  }

  test('405 with an Allow header for POST', async ({ request }) => {
    const res = await request.post(`/api/sync/${newId()}`, { data: { box: box() } });
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('GET, PUT, DELETE');
  });
});
