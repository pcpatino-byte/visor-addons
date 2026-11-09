const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const env = require('./config/env');
const cache = require('./cache/database');
const { filterStreams } = require('./pipeline/filter');
const { scoreAndSortStreams } = require('./pipeline/scorer');
const { fetchProwlarr } = require('./engines/prowlarr');
const { fetchAlfa, resolveAlfa } = require('./engines/alfa_hosters');
const { fetchCineCalidadLA, resolveCineCalidadLA } = require('./engines/cinecalidadla');
const { fetchBalandroMulti, resolveAcorta } = require('./engines/balandro_multi');
const { decryptAcortalink } = require('./engines/linkcrypt');
const { fetchBalandro } = require('./engines/balandro_scraper');
const axios = require('axios');

const builder = new addonBuilder({
  id: 'org.stremio.hybridultimate',
  version: '3.5.0',
  name: 'Hybrid Ultimate (Prowlarr + Balandro Multi)',
  description: 'Epicentro multifuente: Prowlarr + HackTorrent + CineCalidadLA + Alfa + DonTorrent/EliteTorrent. Audio Latino estricto, series exactas, caché P2P con refresco en vivo',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt', 'tmdb:']
});

async function getMediaTitle(contentId, type) {
  try {
    const endpoint = type === 'series' ? 'series' : 'movie';
    // Cinemeta acepta tanto 'ttXXXX' como 'tmdb:XXXX'
    const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${endpoint}/${contentId}.json`, { timeout: 4000 });
    return response.data?.meta?.name || null;
  } catch (error) {
    return null;
  }
}

// 'tt11198330:1:1'  -> { tt11198330, 1, 1 }
// 'tmdb:94943:1:1'  -> { tmdb:94943, 1, 1 }
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

// Deduplica por infoHash (o URL si no hay hash)
function dedupe(streams) {
  const seen = new Set();
  return streams.filter(s => {
    const key = (s.infoHash || s.url || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runWithTimeout(promiseFn, timeoutMs) {
  return Promise.race([
    promiseFn(),
    new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))
  ]);
}

// Pipeline híbrido: relevancia RELAJADA para motores de sitios (buscan por
// título y los sitios re-titulan en español) y ESTRICTA para Prowlarr
// (búsqueda por keywords — evita shows equivocados).
function buildStreams(rawResults, { title = null, season = null, episode = null } = {}) {
  const siteStreams = rawResults.filter(r => !/prowlarr/i.test(r.source || ''));
  const prowlarrStreams = rawResults.filter(r => /prowlarr/i.test(r.source || ''));

  const filtered = [
    ...filterStreams(siteStreams, { allowOtherLanguages: false, title, season, episode, relaxedRelevance: true }),
    ...filterStreams(prowlarrStreams, { allowOtherLanguages: false, title, season, episode, relaxedRelevance: false })
  ];
  const scored = scoreAndSortStreams(filtered);
  const unique = dedupe(scored);

  return unique.map(item => {
    const seedersInfo = item.seeders > 0 ? `👤 Seeders: ${item.seeders}` : '⚡ Enlace Web';
    const sizeGB = item.size ? ` | 💾 ${(item.size / (1024 * 1024 * 1024)).toFixed(2)} GB` : '';
    const meta = [item.resolution, item.language].filter(Boolean).join(' · ');

    return {
      name: meta ? `${item.source || 'Hybrid ⚡'} — ${meta}` : (item.source || 'Hybrid ⚡'),
      title: `${item.rawTitle}\n${seedersInfo}${sizeGB}`,
      url: item.url,
      infoHash: item.infoHash || undefined
    };
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// P2P: magnet/infoHash no expiran -> cacheables 24h.
// Web (m3u8/mp4 con tokens) y /resolve: expiran -> NUNCA se cachean.
function isCacheable(stream) {
  if (!stream) return false;
  const u = stream.url || '';
  // deferidos /resolve: URL estable (la resolución ocurre al dar play)
  if (u.includes('/resolve?p=')) return true;
  // magnets/infoHash: no expiran
  return u.startsWith('magnet:') || !!stream.infoHash;
}

function refreshInBackground(args) {
  return (async () => {
    const { contentId, season, episode } = parseContentId(args.id);
    const mediaTitle = await getMediaTitle(contentId, args.type);
    const queryTitle = mediaTitle || contentId;

    const prowlarrResults = await fetchProwlarr(contentId, { season, episode, type: args.type, title: mediaTitle }).catch(() => []);
    const [alfaRes, cclaRes, multiRes, balandroRes] = await Promise.allSettled([
      fetchAlfa(contentId, queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL || `http://127.0.0.1:${env.PORT || 7000}` }),
      fetchCineCalidadLA(queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL }),
      fetchBalandroMulti(queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL }),
      fetchBalandro(queryTitle, { season, episode })
    ]);

    const all = [
      ...(cclaRes.status === 'fulfilled' ? cclaRes.value : []),
      ...(alfaRes.status === 'fulfilled' ? alfaRes.value : []),
      ...(multiRes.status === 'fulfilled' ? multiRes.value : []),
      ...(balandroRes.status === 'fulfilled' ? balandroRes.value : []),
      ...prowlarrResults
    ];

    const streams = buildStreams(all, { title: mediaTitle, season, episode });
    const cacheable = streams.filter(isCacheable);
    if (cacheable.length > 0) {
      const cacheKey = args.id.replace(/\.(json|txt)$/, '');
      await cache.saveStreamsToCache(cacheKey, cacheable).catch(() => {});
      console.log(`🔄 Refresco background: ${cacheable.length} streams P2P actualizados en caché`);
    }
    return streams;
  })();
}

builder.defineStreamHandler(async (args) => {
  console.log(`🎬 Solicitud híbrida definitiva para: ${args.type} - ID: ${args.id}`);

  const { contentId, season, episode } = parseContentId(args.id);

  // Caché solo P2P (los enlaces web tienen tokens que expiran).
  // Stale-while-revalidate: se sirve al instante Y se refresca en background
  // para que la siguiente visita tenga resultados recientes.
  const cacheKey = args.id.replace(/\.(json|txt)$/, '');
  const cached = await cache.getCachedStreams(cacheKey).catch(() => null);
  if (cached && cached.length > 0) {
    console.log(`⚡ Servido desde caché: ${cached.length} streams (refrescando en background)`);
    refreshInBackground(args).catch(() => {});
    return { streams: cached };
  }

  const mediaTitle = await getMediaTitle(contentId, args.type);
  const queryTitle = mediaTitle || contentId;

  console.log(`🔍 Consultando Prowlarr, CineCalidadLA, Alfa, BalandroMulti y Balandro para: "${queryTitle}" (S${season}E${episode})...`);

  const prowlarrP = fetchProwlarr(contentId, { season, episode, type: args.type, title: mediaTitle });
  const alfaP = runWithTimeout(
    () => fetchAlfa(contentId, queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL }),
    env.GLOBAL_TIMEOUT_MS
  );
  const cclaP = runWithTimeout(
    () => fetchCineCalidadLA(queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL }),
    env.GLOBAL_TIMEOUT_MS + 4000
  );
  const multiP = runWithTimeout(
    () => fetchBalandroMulti(queryTitle, { season, episode, resolveBase: env.RESOLVE_BASE_URL }),
    env.GLOBAL_TIMEOUT_MS + 4000
  );
  const balandroP = runWithTimeout(
    () => fetchBalandro(queryTitle, { season, episode }),
    env.GLOBAL_TIMEOUT_MS
  );

  let prowlarrResults = [];
  const prowlarrDone = prowlarrP.then(v => { prowlarrResults = v; return true; }, () => false);

  const prowlarrFast = await Promise.race([
    prowlarrDone,
    delay(env.SOFT_TIMEOUT_MS).then(() => false)
  ]);

  const [alfaRes, cclaRes, multiRes, balandroRes] = await Promise.allSettled([alfaP, cclaP, multiP, balandroP]);
  const alfaResults = alfaRes.status === 'fulfilled' ? alfaRes.value : [];
  const cclaResults = cclaRes.status === 'fulfilled' ? cclaRes.value : [];
  const multiResults = multiRes.status === 'fulfilled' ? multiRes.value : [];
  const balandroResults = balandroRes.status === 'fulfilled' ? balandroRes.value : [];

  const allResults = [...cclaResults, ...multiResults, ...alfaResults, ...balandroResults, ...prowlarrResults];

  console.log(`📊 Totales -> Prowlarr: ${prowlarrResults.length} (fast=${prowlarrFast}) | HackTorrent: ${multiResults.length} | CineCalidadLA: ${cclaResults.length} | Alfa: ${alfaResults.length} | Balandro: ${balandroResults.length}`);

  const streams = buildStreams(allResults, { title: mediaTitle, season, episode });

  // Solo se cachean streams P2P (los web expiran)
  const cacheableStreams = streams.filter(isCacheable);
  if (cacheableStreams.length > 0 && prowlarrFast) {
    await cache.saveStreamsToCache(cacheKey, cacheableStreams).catch(() => {});
  } else if (!prowlarrFast) {
    prowlarrDone.then(async (ok) => {
      if (!ok || prowlarrResults.length === 0) return;
      const merged = buildStreams(
        [...cclaResults, ...multiResults, ...alfaResults, ...balandroResults, ...prowlarrResults],
        { title: mediaTitle, season, episode }
      ).filter(isCacheable);
      if (merged.length > 0) {
        await cache.saveStreamsToCache(cacheKey, merged).catch(() => {});
        console.log(`🔄 Prowlarr completó en background: ${merged.length} streams P2P en caché`);
      }
    }).catch(() => {});
  }

  console.log(`🧠 Pipeline -> ${streams.length} streams entregados`);
  return { streams };
});

// ---------------------------------------------------------------------------
// Endpoint /resolve — patrón NoTorrent: resolución en play-time.
// La búsqueda devuelve urls deferidas; al reproducir, este endpoint extrae
// el archivo directo y responde 302 (Stremio/ffmpeg sigue la redirección).
// ---------------------------------------------------------------------------
const app = express();

// Rutas del protocolo Stremio (manifest, stream, etc.)
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

app.get('/resolve', async (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(String(req.query.p || ''), 'base64').toString('utf-8'));
    let target = null;

    if (payload.e === 'alfa') {
      target = await resolveAlfa(payload);
    } else if (payload.e === 'ccla') {
      target = await resolveCineCalidadLA(payload);
    } else if (payload.e === 'acorta') {
      target = await resolveAcorta(payload, decryptAcortalink);
    }

    if (!target) {
      return res.status(404).send('Enlace no resoluble (hoster cifrado o caído)');
    }
    return res.redirect(302, target);
  } catch (e) {
    return res.status(500).send('Error de resolución');
  }
});

app.get('/', (_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<h2>Hybrid Ultimate</h2><p>Instala en Stremio con <code>/manifest.json</code></p>');
});

app.listen(env.PORT, () => {
  console.log(`✅ Addon Híbrido Definitivo activo en: http://127.0.0.1:${env.PORT}/manifest.json`);
});

cache.initDb().catch((e) => console.error('⚠️ SQLite no disponible (caché desactivada):', e.message));
