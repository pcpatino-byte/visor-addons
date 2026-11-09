// Descifrador de enlaces acortalink/s.php (patrón GibberishAES de Balandro).
// Flujo (lib/decrypters.py + lib/pyberishaes.py):
//   1. La página del acortador contiene la clave:  TTTOzBmk = '...'
//   2. El payload (param i=) es base64 de "Salted__"+salt+ciphertext
//      (AES-256-CBC, derivación EVP_BytesToKey con MD5 — formato CryptoJS)
//   3. Descifrar -> magnet:/http://

const crypto = require('crypto');
const axios = require('axios');

const KEY_PATTERNS = [
  /TTTOzBmk\s*=\s*'(.*?)'/,
  /[A-Za-z_$][\w$]*\s*=\s*'([A-Za-z0-9+/=]{16,64})'/
];

function evpBytesToKey(pass, salt, keyLen = 32, ivLen = 16) {
  const md5 = (b) => crypto.createHash('md5').update(b).digest();
  let d = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (d.length < keyLen + ivLen) {
    prev = md5(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt]));
    d = Buffer.concat([d, prev]);
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) };
}

// Descifrado GibberishAES (AES-256-CBC "Salted__")
function gibberishDecrypt(b64, pass) {
  try {
    const data = Buffer.from(b64, 'base64');
    if (data.subarray(0, 8).toString('latin1') !== 'Salted__') return null;
    const salt = data.subarray(8, 16);
    const ct = data.subarray(16);
    const { key, iv } = evpBytesToKey(pass, salt, 32, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
    return /^[\x20-\x7e\n\r\t]*$/.test(out.slice(0, 64)) ? out : null;
  } catch (e) {
    return null;
  }
}

// i= param de la URL acortada (o el propio blob base64)
function extractPayload(linkUrl) {
  const m = linkUrl.match(/[?&]i=([A-Za-z0-9+/=]+)/);
  return m ? m[1] : (linkUrl.startsWith('U2FsdGVk') ? linkUrl : null);
}

async function fetchPage(url, referer) {
  const response = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(referer ? { Referer: referer } : {})
    }
  });
  return response.data;
}

// Fallback anti-bot (decrypters.py): POST al dominio acortador con
// linkser=<referer en ROT13> -> responde la página con la clave
function rot13(s) {
  return s.replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

async function fetchKeyViaLinkser(linkUrl) {
  try {
    const u = new URL(linkUrl);
    const host = `${u.protocol}//${u.host}/`;
    const linkser = 'linkser=' + encodeURIComponent(rot13(refererOf(linkUrl)));
    const response = await axios.post(host, linkser, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': linkUrl,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const text = String(response.data || '');
    for (const re of KEY_PATTERNS) {
      const m = text.match(re);
      if (m && m[1] && m[1].length >= 16) return m[1];
    }
    return null;
  } catch (e) {
    return null;
  }
}

function refererOf(linkUrl) {
  try {
    const u = new URL(linkUrl);
    // El sitio de origen va codificado en el propio dominio acortador por
    // Balandro; usamos el host raíz del acortador como fallback genérico.
    return u.searchParams.get('t') || `${u.protocol}//${u.host}/`;
  } catch (e) {
    return 'https://cine-calidad.mx/';
  }
}

// Descifra un enlace acortado; devuelve magnet:/http(s):// o null
async function decryptAcortalink(linkUrl, referer) {
  try {
    const payload = extractPayload(linkUrl);
    if (!payload) return null;
    if (payload.startsWith('magnet:')) return payload;

    const html = await fetchPage(linkUrl, referer);
    const text = typeof html === 'string' ? html : String(html);

    let key = null;
    for (const re of KEY_PATTERNS) {
      const m = text.match(re);
      if (m && m[1] && m[1].length >= 16) { key = m[1]; break; }
    }

    if (!key) {
      key = await fetchKeyViaLinkser(linkUrl);
    }

    if (!key) return null;

    const result = gibberishDecrypt(payload, key);
    if (result && (result.startsWith('magnet:') || result.startsWith('http'))) {
      return result.trim();
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { decryptAcortalink, gibberishDecrypt };
