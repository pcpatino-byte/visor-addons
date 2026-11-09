// Traducción a Node.js de los canales de torrent de Balandro:
//   - dontorrents.py  (https://dontorrent.tips/)  -> búsqueda POST + API PoW
//   - elitetorrent.py (https://www.elitetorrent.com/) -> búsqueda GET + magnets/base64
// Formato de salida unificado: { rawTitle, url (magnet), source, seeders, size, infoHash }

const cloudscraper = require('cloudscraper');
const { flaresolverrPost } = require('./antiblock');

// Trackers públicos: magnets de .torrent no los traen y Stremio sin
// trackers tarda infinito en encontrar peers.
const PUBLIC_TRACKERS_DT = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
].map(tr => `&tr=${encodeURIComponent(tr)}`).join('');
const crypto = require('crypto');
const domains = require('../config/domains');
const env = require('../config/env');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9'
};

const MAX_CANDIDATES = 3;

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

async function fetchPage(url, { method = 'GET', form = null, body = null, headers = {} } = {}) {
  const options = {
    method,
    url,
    timeout: env.GLOBAL_TIMEOUT_MS,
    headers: { ...BROWSER_HEADERS, ...headers }
  };
  if (form) options.form = form;
  if (body) options.body = body;

  const response = await cloudscraper(options);
  return typeof response === 'string' ? response : String(response);
}

function absoluteUrl(link, host) {
  if (!link) return null;
  if (link.startsWith('http')) return link;
  if (link.startsWith('//')) return 'https:' + link;
  return host.replace(/\/$/, '') + (link.startsWith('/') ? link : '/' + link);
}

// Réplica simplificada de decrypters.decode_url_base64 (lib/decrypters.py):
// intenta decodificar base64 iterativamente (hasta 20 veces); si el resultado
// es magnet o .torrent lo devuelve; si no, construye URL absoluta contra el host.
function decodeUrlBase64(link, host) {
  if (!link || link.startsWith('magnet:') || link.endsWith('.torrent') || link.startsWith('http')) {
    return absoluteUrl(link, host);
  }

  const queryMatch = link.match(/php(?:#|\?\w=)(.*?)(?:&|$)/) || link.match(/\?(?:\w+=.*&)?(?:urlb64)?=(.*?)(?:&|$)/);
  const candidate = queryMatch ? queryMatch[1] : link;

  try {
    let decoded = Buffer.from(candidate, 'base64').toString('utf-8');
    if (decoded && decoded !== candidate) {
      decoded = decoded.replace(/ /g, '%20');
      if (decoded.startsWith('magnet:') || decoded.endsWith('.torrent')) return decoded;
    }
  } catch (e) { /* no era base64 */ }

  return absoluteUrl(link, host);
}

// ---------------------------------------------------------------------------
// infoHash: parser bencode mínimo para convertir .torrent en magnet
// ---------------------------------------------------------------------------

function skipBencodeValue(buf, pos) {
  const c = buf[pos];
  if (c === 0x64) { // 'd' dict
    pos++;
    while (buf[pos] !== 0x65) { pos = skipBencodeValue(buf, pos); pos = skipBencodeValue(buf, pos); }
    return pos + 1;
  }
  if (c === 0x6c) { // 'l' list
    pos++;
    while (buf[pos] !== 0x65) { pos = skipBencodeValue(buf, pos); }
    return pos + 1;
  }
  if (c === 0x69) { // 'i' integer
    return buf.indexOf(0x65, pos) + 1;
  }
  const colon = buf.indexOf(0x3a, pos); // string: <len>:<bytes>
  const len = parseInt(buf.slice(pos, colon).toString('ascii'), 10);
  return colon + 1 + len;
}

function computeInfoHash(torrentBuffer) {
  try {
    const marker = Buffer.from('4:info');
    const idx = torrentBuffer.indexOf(marker);
    if (idx === -1) return null;
    const start = idx + marker.length;
    const end = skipBencodeValue(torrentBuffer, start);
    return crypto.createHash('sha1').update(torrentBuffer.slice(start, end)).digest('hex');
  } catch (e) {
    return null;
  }
}

function magnetFromInfoHash(infoHash, rawTitle) {
  const dn = encodeURIComponent(rawTitle || 'video');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${PUBLIC_TRACKERS_DT}`;
}

async function torrentUrlToMagnet(torrentUrl, rawTitle) {
  if (!torrentUrl) return null;
  if (torrentUrl.startsWith('magnet:')) return torrentUrl;
  if (!torrentUrl.toLowerCase().includes('.torrent')) return torrentUrl;

  try {
    const response = await cloudscraper({
      method: 'GET',
      url: torrentUrl,
      timeout: env.GLOBAL_TIMEOUT_MS,
      encoding: null,
      headers: BROWSER_HEADERS
    });
    const infoHash = computeInfoHash(Buffer.isBuffer(response) ? response : Buffer.from(response));
    if (infoHash) return magnetFromInfoHash(infoHash, rawTitle);
    return null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DonTorrent — traducción de channels/dontorrents.py
// host = 'https://dontorrent.tips/'
// ---------------------------------------------------------------------------

function getDonTorrentHosts() {
  return (domains.dontorrentMirrors && domains.dontorrentMirrors.length)
    ? domains.dontorrentMirrors : ['https://dontorrent.tips/'];
}

// list_search(): POST a host+'buscar/' con {valor, Buscar, p} y Referer
// Fallback antibloqueo: si todos los espejos fallan (Cloudflare/red),
// se reintentan vía FlareSolverr (navegador real, resuelve el challenge).
async function donTorrentSearchPage(query) {
  const hosts = getDonTorrentHosts();
  for (const host of hosts) {
    try {
      const data = await fetchPage(`${host}buscar/`, {
        method: 'POST',
        form: { valor: query, Buscar: 'Buscar', p: '1' },
        headers: { Referer: host }
      });
      // Validar contenido real: páginas 522/challenge vacías no cuentan
      if (data && data.includes('Resultados')) {
        return { data, host };
      }
    } catch (e) { /* probar siguiente espejo */ }
  }

  // FlareSolverr: espejos con Cloudflare activo
  for (const host of hosts) {
    try {
      const data = await flaresolverrPost(`${host}buscar/`, { valor: query, Buscar: 'Buscar', p: '1' });
      if (data && !data.includes('<title>Just a moment...</title>') && data.includes('Resultados')) {
        console.log(`🛡️ DonTorrent accesible vía FlareSolverr: ${host}`);
        return { data, host };
      }
    } catch (e) { /* siguiente espejo */ }
  }
  return { data: null, host: null };
}

function parseDonTorrentResults(data) {
  // --- FORMATO NUEVO (2026): <li class="search-result"> con badge de tipo ---
  const resultsNew = [];
  const reNew = /<li class="search-result">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = reNew.exec(data)) !== null) {
    const block = m[1];
    const hrefMatch = block.match(/href="([^"]+)"/);
    if (!hrefMatch) continue;
    const url = hrefMatch[1];
    // título completo: texto de <a> + spans hermanos (formato/calidad)
    const innerText = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // quitar el badge de tipo del final (Serie/Película/…)
    const title = innerText.replace(/\s*(Serie|Pel[ií]cula|Documento|Juego|M[uú]sica)\s*$/i, '').trim();
    if (!title) continue;

    const tipo = (block.match(/badge[^>]*>([^<]+)</) || [])[1] || '';
    let contentType = 'tvshow';
    if (url.includes('/pelicula/') || /pel[ií]cula/i.test(tipo)) contentType = 'movie';
    else if (url.includes('/documental/') || /documento/i.test(tipo)) contentType = 'documentary';
    if (!['tvshow', 'movie'].includes(contentType)) continue;

    resultsNew.push({ url, title, contentType });
  }
  if (resultsNew.length > 0) return resultsNew;

  // --- FORMATO ANTIGUO (fallback) ---
  const bloqueMatch = data.match(/>Resultados<([\s\S]*?)<\/nav>/);
  if (!bloqueMatch) return [];

  const results = [];
  const patron = /<a href='(.*?)'.*?class="text-decoration-none">(.*?)<\/a>/g;
  while ((m = patron.exec(bloqueMatch[1])) !== null) {
    let url = m[1];
    let title = m[2]
      .replace(/<span class="text-secondary">/g, '')
      .replace(/<span class="text-secondary" >/g, '')
      .replace(/<\/span>/g, '')
      .trim();

    if (!url || !title) continue;

    let contentType = 'tvshow';
    if (url.includes('/pelicula/')) contentType = 'movie';
    else if (url.includes('/documental/')) contentType = 'documentary';

    results.push({ url, title, contentType });
  }
  return results;
}

// corregir_SerieName(): limpia el nombre de la serie del título de temporada
function corregirSerieName(name) {
  let s = name || '';
  if (s.includes('[')) s = s.split('[')[0];
  else if (s.includes('720p')) s = s.split('720p')[0];

  for (let n = 1; n <= 9; n++) {
    if (s.includes(`${n}ª`)) s = s.split(`${n}ª`)[0];
  }
  if (s.includes(' Temporada')) s = s.split(' Temporada')[0];
  else if (s.includes(' - ')) s = s.split(' - ')[0];

  return s.trim();
}

// episodios(): parsea la tabla de episodios de una página de temporada.
// Formato 2026: filas con comillas dobles, botón .protected-download con
// data-content-id + data-tabla, y títulos de rango ("1x01 al 1x22" = pack).
function parseDonTorrentEpisodes(data) {
  const episodes = [];

  // Fila de temporada con rango (pack): "1x01 al 1x22" + protected-download
  const packRe = /<td[^>]*>\s*(\d+)x(\d+)\s*al\s*(\d+)x(\d+)[\s\S]{0,400}?data-content-id="?([^"\s>]+)"?[\s\S]{0,150}?data-tabla="([^"]+)"/gi;
  let m;
  while ((m = packRe.exec(data)) !== null) {
    episodes.push({
      title: `${m[1]}x${m[2]} al ${m[3]}x${m[4]}`,
      id: m[5],
      tabla: m[6],
      season: parseInt(m[1], 10),
      episode: parseInt(m[2], 10),
      seasonEnd: parseInt(m[3], 10),
      episodeEnd: parseInt(m[4], 10),
      isPack: true
    });
  }

  // Episodios individuales: <td>NxNN</td> <a ... data-content-id="..." data-tabla="...">
  const epRe = /<td[^>]*>\s*(\d+)x(\d+)[\s\S]{0,400}?data-content-id="?([^"\s>]+)"?(?:[\s\S]{0,150}?data-tabla="([^"]+)")?/gi;
  while ((m = epRe.exec(data)) !== null) {
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    // evitar duplicar el pack (ya capturado arriba)
    if (episodes.some(e => e.season === season && e.episode === episode && e.isPack)) continue;
    episodes.push({
      title: `${m[1]}x${m[2]}`,
      id: m[3],
      tabla: m[4] || 'series',
      season,
      episode,
      isPack: false
    });
  }

  if (episodes.length > 0) return episodes;

  // --- FORMATO ANTIGUO (fallback: comillas simples, sin data-tabla) ---
  const p1 = /<td style='vertical-align: middle;'>([^<]+)<\/td>\s*<td><a class="text-white bg-primary rounded-pill d-block shadow-sm text-decoration-none my-1 py-1"\s+style="font-size: 18px; font-weight: 500;" href='([^']+)'/g;
  while ((m = p1.exec(data)) !== null) {
    episodes.push({ title: m[1].trim(), id: m[2] });
  }

  if (episodes.length === 0) {
    const p2 = /<tr>[\s\S]*?<td style='vertical-align[\s\S]*?>([\s\S]*?)<\/td>[\s\S]*?data-content-id="(.*?)"[\s\S]*?<\/tr>/g;
    while ((m = p2.exec(data)) !== null) {
      episodes.push({ title: m[1].trim(), id: m[2] });
    }
  }

  if (episodes.length === 0) {
    const p3 = /<td style='vertical-align[\s\S]*?>([\s\S]*?)<\/td>[\s\S]*?<a[\s\S]*?href='(.*?)'[\s\S]*?download>Descargar<\/a>[\s\S]*?<\/tr>/g;
    while ((m = p3.exec(data)) !== null) {
      episodes.push({ title: m[1].trim(), id: m[2] });
    }
  }

  // s_e = get_season_and_episode(title) -> "1x01"
  for (const ep of episodes) {
    if (ep.season == null) {
      const se = ep.title.match(/(\d+)\s*[xX]\s*(\d+)/);
      if (se) {
        ep.season = parseInt(se[1], 10);
        ep.episode = parseInt(se[2], 10);
      } else {
        ep.season = 0;
        ep.episode = 0;
      }
    }
  }

  return episodes;
}

// nonce_gen(): SHA-256(challenge + nonce) empezando por '000'
async function nonceGen(challenge, difficulty = 3) {
  const target = '0'.repeat(difficulty);
  let nonce = 0;
  while (true) {
    const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
    if (hash.startsWith(target)) return String(nonce);
    nonce++;
    if (nonce % 5000 === 0) await new Promise(r => setImmediate(r));
    if (nonce > 5000000) return null;
  }
}

// findvideos(): API PoW api_validate_pow.php -> download_url
async function donTorrentResolveTorrent(host, pageUrl, tabla, contentId) {
  try {
    let id = contentId;
    let tablaFromPage = null;
    if (!id) {
      const data = await fetchPage(pageUrl, { headers: { Referer: host } });
      const idMatch = data.match(/data-content-id="?([^"\s>]+)"?[\s\S]{0,150}?data-tabla="([^"]+)"/i)
        || data.match(/data-content-id="(.*?)"/);
      if (!idMatch) return null;
      id = idMatch[1];
      tablaFromPage = idMatch[2] || null;
    }
    const useTabla = tablaFromPage || tabla;

    // Flujo exacto de /assets/js/don_download.js v1.40:
    //   generate: content_id parseInt + tabla | validate: nonce numérico, sin 'unescape'
    const api = `${host}api_validate_pow.php`;
    const post1 = JSON.stringify({ action: 'generate', content_id: parseInt(id, 10), tabla: useTabla });
    const data1 = await fetchPage(api, {
      method: 'POST',
      body: post1,
      headers: { Referer: pageUrl, 'Content-Type': 'application/json' }
    });

    const challengeMatch = String(data1).match(/"challenge":\s*"([^"]+)"/);
    if (!challengeMatch) return null;

    const nonce = await nonceGen(challengeMatch[1]);
    if (!nonce) return null;

    const post2 = JSON.stringify({ action: 'validate', challenge: challengeMatch[1], nonce: Number(nonce) });
    const data2 = await fetchPage(api, {
      method: 'POST',
      body: post2,
      headers: { Referer: pageUrl, 'Content-Type': 'application/json' }
    });

    if (!String(data2).includes('"success"')) return null;

    const urlMatch = String(data2).match(/"download_url":\s*"(.*?)"/);
    if (!urlMatch) return null;

    return urlMatch[1].replace(/\\\//g, '/');
  } catch (e) {
    return null;
  }
}

// Los sitios españoles indexan títulos traducidos ("Dune: Parte Dos").
// Si la búsqueda con el título completo no arroja nada, se reintenta con
// el fragmento principal (antes de ':' o '-').
function simplifiedTitle(t) {
  return (t || '').split(/[:\-–—]/)[0].trim();
}

async function searchDonTorrent(titleQuery, { season, episode } = {}) {
  let { data, host } = await donTorrentSearchPage(titleQuery);
  let results = data ? parseDonTorrentResults(data) : [];

  if (results.length === 0 && simplifiedTitle(titleQuery) !== titleQuery) {
    const alt = simplifiedTitle(titleQuery);
    ({ data, host } = await donTorrentSearchPage(alt));
    results = data ? parseDonTorrentResults(data) : [];
  }

  if (!data || !host || results.length === 0) return [];

  const streams = [];

  try {
    if (season != null) {
      // --- SERIES: páginas de temporada en PARALELO + match del episodio ---
      const seasonPages = results.filter(r => r.contentType === 'tvshow').slice(0, 2);
      const pages = await Promise.allSettled(seasonPages.map(async (page) => {
        const pageUrl = absoluteUrl(page.url, host);
        const pageData = await fetchPage(pageUrl, { headers: { Referer: host } });
        const episodes = parseDonTorrentEpisodes(pageData);
        const target = episodes.find(ep => {
          if (ep.season !== Number(season)) return false;
          if (episode == null) return true;
          // pack "1x01 al 1x22" cubre todo el rango de la temporada
          if (ep.isPack) return Number(episode) >= ep.episode && Number(episode) <= (ep.episodeEnd || ep.episode);
          return ep.episode === Number(episode);
        });
        return target ? { page, pageUrl, target } : null;
      }));

      const matched = pages
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

      // PoW en paralelo para todos los episodios encontrados
      const resolved = await Promise.allSettled(matched.map(async ({ page, pageUrl, target }) => {
        const torrentUrl = await donTorrentResolveTorrent(host, pageUrl, 'series', target.id);
        if (!torrentUrl) return null;
        const sTag = `S${String(season).padStart(2, '0')}E${String(episode || 0).padStart(2, '0')}`;
        const magnet = await torrentUrlToMagnet(absoluteUrl(torrentUrl, host), `${corregirSerieName(page.title)} ${sTag}`);
        if (!magnet) return null;
        return {
          rawTitle: `${corregirSerieName(page.title)} ${season}x${String(episode).padStart(2, '0')}`,
          url: magnet,
          source: 'Balandro [DonTorrent]',
          seeders: 0,
          size: 0
        };
      }));

      resolved.forEach(r => { if (r.status === 'fulfilled' && r.value) streams.push(r.value); });
    } else {
      // --- PELÍCULAS: PoW + .torrent en PARALELO para los mejores candidatos ---
      const movies = results.filter(r => r.contentType === 'movie').slice(0, MAX_CANDIDATES);
      const resolved = await Promise.allSettled(movies.map(async (movie) => {
        try {
          const pageUrl = absoluteUrl(movie.url, host);
          // La ficha revela el título/año real (el listado puede ser ambiguo)
          let realTitle = movie.title;
          try {
            const detail = await fetchPage(pageUrl, { headers: { Referer: host } });
            const h1 = (detail.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
            const year = (detail.match(/\b(19|20)\d{2}\b/) || [])[0];
            if (h1) {
              realTitle = h1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              if (year && !realTitle.includes(year)) realTitle += ' ' + year;
            }
          } catch (e) { `` }

          const torrentUrl = await donTorrentResolveTorrent(host, pageUrl, 'peliculas', null);
          if (!torrentUrl) return null;
          const magnet = await torrentUrlToMagnet(absoluteUrl(torrentUrl, host), realTitle);
          if (!magnet) return null;
          return {
            rawTitle: realTitle,
            url: magnet,
            source: 'Balandro [DonTorrent]',
            seeders: 0,
            size: 0
          };
        } catch (e) { return null; }
      }));

      resolved.forEach(r => { if (r.status === 'fulfilled' && r.value) streams.push(r.value); });
    }
  } catch (e) { /* errores silenciosos */ }

  return streams;
}

// ---------------------------------------------------------------------------
// EliteTorrent — traducción de channels/elitetorrent.py
// host = 'https://www.elitetorrent.com/'
// ---------------------------------------------------------------------------

function getEliteTorrentHosts() {
  return (domains.elitetorrentMirrors && domains.elitetorrentMirrors.length)
    ? domains.elitetorrentMirrors : ['https://www.elitetorrent.com/'];
}

// search(): GET host+'?s=' + texto + '&x=0&y=0'
async function searchEliteTorrent(titleQuery, { season, episode } = {}) {
  const hosts = getEliteTorrentHosts();
  const streams = [];

  for (const host of hosts) {
    try {
      const data = await fetchPage(`${host}?s=${encodeURIComponent(titleQuery).replace(/%20/g, '+')}&x=0&y=0`, {
        headers: { Referer: host }
      });

      if (data.includes('<h1>No se han encontrado resultados para')) return streams;

      // list_all(): bloques <div class="imagen">(.*?)<div class="meta">
      let blocks = [...data.matchAll(/<div class="imagen">([\s\S]*?)<div class="meta">/g)].map(m => m[1]);
      if (blocks.length === 0) {
        blocks = [...data.matchAll(/<div class=imagen>([\s\S]*?)<div class=meta>/g)].map(m => m[1]);
      }

      for (const match of blocks) {
        const urlMatch = match.match(/<a href="(.*?)"/);
        let titleMatch = match.match(/title="(.*?)"/);
        if (!titleMatch || titleMatch[1] === 'Peso de pelicula') {
          titleMatch = match.match(/title=(.*?)alt=/);
          if (titleMatch) titleMatch[1] = titleMatch[1].replace(/["']/g, '');
        }
        if (!urlMatch || !titleMatch) continue;

        let url = urlMatch[1];
        let title = titleMatch[1]
          .replace(/\(720\)|\(720p\)|\(1080\)|\(1080p\)|\(microHD\)|\(BR-Line\)/g, '')
          .replace(/\(HDR\)|\(HDRip\)|\(DVDRip\)|\(BR-SCREENER\)|\(TS-SCREENER\)/g, '')
          .replace(/&#8217;/g, "'")
          .replace(/&#8211;|&|&#8215;/g, ' ')
          .replace(/&#215;/g, 'x')
          .trim();

        // idiomas por iconos: espanol=Esp, latino=Lat, vose=Vose, ingles=Voi
        const langImages = [...match.matchAll(/data-src='.*?\/images\/(.*?)\.png'/g)].map(m => m[1]);
        const langs = [...new Set(langImages.map(l =>
          l === 'espanol' ? 'Castellano' : l === 'latino' ? 'Latino' : l === 'vose' ? 'Vose' : l === 'ingles' ? 'Ingles' : null
        ).filter(Boolean))];

        // tipo: 'movie' si '/peliculas/' en url, si no tvshow
        const isMovie = url.includes('/peliculas/');
        const thumb = (match.match(/data-src="(.*?)"/) || [])[1] || '';
        const quality = (match.match(/<i>(.*?)<\/i>/) || [])[1];
        if (quality && quality !== '---') title += ` ${quality}`;

        if (isMovie) {
          if (season != null) continue; // buscando episodio, ignorar películas

          // marcar idioma en el título para que el pipeline lo filtre
          const langTag = langs.length ? ` [${langs.join('/')}]` : '';
          const link = decodeUrlBase64(url, host);
          const magnet = await torrentUrlToMagnet(link, title);
          if (magnet) {
            streams.push({
              rawTitle: `${title}${langTag}`,
              url: magnet,
              source: 'Balandro [EliteTorrent]',
              seeders: 0,
              size: 0
            });
          }
        } else {
          if (season == null) continue; // buscando película, ignorar series

          // episodios(): season/episode vienen en la URL: -temporada-N-capitulo-M-
          const tMatch = url.match(/-temporada-(.*?)-/);
          const eMatch = url.match(/-capitulo-(.*?)-/);
          const itemSeason = tMatch ? parseInt(tMatch[1], 10) : 0;
          const itemEpisode = eMatch ? parseInt(eMatch[1], 10) : 0;

          if (itemSeason !== Number(season)) continue;
          if (episode != null && itemEpisode !== Number(episode)) continue;

          const langTag = langs.length ? ` [${langs.join('/')}]` : '';
          const serieName = corregirSerieName(title);
          const link = decodeUrlBase64(url, host);
          const magnet = await torrentUrlToMagnet(link, `${serieName} S${String(itemSeason).padStart(2, '0')}E${String(itemEpisode).padStart(2, '0')}`);
          if (magnet) {
            streams.push({
              rawTitle: `${serieName} ${itemSeason}x${String(itemEpisode).padStart(2, '0')} ${quality || ''}${langTag}`.replace(/\s+/g, ' ').trim(),
              url: magnet,
              source: 'Balandro [EliteTorrent]',
              seeders: 0,
              size: 0
            });
          }
        }

        if (streams.length >= MAX_CANDIDATES) break;
      }
    } catch (e) { /* probar siguiente espejo */ }

    if (streams.length >= MAX_CANDIDATES) break;
  }

  return streams;
}

// ---------------------------------------------------------------------------
// API pública del motor
// fetchBalandro(titleQuery, { season, episode }) -> [{ rawTitle, url, source, seeders, size }]
// ---------------------------------------------------------------------------

async function fetchBalandro(titleQuery, { season, episode } = {}) {
  if (!titleQuery) return [];

  const [don, elite] = await Promise.allSettled([
    searchDonTorrent(titleQuery, { season, episode }),
    searchEliteTorrent(titleQuery, { season, episode })
  ]);

  const streams = [
    ...(don.status === 'fulfilled' ? don.value : []),
    ...(elite.status === 'fulfilled' ? elite.value : [])
  ];

  return streams;
}

module.exports = {
  fetchBalandro,
  searchDonTorrent,
  searchEliteTorrent,
  computeInfoHash,
  corregirSerieName
};
