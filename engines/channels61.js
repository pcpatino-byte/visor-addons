// Motor CANALES Balandro (93 buscables) — búsqueda genérica multicanal.
// ~80% son clones WordPress con búsqueda ?s= y markup de listado similar:
// el censo en vivo (The Diplomat) identificó 46 con resultados.
//
// Arquitectura:
//   - Búsqueda en paralelo por lotes (7s por canal), parseo genérico de
//     enlaces internos de detalle (/pelicula|/serie|/movie|/series|/ver...)
//   - Los resultados se entregan DEFERIDOS (/resolve) — la extracción del
//     video ocurre al dar PLAY (patrón NoTorrent)
//   - Reproducción vía /proxy (rewrite HLS + Referer) para que Stremio
//     pueda reproducir hosts que exigen cabeceras

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Registro: canales censados vivos con resultados (host + tipo de búsqueda).
// 'wp' = búsqueda ?s= genérica; 'wpapi' = JSON; 'path' = /search/<q>
// Registro completo de los 93 canales buscables de Balandro (censo en vivo).
// alive = respondió HTTP 200 en el último censo; los caídos se reintentan
// (podrán resucitar vía FlareSolverr en play-time).
const CHANNELS = [
  { name: "Allpeliculasse", host: "https://allpeliculas.la/", type: "wp", alive: true },
  { name: "Areadocumental", host: "https://www.area-documental.com/", type: "wp", alive: true },
  { name: "Areshd", host: "https://areshd.com/", type: "wp", alive: true },
  { name: "Asialive", host: "https://asialiveaction.com/", type: "wp", alive: true },
  { name: "Bloghorror", host: "https://bloghorror.com/", type: "wp", alive: false },
  { name: "Ciberdocumentales", host: "https://www.ciberdocumentales.com", type: "wp", alive: true },
  { name: "Cinecalidad", host: "https://www.cinecalidad.vg/", type: "wp", alive: true },
  { name: "Cinecalidadla", host: "https://cine-calidad.mx/", type: "wp", alive: true },
  { name: "Cinecalidadlol", host: "https://www.cinecalidad.am/", type: "wp", alive: true },
  { name: "Cinecalidadrs", host: "https://www.cinecalidad.my/", type: "wp", alive: true },
  { name: "Cinehindi", host: "https://cinehindi.com/", type: "wp", alive: true },
  { name: "Cinema", host: "https://www1.verpelis.top/", type: "wp", alive: true },
  { name: "Cinemitas", host: "https://cinemitas.org/", type: "wp", alive: false },
  { name: "Cinemundo", host: "https://www.cinemundo.com.ar/", type: "wp", alive: true },
  { name: "Cineplay", host: "https://peliplay.xyz/", type: "wp", alive: true },
  { name: "Cineplus", host: "https://w2.dipelis.com/", type: "post", alive: true },
  { name: "Cineteca", host: "https://www.cinetecagay.com/", type: "wp", alive: true },
  { name: "Cuevana2", host: "https://www.cuevana2.lat/", type: "wp", alive: true },
  { name: "Cuevana3pro", host: "https://cuevanapro.org", type: "wp", alive: true },
  { name: "Cuevanamx", host: "https://www.cuevana-3.mx", type: "wp", alive: true },
  { name: "Cuevanavip", host: "https://ver.cuevana3.one/", type: "wp", alive: false },
  { name: "Divxtotal", host: "https://divxtotal.foo/", type: "wp", alive: true },
  { name: "Documentaleson", host: "https://documentaleson.com/", type: "wp", alive: true },
  { name: "Documentalesonline", host: "https://www.documentales-online.com", type: "wp", alive: true },
  { name: "Documentarystorm", host: "https://www.documentarystorm.com/", type: "wp", alive: true },
  { name: "Dontorrents", host: "https://dontorrent.tips/", type: "post", alive: false },
  { name: "Elifilms", host: "https://allcalidad.re/", type: "wp", alive: true },
  { name: "Elitetorrent", host: "https://www.elitetorrent.com/", type: "wp", alive: true },
  { name: "Elitetorrentnz", host: "https://www.elitetorrent.wf/", type: "wp", alive: true },
  { name: "Ennovelastv", host: "https://l.ennovelas-tv.com/", type: "wp", alive: true },
  { name: "Entrepeliculasyseries", host: "https://entrepeliculasyseries.nz/", type: "wp", alive: false },
  { name: "Estrenoscinesaa", host: "https://www.estrenoscinesaa.com/", type: "wp", alive: true },
  { name: "Flizzmovies", host: "https://flizzmovies.org/", type: "wp", alive: true },
  { name: "Gatotv", host: "https://ver.seriesonline.ws/", type: "wp", alive: false },
  { name: "Genteclic", host: "https://www.genteclic.com/", type: "wp", alive: true },
  { name: "Gnulatv", host: "https://ver.gnula.one/", type: "wp", alive: false },
  { name: "Grantorrent", host: "https://grantorrent.foo/", type: "wp", alive: true },
  { name: "Hacktorrent", host: "https://hacktorrent.cc/", type: "api", alive: true },
  { name: "Hdcinema", host: "https://pelicinehd.com/", type: "wp", alive: false },
  { name: "Homecine", host: "https://www3.homecine.to/", type: "wp", alive: true },
  { name: "Lacartoons", host: "https://www.lacartoons.com/", type: "wp", alive: true },
  { name: "Lamovie", host: "https://lamovie.org/", type: "wp", alive: true },
  { name: "Legalmentegratis", host: "http://legalmentegratis.com/", type: "wp", alive: true },
  { name: "Mbstelenovelas", host: "https://ww2.ojearnovelas.com/", type: "post", alive: false },
  { name: "Megadedeoficial", host: "https://megadede.mobi/", type: "wp", alive: true },
  { name: "Mejortorrentapp", host: "https://www47.mejortorrent.eu", type: "wp", alive: false },
  { name: "Mirandogratis", host: "https://mirandogratis.com/", type: "wp", alive: true },
  { name: "Mitorrent", host: "https://mitorrent.mx/", type: "wp", alive: true },
  { name: "Mundodesconocido", host: "https://www.mundodesconocido.es/", type: "wp", alive: true },
  { name: "Novelas360", host: "https://novelas360.com/", type: "wp", alive: true },
  { name: "Pasateatorrent", host: "https://pasateatorrent.org/", type: "wp", alive: true },
  { name: "Peliculasflix", host: "https://peliculasflix.co/", type: "wp", alive: false },
  { name: "Peliculasonline", host: "https://ver.pelisonline.ws/", type: "wp", alive: false },
  { name: "Peliculaspro", host: "https://pelispro.net/", type: "wp", alive: true },
  { name: "Pelis182", host: "https://pelis182.net/", type: "wp", alive: true },
  { name: "Pelisforte", host: "https://www2.pelisforte.se/", type: "wp", alive: true },
  { name: "Pelisgratishd", host: "https://pelisgratishd.zip/", type: "wp", alive: true },
  { name: "Pelismart", host: "https://smartpelis.tv/", type: "wp", alive: false },
  { name: "Pelispanda", host: "https://pelispanda.org/", type: "api", alive: false },
  { name: "Pelispediais", host: "https://pelispedia.is/", type: "wp", alive: true },
  { name: "Pelisplushdlat", host: "https://pelisplushd.la/", type: "wp", alive: true },
  { name: "Pelisplushdnz", host: "https://pelisplushd.bz/", type: "wp", alive: true },
  { name: "Pelisyseries", host: "https://www2.pelisyseries.net/", type: "wp", alive: true },
  { name: "Plushd", host: "https://tioplus.app/", type: "wp", alive: false },
  { name: "Poseidonhd2", host: "https://www.poseidonhd2.co/", type: "wp", alive: true },
  { name: "Repelis28", host: "https://repelis28.org/", type: "wp", alive: true },
  { name: "Repelishd", host: "https://repelishd.blog/", type: "wp", alive: true },
  { name: "Retrocinema", host: "https://online.historiadelcine.es/", type: "wp", alive: true },
  { name: "Retroflix", host: "https://retroflix.org/", type: "wp", alive: true },
  { name: "Retrotv", host: "https://retrotve.com/", type: "wp", alive: true },
  { name: "Seriesbiblicas", host: "https://seriesbiblicas.net/", type: "wp", alive: true },
  { name: "Seriesgato", host: "https://ver.seriesgato.pw/", type: "wp", alive: false },
  { name: "Serieskao", host: "https://serieskao.top/", type: "wp", alive: true },
  { name: "Seriesmetron", host: "https://www3.seriesmetro.net/", type: "wp", alive: true },
  { name: "Seriespapayato", host: "https://magistv24.com/", type: "wp", alive: true },
  { name: "Seriesretro", host: "https://seriesretro.com/", type: "wp", alive: true },
  { name: "Seriesturcas", host: "https://kaj.seriesturcastv.to/", type: "wp", alive: true },
  { name: "Seriesyonkissx", host: "https://seriesyonkis.cx/", type: "wp", alive: true },
  { name: "Sololatino", host: "https://sololatino.net/", type: "wp", alive: true },
  { name: "Srnovelas", host: "https://srnovelas.com/", type: "wp", alive: true },
  { name: "Subtorrents", host: "https://www1.subtorrents.zip/", type: "wp", alive: true },
  { name: "Todocineclasico", host: "https://leyendasdelcine.com/", type: "wp", alive: true },
  { name: "Topdocumentaryfilms", host: "https://topdocumentaryfilms.com/", type: "wp", alive: false },
  { name: "Tubepelis", host: "https://www.tubepelis.com/", type: "wp", alive: true },
  { name: "Ultrapelis", host: "https://verpeliculasultra.com/", type: "wp", alive: true },
  { name: "Verpelis", host: "https://verpelis.gratis/", type: "wp", alive: true },
  { name: "Vision", host: "https://verpeliculasonline.net/", type: "wp", alive: false },
  { name: "Vivatorrents", host: "https://www.vivatorrents.org/", type: "wp", alive: true },
  { name: "Ytsoficial", host: "https://en.yts-official.com", type: "wp", alive: true },
  { name: "Zonaleros", host: "https://zona-leros.com/", type: "wp", alive: false },
  { name: "Zoowomaniacos", host: "https://zoowomaniacos.org/", type: "wp", alive: true }
];

// Canales torrent ya implementados con motores dedicados (no van aquí):
//   HackTorrent (balandro_multi), DonTorrent/EliteTorrent (balandro_scraper)

const DETAIL_RE = /<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/g;

function searchUrl(channel, query) {
  const t = encodeURIComponent(query).replace(/%20/g, '+');
  if (channel.type === 'path') return channel.host + 'search/' + t;
  return channel.host + '?s=' + t;
}

// Parseo genérico: enlaces internos cuyo texto/URL apunta a detalle y
// contiene palabras del título buscado
function parseResults(html, channel, queryTokens) {
  const out = [];
  const seen = new Set();
  let m;
  DETAIL_RE.lastIndex = 0;
  while ((m = DETAIL_RE.exec(html)) !== null) {
    let href = m[1];
    const block = m[2];
    // título: preferir <div class="in_title"> (tema cine-calidad), si no el texto plano
    let text = (block.match(/in_title[^>]*>\s*([^<]{2,90})</) || [])[1];
    if (!text) text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    text = (text || '').trim();
    if (!text || text.length < 2) continue;
    if (!href.startsWith('http')) {
      if (!href.startsWith('/')) continue;
      href = channel.host.replace(/\/$/, '') + href;
    }
    if (!/(pelicula|serie|movie|series|ver|titulo|title|film|capitulo|episodio)/i.test(href)) continue;
    if (/(category|genero|page\/|tag\/|author|#|feed)/i.test(href)) continue;
    const low = text.toLowerCase();
    const rel = href.toLowerCase();
    const matches = queryTokens.some(t => t.length >= 4 && (low.includes(t) || rel.includes(t)));
    if (!matches || seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, title: text });
  }
  return out;
}

async function searchChannel(channel, query, timeoutMs = 7000) {
  try {
    const response = await axios.get(searchUrl(channel, query), {
      timeout: timeoutMs,
      maxRedirects: 3,
      validateStatus: null,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' }
    });
    if (response.status !== 200) return [];
    const html = typeof response.data === 'string' ? response.data : '';
    if (/<title>Just a moment/.test(html)) return []; // Cloudflare: FlareSolverr en play-time si hace falta
    return parseResults(html, channel, query.toLowerCase().split(' ').filter(t => t.length >= 4));
  } catch (e) {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await fn(items[my], my);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Busca en TODOS los canales registrados y devuelve streams deferidos.
 * Multi-variante: título completo + fragmento simplificado + token distintivo.
 * Hasta maxPerChannel entradas por canal (episodios/calidades alternativas).
 * @returns [{ rawTitle, url (/resolve deferido), source, seeders, size }]
 */
async function fetchChannels(query, { season, episode, resolveBase, maxPerChannel = 3, maxChannels = 91 } = {}) {
  if (!query) return [];
  const base = resolveBase || `http://127.0.0.1:${process.env.PORT || 7003}`;
  const tokens = query.toLowerCase().split(' ').filter(t => t.length >= 4);

  // Variantes de búsqueda: completa + simplificada (antes de ':'/'-') + token distintivo
  const variants = [...new Set([
    query,
    query.split(/[:\-–—]/)[0].trim(),
    tokens[tokens.length - 1] || ''
  ].filter(v => v && v.length >= 4))];

  const settled = await mapLimit(CHANNELS, 10, async (ch) => {
    const found = await searchChannel(ch, query);
    if (found.length) return { ch, found };
    // reintento con variantes (títulos traducidos/abreviados)
    for (const v of variants) {
      const alt = await searchChannel(ch, v);
      if (alt.length) return { ch, found: alt };
    }
    return null;
  });

  const streams = [];
  const hits = [];
  for (const r of settled) {
    if (!r) continue;
    hits.push(r.ch.name);
    // hasta maxPerChannel entradas por canal: alternativas para el usuario
    const seasonTag = season != null ? ` [Temporada ${season}]` : '';
    r.found.slice(0, maxPerChannel).forEach((item, i) => {
      const payload = Buffer.from(JSON.stringify({
        e: 'ch', url: item.url, host: r.ch.host, title: item.title
      })).toString('base64');
      const suffix = i > 0 ? ` [alt ${i + 1}]` : '';
      streams.push({
        rawTitle: `${item.title}${seasonTag}${suffix} [Latino Web]`,
        url: `${base}/resolve?p=${payload}`,
        source: `Canal ${r.ch.name} 🇲🇽`,
        seeders: 0,
        size: 0
      });
    });
    if (streams.length >= maxChannels) break;
  }

  console.log(`✅ Canales: ${streams.length} deferidos de ${hits.length} canales con resultado (${hits.slice(0, 10).join(', ')}${hits.length > 10 ? '…' : ''})`);
  return streams;
}

// --- Resolución play-time: ficha del canal -> embed -> m3u8/mp4 directo ---
const { fetchWithAntiblock } = require('./antiblock');

// decode data-src de la familia cine-calidad (base64 -> charcodes -2)
function decodeDataSrc(b64) {
  try {
    const nums = Buffer.from(b64, 'base64').toString('utf-8').split(' ').filter(Boolean).map(Number);
    if (!nums.length) return null;
    const url = nums.map(n => String.fromCharCode(n - 2)).join('');
    return url.startsWith('http') ? url : null;
  } catch (e) { return null; }
}

function extractEmbedsFromDetail(html) {
  const embeds = [];
  // iframes directos
  let m;
  const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    if (/^https?:\/\//.test(m[1]) && !/youtube|facebook/.test(m[1])) embeds.push(m[1]);
  }
  // familia cine-calidad (data-src cifrado)
  const dsRe = /data-src="([^"]+)"[^>]*data-domain="([^"]+)"/g;
  while ((m = dsRe.exec(html)) !== null) {
    const url = decodeDataSrc(m[1]);
    if (url && !/youtube|tubesb|hackplayer/i.test(m[2])) embeds.push(url);
  }
  return [...new Set(embeds)].slice(0, 4);
}

function extractDirect(html) {
  const mm = html.match(/"(https?:\/\/[^"]+\.(?:m3u8|mp4)[^"]*)"/i);
  if (mm) return mm[1];
  const ms = html.match(/file\s*:\s*"(https?:\/\/[^"]+)"/i);
  if (ms) return ms[1];
  return null;
}

async function resolveChannel(payload) {
  if (!payload || payload.e !== 'ch' || !payload.url) return null;
  const { html, via } = await fetchWithAntiblock(payload.url, { timeout: 9000 });
  if (!html) return null;

  // 1) archivo directo en la propia ficha
  const direct = extractDirect(html);
  if (direct) return { url: direct, referer: payload.host };

  // 2) embeds -> intentar extracción en cada uno
  const embeds = extractEmbedsFromDetail(html);
  for (const embed of embeds) {
    try {
      const r = await axios.get(embed, {
        timeout: 8000, maxRedirects: 3,
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9', Referer: payload.url }
      });
      const t = String(r.data || '');
      const d = extractDirect(t);
      if (d) return { url: d, referer: embed };
    } catch (e) { /* siguiente embed */ }
  }
  return null;
}

module.exports = { fetchChannels, resolveChannel, CHANNELS };
