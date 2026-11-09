// Motor CineCalidadLA — traducción de channels/cinecalidadla.py (Balandro).
// Sitio 100% AUDIO LATINO (lang='Lat' fijo en el canal original).
//
// Estructura verificada en vivo (cine-calidad.mx):
//   - Búsqueda:  GET {host}?s={texto}  ->  /pelicula/{slug}/ y /serie/{slug}/
//   - Detalle:   bloque >VER ONLINE< con data-src (base64 -> códigos ASCII
//                separados por espacio, cada char = código - 2) + data-domain
//   - Embeds extraíbles (verificado): goodstream.one -> master.m3u8 directo
//   - Torrent:   /protect/?i=..&v=.. -> form value (a veces 522, tolerado)

const axios = require('axios');
const { fetchWithAntiblock } = require('./antiblock');
const env = require('../config/env');

const HOSTS = ['https://cine-calidad.mx/'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SKIP_DOMAINS = ['youtube', 'tubesb', 'hackplayer', 'vip'];

async function fetchPage(url, referer) {
  // Directo -> FlareSolverr si Cloudflare bloquea (sitios con rate-limit)
  const { html } = await fetchWithAntiblock(url, {
    headers: referer ? { Referer: referer } : {},
    timeout: Math.max(env.GLOBAL_TIMEOUT_MS, 8000)
  });
  return html;
}

// data-src: base64("106 118 ...") -> cada número es charCode + 2
function decodeDataSrc(b64) {
  try {
    const nums = Buffer.from(b64, 'base64').toString('utf-8')
      .split(' ').filter(Boolean).map(Number);
    if (!nums.length) return null;
    const url = nums.map(n => String.fromCharCode(n - 2)).join('');
    return url.startsWith('http') ? url : null;
  } catch (e) {
    return null;
  }
}

// Extrae embeds del bloque VER ONLINE (ambos órdenes de atributos)
function extractEmbeds(html) {
  const embeds = [];
  const seen = new Set();
  const patterns = [
    /data-src="([^"]+)"[^>]*data-domain="([^"]+)"/g,
    /data-domain="([^"]+)"[^>]*data-src="([^"]+)"/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const [a, b] = re === patterns[0] ? [m[1], m[2]] : [m[2], m[1]];
      const url = decodeDataSrc(a);
      const domain = (b || '').toLowerCase();
      if (!url || seen.has(url)) continue;
      if (SKIP_DOMAINS.some(d => domain.includes(d))) continue;
      seen.add(url);
      embeds.push({ url, domain });
    }
  }
  return embeds;
}

// Extracción genérica: m3u8/mp4 directo (verificado en goodstream.one)
async function resolveEmbed(embedUrl) {
  try {
    const html = await fetchPage(embedUrl, 'https://cine-calidad.mx/');
    const text = typeof html === 'string' ? html : String(html);
    const direct = text.match(/"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/i);
    if (direct) return direct[1];
    const source = text.match(/file\s*:\s*"(https?:\/\/[^"]+)"/i);
    if (source) return source[1];
    return null;
  } catch (e) {
    return null;
  }
}

// Torrent vía /protect/ (form value); tolera 522/403
async function resolveTorrent(protectUrl) {
  try {
    const html = await fetchPage(protectUrl, 'https://cine-calidad.mx/');
    const value = (typeof html === 'string' ? html.match(/value="([^"]+)"/) : null);
    if (!value) return null;
    let url = value[1];
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url)) return null;
    return url; // puede ser .torrent, magnet o hoster de descarga
  } catch (e) {
    return null;
  }
}

function searchLinks(html) {
  const links = { movies: [], series: [] };
  const re = /href="https?:\/\/cine-calidad\.mx\/(pelicula|serie)\/([^"\/]+)\/?"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const entry = { url: `https://cine-calidad.mx/${m[1]}/${m[2]}/`, slug: m[2] };
    if (m[1] === 'pelicula') links.movies.push(entry);
    else links.series.push(entry);
  }
  return links;
}

async function fetchCineCalidadLA(titleQuery, { season, episode, resolveBase } = {}) {
  if (!titleQuery) return [];
  const host = HOSTS[0];
  const base = resolveBase || `http://127.0.0.1:${process.env.PORT || 7001}`;

  try {
    console.log(`🎬 CineCalidadLA: buscando "${titleQuery}"...`);
    const html = await fetchPage(`${host}?s=${encodeURIComponent(titleQuery).replace(/%20/g, '+')}`);
    if (!html) return [];

    const links = searchLinks(html);

    if (season != null) {
      // SERIES: estructura de episodios no verificada en vivo -> deferido
      const serie = links.series[0];
      if (!serie) return [];
      return [{
        rawTitle: `${titleQuery} ${season}x${String(episode).padStart(2, '0')} [Latino Web]`,
        url: `${base}/resolve?p=${Buffer.from(JSON.stringify({
          e: 'ccla', kind: 'serie', pageUrl: serie.url, season, episode, title: titleQuery
        })).toString('base64')}`,
        source: 'CineCalidadLA 🇲🇽 [Web]',
        seeders: 0,
        size: 0
      }];
    }

    // PELÍCULAS: detalle -> embeds -> m3u8/mp4 directo (paralelo)
    const movies = links.movies.slice(0, 2);
    const resolved = await Promise.allSettled(movies.map(async (movie) => {
      const detail = await fetchPage(movie.url);
      const embeds = extractEmbeds(typeof detail === 'string' ? detail : String(detail)).slice(0, 3);
      const results = await Promise.allSettled(embeds.map(e => resolveEmbed(e.url)));
      const direct = results.map(r => (r.status === 'fulfilled' ? r.value : null)).find(Boolean);
      if (!direct) return null;
      return {
        rawTitle: `${titleQuery} [Latino Web]`,
        url: direct,
        source: 'CineCalidadLA 🇲🇽 [Web]',
        seeders: 0,
        size: 0
      };
    }));

    const streams = resolved
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    console.log(`✅ CineCalidadLA: ${streams.length} streams latinos directos.`);
    return streams;

  } catch (error) {
    console.error(`❌ CineCalidadLA Error: ${error.message}`);
    return [];
  }
}

// Resolución en play-time (invocada por /resolve en index.js)
async function resolveCineCalidadLA(payload) {
  if (!payload || payload.e !== 'ccla') return null;

  if (payload.kind === 'serie' && payload.pageUrl) {
    try {
      const detail = await fetchPage(payload.pageUrl);
      const html = typeof detail === 'string' ? detail : String(detail);
      const embeds = extractEmbeds(html);
      for (const e of embeds) {
        const direct = await resolveEmbed(e.url);
        if (direct) return direct;
      }
    } catch (e) { /* caído */ }
    return null;
  }

  if (payload.embed) return resolveEmbed(payload.embed);
  return null;
}

module.exports = { fetchCineCalidadLA, resolveCineCalidadLA };
