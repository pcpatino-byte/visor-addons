const axios = require('axios');
const env = require('../config/env');

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

async function getMediaMeta(imdbId, type) {
  try {
    const endpoint = type === 'series' ? 'series' : 'movie';
    const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${endpoint}/${imdbId}.json`, { timeout: 6000 });
    return response.data?.meta?.name || null;
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Indexers rápidos (patrón caps-discovery de Elementum): se consultan
// las estadísticas de Prowlarr y se EXCLUYEN dinámicamente los indexers
// lentos (> MAX_INDEXER_MS de latencia media). Un solo indexer lento
// (p.ej. Internet Archive con ~26s) bloqueaba TODA la búsqueda.
// Cache 30 min; si falla la consulta, no se filtra nada.
// ---------------------------------------------------------------------

const MAX_INDEXER_MS = 5000;
let fastIndexerIds = null;
let fastIndexerAt = 0;

async function getFastIndexerIds() {
  if (fastIndexerIds && Date.now() - fastIndexerAt < 30 * 60 * 1000) return fastIndexerIds;

  try {
    const response = await axios.get(
      `${env.PROWLARR_URL.replace(/\/$/, '')}/api/v1/indexerstats`,
      { headers: { 'X-Api-Key': env.PROWLARR_API_KEY }, timeout: 5000 }
    );
    const all = response.data?.indexers || [];
    fastIndexerIds = all
      .filter(x => x.averageResponseTime > 0 && x.averageResponseTime < MAX_INDEXER_MS)
      .map(x => x.indexerId);
    fastIndexerAt = Date.now();
    console.log(`📊 Prowlarr: ${fastIndexerIds.length}/${all.length} indexers rápidos (<${MAX_INDEXER_MS}ms)`);
    return fastIndexerIds;
  } catch (e) {
    return null; // sin filtrar
  }
}

async function fetchProwlarr(imdbId, extra = null) {
  if (!env.PROWLARR_URL || !env.PROWLARR_API_KEY) return [];

  try {
    const mediaType = extra?.type || 'movie';
    // Si index.js ya resolvió el título (Cinemeta), se reutiliza: una sola llamada
    const mediaName = extra?.title || await getMediaMeta(imdbId, mediaType);
    if (!mediaName) return [];

    // Construcción precisa de la query para series y películas
    let query = mediaType === 'series' && extra?.season && extra?.episode
      ? `${mediaName} S${String(extra.season).padStart(2, '0')}E${String(extra.episode).padStart(2, '0')}`
      : mediaName;

    const url = `${env.PROWLARR_URL.replace(/\/$/, '')}/api/v1/search`;

    // categories acota el fan-out: 2000=películas, 5000=series
    const categories = mediaType === 'series' ? '5000' : '2000';

    const fastIds = await getFastIndexerIds();
    const params = new URLSearchParams();
    params.append('query', query);
    params.append('type', 'search');
    params.append('limit', '40');
    params.append('categories', categories);
    if (fastIds && fastIds.length > 0) {
      // Prowlarr exige indexerIds repetidos: ?indexerIds=1&indexerIds=2...
      fastIds.forEach(id => params.append('indexerIds', String(id)));
    }

    console.log(`🔍 Prowlarr: Buscando "${query}" (cat ${categories}, ${fastIds ? fastIds.length + ' indexers rápidos' : 'todos'})...`);

    const response = await axios.get(`${url}?${params.toString()}`, {
      headers: {
        'X-Api-Key': env.PROWLARR_API_KEY,
        'Accept': 'application/json'
      },
      timeout: 90000 // corre en background: el deadline del usuario lo fija SOFT_TIMEOUT_MS en index.js
    });

    if (!Array.isArray(response.data)) return [];

    return response.data
      .map(item => {
        const infoHash = item.infoHash;
        const magnet = item.magnetUrl;
        const title = (item.title || item.sortTitle || '').toLowerCase();

        if (!infoHash && !magnet) return null;
        if (title.includes('castellano') || title.includes('spain') || title.includes('.es.') || title.includes('españa')) return null;

        let finalUrl = infoHash
          ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title || 'video')}${PUBLIC_TRACKERS}`
          : (magnet.includes('&tr=') ? magnet : `${magnet}${PUBLIC_TRACKERS}`);

        const isLatinoOrDual = title.includes('latino') || title.includes('lat') || title.includes('dual') || title.includes('multi');

        return {
          rawTitle: item.title || '',
          url: finalUrl,
          infoHash: infoHash || null,
          source: isLatinoOrDual ? 'Prowlarr 🇲🇽 [Latino]' : 'Prowlarr 🌐 [Stream]',
          seeders: item.seeders || 0,
          size: item.size || 0,
          isLatinoOrDual
        };
      })
      .filter(item => item && item.seeders >= 1 && item.size >= 200 * 1024 * 1024)
      .sort((a, b) => (b.isLatinoOrDual ? 1 : -1) - (a.isLatinoOrDual ? 1 : -1) || b.seeders - a.seeders);

  } catch (error) {
    console.error(`❌ Prowlarr Error: ${error.message}`);
    return [];
  }
}

module.exports = { fetchProwlarr };
