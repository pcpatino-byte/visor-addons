// Motor Balandro MULTI-SITIO — amplía el rastreo con los canales de Balandro
// que usan APIs/estructuras verificadas:
//
//   HackTorrent (hacktorrent.cc) — VERIFICADO EN VIVO:
//     - Búsqueda:  GET {host}wp-json/wpreact/v1/search?query=X&posts_per_page=20&page=1
//                  -> { results: [{type: 'pelicula'|'serie', slug, title, language}] }
//     - Película:  GET {host}wp-json/wpreact/v1/movie/{slug}
//                  -> downloads[] con quality/download_link(MAGNET directo)/language
//     - Serie:     GET {host}wp-json/wpreact/v1/serie/{slug}/related/
//                  -> downloads[] (acortalink, se difiere a /resolve)
//                  -> embeds[]   (lang "Latino" explícito, se difiere a /resolve)
//
// El idioma VIENE ETIQUETADO por el sitio ("Latino", "Latino/Inglés"):
// se propaga al rawTitle para que el pipeline valide la política LATINO.

const axios = require('axios');

const HACK_HOST = 'https://hacktorrent.cc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchJson(url, referer) {
  const response = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(referer ? { Referer: referer } : {}) }
  });
  return response.data;
}

// "Latino/Inglés", "Latino - Inglés", "Latino", "Latino/Japonés" -> contiene latino
function isLatinoLabel(lang) {
  return /latino/i.test(lang || '');
}

function tagTitle(title, lang, quality) {
  return `${title} [${quality || 'HD'}] [${lang}]`.replace(/\s+/g, ' ').trim();
}

async function searchHackTorrent(titleQuery, { season, episode, resolveBase } = {}) {
  const base = resolveBase || `http://127.0.0.1:${process.env.PORT || 7001}`;
  const streams = [];

  const search = await fetchJson(
    `${HACK_HOST}/wp-json/wpreact/v1/search?query=${encodeURIComponent(titleQuery)}&posts_per_page=20&page=1`
  );
  const results = search?.results || [];
  if (results.length === 0) return streams;

  const item = results.find(r => r.type === (season != null ? 'serie' : 'pelicula'))
    || results.find(r => season == null && r.type === 'pelicula');
  if (!item) return streams;

  if (season != null) {
    // --- SERIE: related/ -> downloads (acortalink) + embeds (Latino) ---
    const rel = await fetchJson(`${HACK_HOST}/wp-json/wpreact/v1/serie/${item.slug}/related/`);
    const sTag = `${season}x${String(episode).padStart(2, '0')}`;

    const eps = (rel?.downloads || []).filter(d =>
      Number(d.season) === Number(season) && (episode == null || Number(d.episode) === Number(episode))
    );
    const embeds = (rel?.embeds || []).filter(e =>
      Number(e.season) === Number(season) && (episode == null || Number(e.episode) === Number(episode))
    );

    const link = eps[0]?.download_link;
    if (link && /acortalink|s\.php/i.test(link)) {
      streams.push({
        rawTitle: `${tagTitle(item.title, eps[0].language || 'Latino', eps[0].quality)} ${sTag} [Torrent]`,
        url: `${base}/resolve?p=${Buffer.from(JSON.stringify({
          e: 'acorta', link, referer: `${HACK_HOST}/serie/${item.slug}/`
        })).toString('base64')}`,
        source: 'HackTorrent 🇲🇽 [Torrent]',
        seeders: 0,
        size: 0
      });
    }

    embeds.slice(0, 2).forEach(em => {
      if (!isLatinoLabel(em.lang)) return;
      streams.push({
        rawTitle: `${tagTitle(item.title, em.lang || 'Latino', em.quality)} ${sTag} [Web]`,
        url: `${base}/resolve?p=${Buffer.from(JSON.stringify({
          e: 'acorta', link: em.url, referer: `${HACK_HOST}/serie/${item.slug}/`, isEmbed: true
        })).toString('base64')}`,
        source: 'HackTorrent 🇲🇽 [Web]',
        seeders: 0,
        size: 0
      });
    });
  } else {
    // --- PELÍCULA: movie JSON con MAGNETS DIRECTOS + idioma etiquetado ---
    const data = await fetchJson(`${HACK_HOST}/wp-json/wpreact/v1/movie/${item.slug}`);
    const downloads = data?.downloads || data || [];
    const list = Array.isArray(downloads) ? downloads : (downloads.downloads || []);

    const resolved = await Promise.allSettled(list.map(d => {
      if (!d.download_link) return Promise.resolve(null);
      const lang = d.language || '';
      // Solo etiquetas con latino explícito (política del addon)
      if (!isLatinoLabel(lang)) return Promise.resolve(null);
      return Promise.resolve(d);
    }));

    resolved.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value) return;
      const d = r.value;
      const link = d.download_link;
      if (!link.startsWith('magnet:') && !link.endsWith('.torrent')) return; // acortalink en movies: deferir
      streams.push({
        rawTitle: tagTitle(item.title, d.language || 'Latino', d.quality),
        url: link,
        source: 'HackTorrent 🇲🇽 [Torrent]',
        seeders: 0,
        size: 0
      });
    });
  }

  return streams;
}

// --- Resolución play-time para enlaces deferidos de este motor ---
async function resolveAcorta(payload, decryptAcortalink) {
  if (!payload || payload.e !== 'acorta' || !payload.link) return null;

  // Enlaces directos (magnet) no deberían llegar aquí, pero por si acaso
  if (payload.link.startsWith('magnet:')) return payload.link;

  if (payload.isEmbed) {
    // Embed web: intentar m3u8/mp4 directo
    try {
      const axios = require('axios');
      const r = await axios.get(payload.link, {
        timeout: 8000,
        headers: { 'User-Agent': UA, Referer: payload.referer || HACK_HOST }
      });
      const text = String(r.data || '');
      const m = text.match(/"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/i) || text.match(/file\s*:\s*"(https?:\/\/[^"]+)"/i);
      if (m) return m[1];
    } catch (e) { /* embed cifrado */ }
    return null;
  }

  // Acortalink: descifrado GibberishAES (key en página o POST linkser)
  return decryptAcortalink(payload.link, payload.referer);
}

async function fetchBalandroMulti(titleQuery, opts = {}) {
  if (!titleQuery) return [];
  try {
    const streams = await searchHackTorrent(titleQuery, opts);
    console.log(`✅ BalandroMulti [HackTorrent]: ${streams.length} streams latinos.`);
    return streams;
  } catch (error) {
    console.error(`❌ BalandroMulti Error: ${error.message}`);
    return [];
  }
}

module.exports = { fetchBalandroMulti, resolveAcorta };
