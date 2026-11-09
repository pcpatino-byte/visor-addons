// Extractor DoodStream (familia: doodstream.com, dood.watch, dood.la, doo.lat…)
// Algoritmo estándar de scrapers Dood:
//   1. GET página embed → localiza ruta '/pass_md5/…' en el JS
//   2. GET {host}/pass_md5/… con Referer del embed → responde la URL mp4 base
//   3. URL final = base + sufijo aleatorio + '?token=' + token('' del pass_md5) + '&expiry='

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DOOD_HOSTS = /dood|doo\.|ds2play|dsvplay|d000d|dooood/i;

function isDood(url) {
  return DOOD_HOSTS.test(url || '');
}

function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function get(url, referer) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 4,
    validateStatus: null,
    headers: {
      'User-Agent': UA,
      ...(referer ? { Referer: referer } : {})
    }
  });
  return { status: response.status, text: String(response.data || '') };
}

async function getWithCookies(url, referer) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 4,
    validateStatus: null,
    headers: {
      'User-Agent': UA,
      ...(referer ? { Referer: referer } : {})
    }
  });
  return {
    status: response.status,
    text: String(response.data || ''),
    headers: response.headers
  };
}

async function getPassMd5(url, referer, cookies) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 4,
    validateStatus: null,
    headers: {
      'User-Agent': UA,
      Referer: referer,
      ...(cookies ? { Cookie: cookies } : {})
    }
  });
  return String(response.data || '').trim();
}

async function extractDood(embedUrl) {
  try {
    // cookies de sesión: el pass_md5 solo valida con las cookies del embed
    let cookies = '';
    let page = '';
    let via = 'direct';

    // 1) directo; 2) si Cloudflare ("Just a moment") → FlareSolverr
    let r = await getWithCookies(embedUrl, 'https://areshd.com/');
    cookies = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    page = r.text;

    if (!/pass_md5/.test(page) && /Just a moment|challenge/i.test(page)) {
      const { flaresolverrGet } = require('./antiblock');
      const sol = await flaresolverrGet(embedUrl);
      page = sol || '';
      via = 'flaresolverr';
      // cookies devueltas por FlareSolverr
      const fsCookies = (require('./antiblock').lastCookies || []);
      // FlareSolverr entrega cookies en la solución; las captura antiblock
      cookies = cookies || fsCookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
    if (!page) return null;

    // ruta pass_md5 en el JS del embed (genérico: acepta guiones/uuid)
    let md5Path = null;
    const p = page.match(/pass_md5\/([^\s'"\\)]+)/);
    md5Path = p ? '/pass_md5/' + p[1] : null;
    if (!md5Path) return null;

    const u = new URL(embedUrl);
    const host = `${u.protocol}//${u.host}`;

    // base mp4 (con cookies + referer del embed)
    const direct = await getPassMd5(host + md5Path, embedUrl, cookies);
    if (!direct || !direct.startsWith('http')) return null;

    // token = último segmento del pass_md5
    const token = md5Path.split('/').pop();

    // URL final: base + 10 chars aleatorios + ?token=…&expiry=…
    return `${direct}${randomString(10)}?token=${token}&expiry=`;
  } catch (e) {
    return null;
  }
}

// FlareSolverr devuelve cookies de la solución: exponerlas para el pass_md5
let lastCookies = [];
function setLastCookies(cookies) { lastCookies = cookies || []; }
function getLastCookies() { return lastCookies; }

module.exports = { extractDood, isDood, setLastCookies, getLastCookies };
