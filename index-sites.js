// ADDON 2: Hybrid Sites [Web + Torrents] — epicentro multifuente con
// resolución play-time (/resolve) y capa antibloqueo FlareSolverr.
// Puerto 7003 (el 7001 lo usa el addon Prowlarr).

const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const env = require('./config/env');
const cache = require('./cache/database');
const { filterStreams } = require('./pipeline/filter');
const { scoreAndSortStreams } = require('./pipeline/scorer');
const { fetchAlfa, resolveAlfa } = require('./engines/alfa_hosters');
const { fetchCineCalidadLA, resolveCineCalidadLA } = require('./engines/cinecalidadla');
const { fetchBalandroMulti, resolveAcorta } = require('./engines/balandro_multi');
const { fetchChannels, resolveChannel } = require('./engines/channels61');
const { fetch1337x } = require('./engines/x1337');
const UA_PROXY = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const { fetchBalandro } = require('./engines/balandro_scraper');
const { decryptAcortalink } = require('./engines/linkcrypt');
const axios = require('axios');

const builder = new addonBuilder({
  id: 'org.stremio.hybridsites',
  version: '1.0.0',
  name: 'Hybrid Sites [Web + Torrents]',
  description: 'Sitios web latinos y torrents (CineCalidadLA, HackTorrent, Alfa, DonTorrent, EliteTorrent) con antibloqueo Cloudflare y resolución play-time.',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt', 'tmdb:']
});

async function getMediaTitle(contentId, type) {
  try {
    const endpoint = type === 'series' ? 'series' : 'movie';
    const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${endpoint}/${contentId}.json`, { timeout: 4000 });
    return response.data?.meta?.name || null;
  } catch (error) {
    return null;
  }
}

function parseContentId(rawId) {
  const parts = rawId.split(':');
  if (parts[0] === 'tmdb') {
    return {
      contentId: `tmdb:${parts[1]}`,
      season: parts[2] ? parseInt(parts[2], 10) : null,
      episode: parts[3] ? parseInt(parts[3], 10) : null
    };
  }
  return {
    contentId: parts[0],
    season: parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null
  };
}

function dedupe(streams) {
  const seen = new Set();
  return streams.filter(s => {
    const key = (s.infoHash || s.url || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildStreams(rawResults, { title, season, episode } = {}) {
  const filtered = filterStreams(rawResults, { allowOtherLanguages: false, title, season, episode, relaxedRelevance: true });
  const scored = scoreAndSortStreams(filtered);
  return dedupe(scored).map(item => {
    const meta = [item.resolution, item.language].filter(Boolean).join(' · ');
    return {
      name: meta ? `${item.source || 'Sites'} — ${meta}` : (item.source || 'Sites'),
      title: `${item.rawTitle}\n⚡ Enlace Web / Torrent`,
      url: item.url,
      infoHash: item.infoHash || undefined
    };
  });
}

// P2P cacheable; web (m3u8 con tokens) y /resolve no
function isCacheable(stream) {
  if (!stream) return false;
  const u = stream.url || '';
  // deferidos /resolve: URL estable (la resolución ocurre al dar play)
  if (u.includes('/resolve?p=')) return true;
  // magnets/infoHash: no expiran
  return u.startsWith('magnet:') || !!stream.infoHash;
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// El /resolve vive en ESTE addon (puerto Sites)
const RESOLVE_BASE = env.RESOLVE_BASE_URL || `http://127.0.0.1:${env.SITES_PORT || 7003}`;

async function runWithTimeout(promiseFn, timeoutMs) {
  return Promise.race([
    promiseFn(),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))
  ]);
}

async function searchAllSites(contentId, mediaTitle, queryTitle, season, episode) {
  const [alfaRes, cclaRes, multiRes, balandroRes] = await Promise.allSettled([
    runWithTimeout(() => fetchAlfa(contentId, queryTitle, { season, episode, resolveBase: RESOLVE_BASE }), env.GLOBAL_TIMEOUT_MS),
    runWithTimeout(() => fetchCineCalidadLA(queryTitle, { season, episode, resolveBase: RESOLVE_BASE }), env.GLOBAL_TIMEOUT_MS + 4000),
    runWithTimeout(() => fetchBalandroMulti(queryTitle, { season, episode, resolveBase: RESOLVE_BASE }), env.GLOBAL_TIMEOUT_MS + 4000),
    runWithTimeout(() => fetchBalandro(queryTitle, { season, episode }), 15000) // FlareSolverr
  ]);

  return {
    alfa: alfaRes.status === 'fulfilled' ? alfaRes.value : [],
    ccla: cclaRes.status === 'fulfilled' ? cclaRes.value : [],
    multi: multiRes.status === 'fulfilled' ? multiRes.value : [],
    balandro: balandroRes.status === 'fulfilled' ? balandroRes.value : []
  };
}

builder.defineStreamHandler(async (args) => {
  console.log(`🌐 [Sites] ${args.type} - ${args.id}`);

  const { contentId, season, episode } = parseContentId(args.id);
  const cacheKey = args.id.replace(/\.(json|txt)$/, '');

  // Caché P2P con stale-while-revalidate
  const cached = await cache.getCachedStreams(cacheKey).catch(() => null);
  if (cached && cached.length > 0) {
    console.log(`⚡ [Sites] caché P2P: ${cached.length} (refrescando en background)`);
    searchAllSites(contentId, null, null, season, episode).then(r => {
      const fresh = buildStreams([...r.channels, ...r.ccla, ...r.multi, ...r.alfa, ...r.balandro], {}).filter(isCacheable);
      if (fresh.length > 0) cache.saveStreamsToCache(cacheKey, fresh).catch(() => {});
    }).catch(() => {});
    return { streams: cached };
  }

  const mediaTitle = await getMediaTitle(contentId, args.type);
  if (!mediaTitle) return { streams: [] };

  // 1337x vía FlareSolverr tarda 60-90s: barrido en background, queda en caché
  fetch1337x(mediaTitle).then(st => {
    const mapped = buildStreams(st, { title: mediaTitle }).filter(isCacheable);
    if (mapped.length > 0) return cache.saveStreamsToCache(cacheKey, mapped);
  }).catch(() => {});

  console.log(`🌐 [Sites] buscando "${mediaTitle}" (S${season}E${episode})...`);

  // Canales (91): barrido lento en PARALELO; los rápidos no esperan de más.
  let chResults = [];
  const chDone = fetchChannels(mediaTitle, { season, episode, resolveBase: RESOLVE_BASE })
    .then(v => { chResults = v; return true; }, () => false);

  const r = await searchAllSites(contentId, mediaTitle, mediaTitle, season, episode);

  // gracia para que los canales rápidos lleguen (total ≤ ~20s)
  const chFast = await Promise.race([chDone, delay(6000).then(() => false)]);

  console.log(`📊 [Sites] Canales: ${chResults.length} (fast=${chFast}) | HackTorrent: ${r.multi.length} | CineCalidadLA: ${r.ccla.length} | Alfa: ${r.alfa.length} | Balandro: ${r.balandro.length}`);

  const streams = buildStreams([...chResults, ...r.ccla, ...r.multi, ...r.alfa, ...r.balandro], { title: mediaTitle, season, episode });
  const cacheable = streams.filter(isCacheable);
  if (cacheable.length > 0) await cache.saveStreamsToCache(cacheKey, cacheable).catch(() => {});

  // El barrido completo de 91 canales tarda ~60-90s: al terminar, caché para
  // la siguiente visita (Stremio repite la petición al abrir el título).
  if (!chFast) {
    chDone.then(async (ok) => {
      if (!ok || chResults.length === 0) return;
      const mapped = buildStreams(chResults, { title: mediaTitle, season, episode }).filter(isCacheable);
      if (mapped.length > 0) {
        await cache.saveStreamsToCache(cacheKey, mapped).catch(() => {});
        console.log(`🔄 [Sites] canales background: ${mapped.length} streams en caché`);
      }
    }).catch(() => {});
  }

  console.log(`🧠 [Sites] -> ${streams.length} streams latinos`);
  return { streams };
});

// /resolve — resolución en play-time (patrón NoTorrent)
const app = express();
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

app.get('/resolve', async (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(String(req.query.p || ''), 'base64').toString('utf-8'));
    let target = null;
    let referer = '';

    if (payload.e === 'alfa') target = await resolveAlfa(payload);
    else if (payload.e === 'ccla') target = await resolveCineCalidadLA(payload);
    else if (payload.e === 'acorta') target = await resolveAcorta(payload, decryptAcortalink);
    else if (payload.e === 'ch') {
      const r = await resolveChannel(payload);
      if (r) { target = r.url; referer = r.referer || ''; }
    }

    if (!target) return res.status(404).send('Enlace no resoluble');
    // Los hosts exigen Referer/UA: servimos a través del proxy local
    return res.redirect(302, `/proxy?url=${encodeURIComponent(target)}&ref=${encodeURIComponent(referer)}`);
  } catch (e) {
    return res.status(500).send('Error de resolución');
  }
});

// Proxy de video: HLS (rewrite de playlists) y directo (pipe con cabeceras).
// Los hosts tipo goodstream/vidhide rechazan peticiones sin Referer/UA de
// navegador — Stremio no las envía, este proxy sí.
const axiosNoRedirect = axios.create({ maxRedirects: 0, validateStatus: null });

function proxify(line, baseUrl, referer) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return line;
  let abs;
  try { abs = new URL(t, baseUrl).href; } catch (e) { return line; }
  return `/proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(referer)}`;
}

app.get('/proxy', async (req, res) => {
  const url = String(req.query.url || '');
  const ref = String(req.query.ref || '');
  if (!/^https?:\/\//.test(url)) return res.status(400).send('URL inválida');

  try {
    const isM3u8 = /\.m3u8($|\?)/i.test(url) || (req.query.hls === '1');
    if (isM3u8) {
      const r = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': UA_PROXY, Referer: ref || url }
      });
      let body = String(r.data || '');
      const base = new URL(url, url).href;
      body = body.split('\n').map(line => {
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          req.hlsNext = '1'; return line;
        }
        if (line.startsWith('#')) return line;
        const proxied = proxify(line, base, ref);
        return proxied + (line.trim() && !line.startsWith('#') && req.hlsNext ? '' : '');
      }).join('\n');
      // marcar sub-playlists como HLS
      body = body.replace(/\/proxy\?url=([^&\s"]+)/g, (mm, enc) => `/proxy?url=${enc}&ref=${encodeURIComponent(ref)}&hls=1`);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(body);
    }

    // segmentos y archivos directos: pipe con cabeceras de navegador
    const headers = {
      'User-Agent': UA_PROXY,
      Referer: ref || url,
      ...(req.headers.range ? { Range: req.headers.range } : {})
    };
    const upstream = await axiosNoRedirect.get(url, { headers, responseType: 'stream', timeout: 15000 });
    if ([301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.location) {
      return res.redirect(302, `/proxy?url=${encodeURIComponent(upstream.headers.location)}&ref=${encodeURIComponent(ref)}${/m3u8/i.test(upstream.headers.location) ? '&hls=1' : ''}`);
    }
    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    upstream.data.pipe(res);
  } catch (e) {
    return res.status(502).send('Proxy: upstream error');
  }
});

const SITES_PORT_FINAL = process.env.RENDER ? (env.PORT || 10000) : (env.SITES_PORT || 7003);
app.listen(SITES_PORT_FINAL, () => {
  console.log(`✅ [Hybrid Sites] activo en puerto ${SITES_PORT_FINAL}`);
});

cache.initDb().catch((e) => console.error('⚠️ SQLite:', e.message));
