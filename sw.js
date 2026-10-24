/* Soldier Boy phone test — service worker.
 *
 * Static hosts (GitHub Pages) cannot send "Content-Encoding: gzip" for Unity's
 * pre-compressed files and refuse single files over 100 MB. The build is split
 * into gzip chunks; this worker serves each game file as one decompressed
 * stream with an exact Content-Length, so Unity shows real progress and no
 * second full copy of the game sits in page memory. Chunks are cached under
 * their content hash, so a second launch starts without downloading again.
 */
const VERSION = '2026.10.24.1-web-e28f4883a7e2';
const CHUNK_CACHE = 'sb-chunks-v1';
let manifestPromise = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(new URL('game/build.json?sw=' + Date.now(), self.registration.scope), { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('build.json ' + r.status); return r.json(); })
      .catch(e => { manifestPromise = null; throw e; });
  }
  return manifestPromise;
}

async function chunkBytes(cache, url) {
  const hit = cache ? await cache.match(url) : null;
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url);
      const buffer = await response.arrayBuffer();
      if (cache) cache.put(url, new Response(buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
      return new Uint8Array(buffer);
    } catch (e) { lastError = e; await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
  }
  throw lastError;
}

async function serveGameFile(name) {
  const manifest = await loadManifest();
  const entry = manifest.files[name];
  if (!entry) return new Response('Not found', { status: 404 });
  let cache = null;
  try { cache = await caches.open(CHUNK_CACHE); } catch (_) { cache = null; }
  const urls = entry.chunks.map(c => new URL(c, self.registration.scope).href);
  let index = 0;
  // Fetch one chunk ahead while the current one decompresses.
  let pending = urls.length ? chunkBytes(cache, urls[0]) : null;
  const compressed = new ReadableStream({
    async pull(controller) {
      if (index >= urls.length) { controller.close(); return; }
      try {
        const bytes = await pending;
        index++;
        pending = index < urls.length ? chunkBytes(cache, urls[index]) : null;
        controller.enqueue(bytes);
      } catch (e) { controller.error(e); }
    }
  });
  const body = compressed.pipeThrough(new DecompressionStream('gzip'));
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.uncompressedBytes), 'Cache-Control': 'no-store' }
  });
}

async function pruneChunks() {
  // Keep only chunks named by the current build.
  try {
    const manifest = await loadManifest();
    const keep = new Set();
    for (const f of Object.values(manifest.files)) for (const c of f.chunks) keep.add(new URL(c, self.registration.scope).href);
    const cache = await caches.open(CHUNK_CACHE);
    for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
  } catch (_) { /* offline or no cache: nothing to prune */ }
}

self.addEventListener('message', event => {
  if (event.data === 'prune') event.waitUntil(pruneChunks());
  if (event.data === 'refresh') manifestPromise = null;
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname + 'game/stream/')) return;
  const name = decodeURIComponent(url.pathname.slice((scope.pathname + 'game/stream/').length));
  event.respondWith(serveGameFile(name).catch(e => new Response('Game file failed: ' + e, { status: 502 })));
});
