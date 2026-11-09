// ADDON 1: Hybrid Prowlarr [Torrents] — motor P2P puro, 100% estable.
// Solo Prowlarr (indexers locales) + pipeline LATINO + caché P2P + relevancia.
// Puerto 7001. Sin dependencia de sitios web externos.

const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const env = require('./config/env');
const cache = require('./cache/database');
const { filterStreams } = require('./pipeline/filter');
const { scoreAndSortStreams } = require('./pipeline/scorer');
const { fetchProwlarr } = require('./engines/prowlarr');
const { fetchTorrentsApi } = require('./engines/torrents_api');

// Modo nube: sin PROWLARR_API_KEY se usan APIs públicas (TPB/YTS) — sin servidor
const USE_PUBLIC_APIS = !process.env.PROWLARR_API_KEY;
const axios = require('axios');

const builder = new addonBuilder({
  id: 'org.stremio.hybridprowlarr',
  version: '1.0.0',
  name: 'Hybrid Prowlarr [Torrents]',
  description: 'Torrents P2P vía Prowlarr: Audio Latino estricto, series exactas (relevancia), magnéticos con trackers públicos. 100% estable.',
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
  const filtered = filterStreams(rawResults, { allowOtherLanguages: false, title, season, episode });
  const scored = scoreAndSortStreams(filtered);
  return dedupe(scored).map(item => {
    const seedersInfo = item.seeders > 0 ? `👤 Seeders: ${item.seeders}` : '⚡ Enlace';
    const sizeGB = item.size ? ` | 💾 ${(item.size / (1024 * 1024 * 1024)).toFixed(2)} GB` : '';
    const meta = [item.resolution, item.language].filter(Boolean).join(' · ');
    return {
      name: meta ? `${item.source || 'Prowlarr'} — ${meta}` : (item.source || 'Prowlarr'),
      title: `${item.rawTitle}\n${seedersInfo}${sizeGB}`,
      url: item.url,
      infoHash: item.infoHash || undefined
    };
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

builder.defineStreamHandler(async (args) => {
  console.log(`🧲 [Prowlarr] ${args.type} - ${args.id}`);

  const { contentId, season, episode } = parseContentId(args.id);
  const cacheKey = args.id.replace(/\.(json|txt)$/, '');

  const cached = await cache.getCachedStreams(cacheKey).catch(() => null);
  if (cached && cached.length > 0) {
    console.log(`⚡ [Prowlarr] caché: ${cached.length} streams`);
    return { streams: cached };
  }

  const mediaTitle = await getMediaTitle(contentId, args.type);
  if (!mediaTitle) return { streams: [] };

  // Soft-deadline: Stremio abandona a ~20-30s. Respondemos en ≤12s con lo que
  // haya; si Prowlarr sigue buscando (indexers en vivo), termina en background
  // y guarda en caché para la siguiente visita.
  let prowlarrResults = [];
  const engine = USE_PUBLIC_APIS
    ? () => fetchTorrentsApi(contentId, { season, episode, type: args.type, title: mediaTitle })
    : () => fetchProwlarr(contentId, { season, episode, type: args.type, title: mediaTitle });
  const prowlarrDone = engine()
    .then(v => { prowlarrResults = v; return true; }, () => false);

  const fast = await Promise.race([
    prowlarrDone,
    delay(env.SOFT_TIMEOUT_MS).then(() => false)
  ]);

  const streams = buildStreams(prowlarrResults, { title: mediaTitle, season, episode });

  if (fast && streams.length > 0) {
    await cache.saveStreamsToCache(cacheKey, streams).catch(() => {});
  } else if (!fast) {
    prowlarrDone.then(async (ok) => {
      if (!ok || prowlarrResults.length === 0) return;
      const merged = buildStreams(prowlarrResults, { title: mediaTitle, season, episode });
      if (merged.length > 0) {
        await cache.saveStreamsToCache(cacheKey, merged).catch(() => {});
        console.log(`🔄 [Prowlarr] background completó: ${merged.length} streams en caché`);
      }
    }).catch(() => {});
  }

  console.log(`🧲 [Prowlarr] ${prowlarrResults.length} crudos (fast=${fast}) -> ${streams.length} latinos`);
  return { streams };
});

const app = express();
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

app.listen(env.PORT, () => {
  console.log(`✅ [Hybrid Prowlarr] activo en http://127.0.0.1:${env.PORT}/manifest.json`);
});

cache.initDb().catch((e) => console.error('⚠️ SQLite:', e.message));
