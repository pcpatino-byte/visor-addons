// Motor 1337x — el indexer bloqueado por Cloudflare en Prowlarr, resuelto
// AQUÍ directamente con FlareSolverr (sin depender del health-check de Prowlarr).
// Espejos probados en vivo: 1337x.st (FS ✅), x1337x.cc (FS), 1337x.to (error)
//
// Búsqueda:  {mirror}search/{query}/1/
// Ficha:     {mirror}torrent/{id}/{slug}/  -> <a href="magnet:?xt=...">

const { fetchWithAntiblock } = require('./antiblock');

const MIRRORS = ['https://1337x.st/', 'https://x1337x.cc/', 'https://1337x.to/'];

function parseResults(html) {
  const out = [];
  // fila: <td class="coll-1 name">...<a href="/sub/../">icon</a><a href="/torrent/ID/slug/">Título</a>...
  const re = /<td class="coll-1 name[^"]*">[\s\S]*?<a href="(\/torrent\/[^"]+)"[^>]*>([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].trim();
    // seeders en la celda siguiente: <td class="coll-2 seeds">3216</td>
    const tail = html.slice(m.index, m.index + 1200);
    const seedsMatch = tail.match(/coll-2 seeds[^>]*>\s*([\d,]+)/i);
    const seeds = seedsMatch ? parseInt(seedsMatch[1].replace(/,/g, ''), 10) : 0;
    if (href && title) out.push({ href, title, seeds });
  }
  return out;
}

async function fetchDetailMagnet(mirror, href) {
  const { html } = await fetchWithAntiblock(mirror.replace(/\/$/, '') + href, { timeout: 9000 });
  if (!html) return null;
  const m = html.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
  if (!m) return null;
  // el magnet viene HTML-escapado (&tr=...)
  return m[1].replace(/&amp;/g, '&');
}

async function fetch1337x(titleQuery, { maxResults = 4 } = {}) {
  if (!titleQuery) return [];
  const q = encodeURIComponent(titleQuery).replace(/%20/g, '+');
  const tokens = titleQuery.toLowerCase().split(' ').filter(t => t.length >= 3);

  for (const mirror of MIRRORS) {
    const { html } = await fetchWithAntiblock(`${mirror}search/${q}/1/`, { timeout: 9000 });
    if (!html || !/torrent\//.test(html)) continue; // espejo caído/bloqueado -> siguiente

    const results = parseResults(html)
      .filter(r => tokens.some(t => r.title.toLowerCase().includes(t)))
      .slice(0, maxResults);

    const streams = [];
    const resolved = await Promise.allSettled(results.map(async (r) => {
      const magnet = await fetchDetailMagnet(mirror, r.href);
      if (!magnet) return null;
      return {
        rawTitle: r.title,
        url: magnet,
        source: '1337x 🌐 [Torrent]',
        seeders: r.seeds,
        size: 0
      };
    }));

    resolved.forEach(r => {
      if (r.status === 'fulfilled' && r.value) streams.push(r.value);
    });

    if (streams.length > 0 || results.length > 0) {
      console.log(`✅ 1337x (${mirror}): ${streams.length} magnets de ${results.length} resultados`);
      return streams;
    }
  }
  return [];
}

module.exports = { fetch1337x };
