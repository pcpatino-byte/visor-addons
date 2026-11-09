// Motor Alfa [Hosters] — patrón NoTorrent (resolución en play-time):
//   - La BÚSQUEDA solo verifica barato que el contenido existe (1-2 fetches)
//     y devuelve urls deferidas: /resolve?p=<base64>
//   - Al dar PLAY, el endpoint /resolve del addon extrae el archivo directo
//     (mp4/m3u8) y responde 302; Stremio sigue la redirección.
// Verificado en vivo (pelisplushd.bz):
//   - Películas: /pelicula/{slug} con iframes + var video[N]='...'
//   - Series:    endpoint JSON /serie/{slug}/episodio/{S}/{E} -> data.servers[].url

const axios = require('axios');
const cheerio = require('cheerio');
const env = require('../config/env');

const BASE = 'https://pelisplushd.bz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: Math.max(env.GLOBAL_TIMEOUT_MS, 6000),
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'es-ES,es;q=0.9'
    },
    maxRedirects: 5
  });
  return response.data;
}

// Intenta extraer archivo directo de un embed; null si no se puede (player cifrado)
async function resolveHoster(embedUrl) {
  try {
    const html = await fetchPage(embedUrl);
    const text = typeof html === 'string' ? html : String(html);

    const directMatch = text.match(/"(https?:\/\/[^"]+\.(?:mp4|m3u8|mkv|avi|webm)[^"]*)"/i);
    if (directMatch) return directMatch[1];

    const sourceMatch = text.match(/file\s*:\s*"(https?:\/\/[^"]+)"/i);
    if (sourceMatch) return sourceMatch[1];

    return null;
  } catch (e) {
    return null;
  }
}

// Extrae iframes + var video[N]='...' de una página de detalle
function extractEmbeds(html) {
  const embeds = new Set();
  const $ = cheerio.load(html);
  $('iframe').each((_, el) => {
    const src = $(el).attr('src');
    if (src && /^https?:\/\//.test(src) && !src.includes('youtube') && !src.includes('facebook')) {
      embeds.add(src);
    }
  });
  [...html.matchAll(/video\[\d+\]\s*=\s*'(https?:\/\/[^']+)'/g)].forEach(m => embeds.add(m[1]));
  return [...embeds];
}

// Stream deferido: url apunta al endpoint /resolve del addon (patrón NoTorrent)
function deferredStream(payload, rawTitle, resolveBase) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64');
  return {
    rawTitle,
    url: `${resolveBase}/resolve?p=${p}`,
    source: 'Alfa ⚡ [Hosters]',
    seeders: 0,
    size: 0
  };
}

// Resolución en play-time: invocada por /resolve en index.js
async function resolveAlfa(payload) {
  if (!payload || payload.e !== 'alfa' || typeof payload.embed !== 'string') return null;
  if (!/^https:\/\//.test(payload.embed)) return null;
  return resolveHoster(payload.embed);
}

async function fetchAlfa(imdbId, titleQuery, { season, episode, resolveBase } = {}) {
  if (!titleQuery) return [];
  const base = resolveBase || `http://127.0.0.1:${process.env.PORT || 7001}`;

  try {
    console.log(`🕷️ Alfa [Hosters]: verificación rápida para "${titleQuery}"...`);
    const html = await fetchPage(`${BASE}/search?s=${encodeURIComponent(titleQuery)}`);
    if (!html) return [];

    const $ = cheerio.load(html);
    const movieLinks = [];
    const serieLinks = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = href.startsWith('http') ? href : `${BASE}${href}`;
      if (/\/pelicula\/[^/]+$/.test(abs)) movieLinks.push(abs);
      if (/\/serie\/[^/]+$/.test(abs)) serieLinks.push(abs);
    });

    const streams = [];

    if (season != null) {
      // SERIES: el JSON de episodio es barato (1 fetch) y entrega servers[]
      const serieUrl = [...new Set(serieLinks)][0];
      if (!serieUrl) return [];
      const slug = serieUrl.replace(/\/$/, '').split('/').pop();
      try {
        const data = await fetchPage(`${BASE}/serie/${slug}/episodio/${season}/${episode || 1}`);
        const servers = (data?.data?.servers || []).filter(s => s.url).slice(0, 2);
        const sTag = `${season}x${String(episode).padStart(2, '0')}`;
        // Pre-validación: solo se entrega si se extrae archivo DIRECTO
        const resolved = await Promise.allSettled(servers.map(s => resolveHoster(s.url)));
        resolved.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            streams.push({
              rawTitle: `${titleQuery} ${sTag} [Hoster Latino]`,
              url: r.value,
              source: 'Alfa ⚡ [Hosters]',
              seeders: 0,
              size: 0
            });
          }
        });
      } catch (e) { /* episodio inexistente */ }
    } else {
      // PELÍCULAS: 1 fetch del detalle + pre-validación de embeds
      const link = [...new Set(movieLinks)][0];
      if (!link) return [];
      try {
        const detail = await fetchPage(link);
        const embeds = extractEmbeds(detail).slice(0, 3);
        const resolved = await Promise.allSettled(embeds.map(e => resolveHoster(e)));
        resolved.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            streams.push({
              rawTitle: `${titleQuery} [Hoster Latino]`,
              url: r.value,
              source: 'Alfa ⚡ [Hosters]',
              seeders: 0,
              size: 0
            });
          }
        });
      } catch (e) { /* página caída */ }
    }

    console.log(`✅ Alfa: ${streams.length} streams directos pre-validados (embeds no resolubles descartados).`);
    return streams;

  } catch (error) {
    console.error(`❌ Alfa Error: ${error.message}`);
    return [];
  }
}

module.exports = { fetchAlfa, resolveAlfa };
