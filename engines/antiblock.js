// Capa antibloqueo: intento directo -> fallback FlareSolverr (Cloudflare).
// FlareSolverr renderiza la página en un navegador real y devuelve el HTML
// resultante; nuestros regex de parseo funcionan igual sobre ese HTML.

const axios = require('axios');
const env = require('../config/env');

const FS_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function looksLikeCloudflare(html) {
  if (!html || typeof html !== 'string') return true;
  return html.includes('<title>Just a moment...</title>')
    || html.includes('cf-browser-verification')
    || html.includes('challenge-platform')
    || html.includes('Attention Required! | Cloudflare');
}

// request.get vía FlareSolverr -> HTML renderizado
async function flaresolverrGet(url, maxTimeout = 55000) {
  const response = await axios.post(FS_URL, {
    cmd: 'request.get',
    url,
    maxTimeout
  }, { timeout: maxTimeout + 10000, headers: { 'Content-Type': 'application/json' } });

  const solution = response.data?.solution;
  try { const { setLastCookies } = require("./dood"); setLastCookies(solution?.cookies || []); } catch (e) {}
  if (!solution?.response) throw new Error('FlareSolverr sin solución: ' + (response.data?.message || response.data?.msg || ''));
  return solution.response;
}

/**
 * fetch con antibloqueo:
 *   1. GET directo con axios (rápido, ~1-2s)
 *   2. Si falla (red/403/503) o huele a Cloudflare -> FlareSolverr (5-30s)
 * Devuelve { html, via } donde via = 'direct' | 'flaresolverr' | null
 */
async function fetchWithAntiblock(url, { headers = {}, timeout = 8000, allowFlare = true } = {}) {
  // 1) directo
  try {
    const response = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9', ...headers }
    });
    const html = typeof response.data === 'string' ? response.data : String(response.data);
    if (!looksLikeCloudflare(html)) return { html, via: 'direct' };
  } catch (e) { /* cae al fallback */ }

  // 2) FlareSolverr
  if (allowFlare) {
    try {
      const html = await flaresolverrGet(url);
      return { html, via: 'flaresolverr' };
    } catch (e) {
      return { html: null, via: null };
    }
  }

  return { html: null, via: null };
}

// request.post vía FlareSolverr (formularios tras Cloudflare)
async function flaresolverrPost(url, formData, maxTimeout = 55000) {
  const postData = Object.entries(formData)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const response = await axios.post(FS_URL, {
    cmd: 'request.post',
    url,
    postData,
    maxTimeout
  }, { timeout: maxTimeout + 10000, headers: { 'Content-Type': 'application/json' } });

  const solution = response.data?.solution;
  if (!solution?.response) throw new Error('FlareSolverr sin solución (POST)');
  return solution.response;
}

module.exports = { fetchWithAntiblock, flaresolverrGet, flaresolverrPost, looksLikeCloudflare };
