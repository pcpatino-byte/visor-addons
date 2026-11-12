// Motor TORRENTS-API — reemplaza a Prowlarr para despliegue en la nube gratis.
// APIs públicas sin Cloudflare ni servidor propio (verificado en vivo):
//   - TPB apibay (https://apibay.org/q.php?q=...) → películas y series, 100+ resultados
//   - YTS API (https://yts.mx/api/v2/list_movies.json) → películas 1080p/2160p (best-effort)
// Formato de salida idéntico al motor Prowlarr para reutilizar el pipeline.

const axios = require('axios');
const cheerio = require('cheerio');

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Knaben (agregador SIN Cloudflare: funciona desde IPs de datacenter) ---
// Búsqueda: GET https://knaben.org/search?q=X
// Filas <tr> con <a title="Título" href="magnet:?xt=urn:btih:HASH...">
async function fetchKnaben(query) {
  try {
    const response = await axios.get(`https://knaben.org/search?q=${encodeURIComponent(query)}`, {
      timeout: 12000,
      headers: { 'User-Agent': UA }
    });
    const html = String(response.data || '');
    if (!html.includes('magnet:?xt=urn:btih:')) return [];

    const $ = cheerio.load(html);
    const out = [];
    $('tr').each((_, row) => {
      const $row = $(row);
      const anchor = $row.find('a[href^="magnet:?xt=urn:btih:"]').first();
      if (!anchor.length) return;
      const title = (anchor.attr('title') || anchor.text() || '').trim();
      let url = anchor.attr('href') || '';
      const hashMatch = url.match(/urn:btih:([a-zA-Z0-9]{40})/);
      if (!title || !hashMatch) return;
      // trackers si el magnet no los trae
      if (!url.includes('&tr=')) url += PUBLIC_TRACKERS;
      // seeds: celda numérica de la fila (la mayor suele ser seeds)
      let seeds = 0;
      $row.find('td').each((__, td) => {
        const n = parseInt($(td).text().replace(/[^\d]/g, ''), 10);
        if (!isNaN(n) && n > seeds && n < 1000000) seeds = n;
      });
      const lower = title.toLowerCase();
      const isLatinoOrDual = lower.includes('latino') || lower.includes('spanish') ||
        lower.includes('dual') || lower.includes('multi') || lower.includes('español') ||
        lower.includes('espanol') || lower.includes('latam');
      out.push({
        rawTitle: title,
        url,
        infoHash: hashMatch[1] || null,
        source: isLatinoOrDual ? 'Knaben 🇲🇽 [Latino]' : 'Knaben 🌐 [Torrent]',
        seeders: seeds,
        size: 0,
        isLatinoOrDual
      });
    });
    return out
      .filter(it => it.seeders >= 1)
      .sort((a, b) => (b.isLatinoOrDual ? 1 : -1) - (a.isLatinoOrDual ? 1 : -1) || b.seeders - a.seeders);
  } catch (e) {
    return [];
  }
}

// --- TPB apibay ---
async function fetchTPB(query) {
  // apibay throttlea ráfagas: 2 intentos con pausa
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
        timeout: 8000,
        headers: { 'User-Agent': UA }
      });
      const items = response.data;
      if (!Array.isArray(items)) return [];
      const valid = items.filter(it => it.info_hash && it.name && !/^No results/i.test(it.name || ''));
      if (valid.length > 0 || attempt === 1) {
        return valid.map(it => {
          const title = it.name || '';
          const seeds = parseInt(it.seeders, 10) || 0;
          const lower = title.toLowerCase();
          const isLatinoOrDual = lower.includes('latino') || lower.includes('lat') ||
            lower.includes('dual') || lower.includes('multi') || lower.includes('spanish') ||
            lower.includes('español') || lower.includes('espanol');
          return {
            rawTitle: title,
            url: `magnet:?xt=urn:btih:${it.info_hash}&dn=${encodeURIComponent(title)}${PUBLIC_TRACKERS}`,
            infoHash: it.info_hash || null,
            source: isLatinoOrDual ? 'TPB 🇲🇽 [Latino]' : 'TPB 🌐 [Torrent]',
            seeders,
            size: parseInt(it.size, 10) || 0,
            isLatinoOrDual
          };
        })
        .filter(it => it.seeders >= 1)
        .sort((a, b) => (b.isLatinoOrDual ? 1 : -1) - (a.isLatinoOrDual ? 1 : -1) || b.seeders - a.seeders);
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      if (attempt === 1) return [];
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return [];
}
// --- YTS (películas, best-effort) ---
async function fetchYTS(query) {
  try {
    const response = await axios.get('https://yts.mx/api/v2/list_movies.json', {
      params: { query_term: query, limit: 20 },
      timeout: 8000,
      headers: { 'User-Agent': UA }
    });
    const movies = response.data?.data?.movies || [];
    const out = [];
    movies.forEach(m => {
      (m.torrents || []).forEach(t => {
        const lower = (m.title + ' ' + (t.title || '')).toLowerCase();
        const isLatino = lower.includes('latino') || lower.includes('spanish');
        out.push({
          rawTitle: `${m.title_long} [${t.quality}] [${t.type}]`,
          url: t.url, // .torrent URL de YTS (directa)
          infoHash: t.hash || null,
          source: isLatino ? 'YTS 🇲🇽 [Latino]' : 'YTS 🌐 [Torrent]',
          seeders: t.seeds || 0,
          size: t.size_bytes || 0,
          isLatinoOrDual: isLatino
        });
      });
    });
    return out.sort((a, b) => (b.isLatinoOrDual ? 1 : -1) - (a.isLatinoOrDual ? 1 : -1) || b.seeders - a.seeders);
  } catch (e) {
    return [];
  }
}

/**
 * Búsqueda API pública sin Prowlarr.
 * apibay matchea LITERAL: se prueban variantes (espacios, puntos, fragmento,
 * token distintivo) hasta obtener resultados.
 */
async function fetchTorrentsApi(imdbId, extra = null) {
  const mediaType = extra?.type || 'movie';
  const mediaName = extra?.title || '';
  if (!mediaName) return [];

  const base = mediaName.replace(/[:\-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  const simplified = base.split(' ')[0] || base;
  const tokens = base.split(' ').filter(t => t.length >= 4);
  const lastToken = tokens[tokens.length - 1] || simplified;

  const variants = [...new Set([
    mediaType === 'series' && extra?.season && extra?.episode
      ? `${base} S${String(extra.season).padStart(2, '0')}E${String(extra.episode).padStart(2, '0')}` : null,
    base,
    base.replace(/\s+/g, '.'),
    simplified,
    lastToken
  ].filter(v => v && v.length >= 3))];

  let results = [];
  // Knaben primero (sin Cloudflare: sirve desde datacenter), variantes incluidas
  for (const q of variants.slice(0, 3)) {
    console.log('🌐 TorrentsAPI: Knaben "' + q + '"...');
    results = await fetchKnaben(q);
    if (results.length >= 3) break;
    await new Promise(r => setTimeout(r, 600));
  }

  // apibay de respaldo (funciona desde IPs residenciales; CF bloquea datacenter)
  if (results.length < 3) {
    for (const q of variants.slice(0, 2)) {
      const tpb = await fetchTPB(q);
      results = [...results, ...tpb];
      if (results.length >= 3) break;
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // series: si solo hay resultados generales, reintenta por temporada
  if (results.length === 0 && mediaType === 'series' && extra?.season) {
    const alt = `${simplified} S${String(extra.season).padStart(2, '0')}`;
    results = await fetchTPB(alt);
  }

  if (mediaType === 'movie') {
    const yts = await fetchYTS(mediaName);
    results = [...results, ...yts];
  }

  // excluir castellano de España como hace el motor Prowlarr
  const filtered = results.filter(it => {
    const t = it.rawTitle.toLowerCase();
    if (t.includes('castellano') || t.includes('spain') || t.includes('.es.') || t.includes('españa')) return false;
    return true;
  });

  console.log(`✅ TorrentsAPI: ${filtered.length} torrents (${mediaType})`);
  return filtered;
}

module.exports = { fetchTorrentsApi };
