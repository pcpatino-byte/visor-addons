// Politica de idioma: SOLO Audio Latino (whitelist).
// Castellano de Espana se trata igual que ingles/VOSE: descartado.
// Los multilenguaje (MULTI) se asumen latino por defecto: suelen incluir
// pista "espanol" que realmente es latino.

const LATINO_PATTERNS = [
  /\blatino\b/i,
  /\blat\b/i,
  /\blatam\b/i,
  /\bespa(ñ|n)ol\s+latino\b/i,
  /\bcastellano\s+latino\b/i,
  /\baudio\s+latino\b/i,
  /\bdobl(aje|ada?o)?\s+latino\b/i,
  /\bmex(?:icano)?\b/i,
  // mx con guardas: "YTS.MX" (TLD) NO cuenta, "MX" aislado sí
  /(?<![\w.])mx\b(?![.\w])/i
];

// Multilenguaje: SOLO cuenta si el título también declara pista de español.
// "MULTi.FRENCH" (francés+inglés) NO es latino — error detectado en The Diplomat.
const MULTI_PATTERNS = [
  /\bmulti(?:lenguaje|lingue|language|languages|audio|audios|idioma|idiomas)?\b/i,
  /\btriple\b/i
];

const SPANISH_HINT_PATTERNS = [
  /\bespa(ñ|n)ol\b/i,
  /\bspanish\b/i,
  /\besp\b/i,
  /\blatino\b/i,
  /\blatam\b/i,
  /\bcastellano\b/i,
  /\bmx\b/i,
  /[\[\( ]es[\]\) ]/i
];

// Marcadores que identifican releases de Espana (castellano puro) u otros
// idiomas no aceptados. Con la whitelist no son necesarios para filtrar,
// pero se usan para depuracion y para NO puntuar como latino un
// multilenguaje que declare explicitamente solo castellano.
const CASTELLANO_PURO_PATTERNS = [
  /\bcastellano\b(?!\s+latino)/i,
  /\bcast\b(?!.*latino)/i,
  /\bespa(ñ|n)ol\b(?!\s*(latino|mx|latam|lat\b))/i,
  /\besp\b(?!\s*(latino|mx|latam|lat\b))/i
];

function detectLanguage(rawTitle) {
  if (!rawTitle) return null;

  const isMulti = MULTI_PATTERNS.some(p => p.test(rawTitle));
  const isLatino = LATINO_PATTERNS.some(p => p.test(rawTitle));

  if (isLatino) return 'LATINO';

  // MULTI exige pista explícita de español; si no, es MULTI europeo (fr/it/…)
  if (isMulti && SPANISH_HINT_PATTERNS.some(p => p.test(rawTitle))) return 'LATINO (MULTI)';

  return null;
}

// Calidad: NO exigir etiqueta de resolución (muchos torrents web no la traen);
// solo descartar fuentes basura (CAM/TS/Screener).
const BAD_SOURCE_PATTERNS = /\b(CAM|HDCAM|TS|TC|SCREENER|DVDSCR|WEBRIP-LQ)\b/i;

function passesQualityFilter(rawTitle) {
  if (!rawTitle) return false;
  return !BAD_SOURCE_PATTERNS.test(rawTitle);
}

// ---------------------------------------------------------------------------
// Relevancia: verifica que el release corresponde a la obra pedida.
// Sin esto, indexers que devuelven resultados difusos (p.ej. 238 por
// "House S01E02") meten episodios de OTRAS series al menú.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'en', 'in', 'on', 'to']);

function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleTokens(title) {
  return normalizeForMatch(title).split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Equivalencias ES/EN frecuentes en títulos traducidos (Part Two ↔ Parte Dos)
const TRANSLATIONS = {
  part: ['parte'], parte: ['part'],
  one: ['uno'], uno: ['one'],
  two: ['dos'], dos: ['two'],
  three: ['tres'], tres: ['three'],
  four: ['cuatro'], cuatro: ['four'],
  five: ['cinco'], cinco: ['five']
};

function wordMatchesToken(w, t) {
  if (w === t) return true;
  if (t.length >= 3 && (w.includes(t) || t.includes(w))) return true;
  // traducción declarada
  const alts = TRANSLATIONS[t] || [];
  return alts.some(a => a === w);
}

function matchesContent(rawTitle, title, season, episode, relaxed = false) {
  if (!title) return true;
  if (relaxed) {
    // Relajada: el título buscado (o su raíz) debe aparecer; los sitios
    // re-titulan en español ("Backrooms: Sin salida") y no se penalizan extras.
    const relNorm = normalizeForMatch(rawTitle);
    const mainTokens = titleTokens(title);
    if (mainTokens.length === 0) return true;
    const hits = mainTokens.filter(t => relNorm.includes(t) ||
      (TRANSLATIONS[t] || []).some(a => relNorm.includes(a))).length;
    if (hits === 0 && mainTokens.length > 0) return false;
    // Series: exigir tag de episodio o paquete (igual que en modo estricto)
    if (season != null) {
      const s2 = String(season).padStart(2, '0');
      const e2 = String(episode).padStart(2, '0');
      const hasEpisodeTag = new RegExp(`s${s2}e${e2}`, 'i').test(relNorm)
        || new RegExp(`(?:^|[ .])${season}x${e2}(?:[ .]|$)`, 'i').test(relNorm)
        || new RegExp(`(?:^|[ .])${season}x${episode}(?:[ .]|$)`, 'i').test(relNorm)
        || /\btemporada\b/i.test(relNorm) || new RegExp(`s${s2}\\b`, 'i').test(relNorm);
      if (!hasEpisodeTag) return false;
    }
    return true;
  }

  const rel = normalizeForMatch(rawTitle);
  const tokens = titleTokens(title);
  if (tokens.length === 0) return true;

  // Palabras estructurales/calidad que no forman parte del título de la obra
  const STRUCTURAL = new Set([
    'temporada', 'season', 'completa', 'completo', 'serie', 'pack', 'episodio',
    'episodios', 'capitulo', 'capitulos', 'latino', 'latina', 'castellano',
    'espanol', 'español', 'dual', 'multi', 'subtitulado', 'vos', 'vose',
    'idioma', 'audio', 'doblada', 'doblaje', 'web', 'dl', 'rip', 'torrent'
  ]);

  // Parte "título" del release: lo que va ANTES del tag SxxExx/xNN (series)
  // o antes del primer año/calidad (películas). Los grupos/etiquetas posteriores
  // no cuentan como extras.
  let titlePart = rel;
  if (season != null) {
    const tagMatch = rel.match(/(?:s\d{2}e\d{2}|[ .]\d{1,2}x\d{1,2}(?:[ .]|$)|temporada[ .]*\d+)/i);
    if (tagMatch && tagMatch.index > 0) titlePart = rel.slice(0, tagMatch.index);
  } else {
    const yearMatch = rel.match(/\b(19|20)\d{2}\b/);
    const qualMatch = rel.match(/\b(1080p|720p|2160p|4320p|480p|4k|8k|uhd|hdr|web|rip|bluray|remux|hdrip|dvdrip|hdtv)\b/i);
    const cut = [yearMatch, qualMatch].filter(Boolean).map(m => m.index).sort((a, b) => a - b)[0];
    if (cut > 0) titlePart = rel.slice(0, cut);
  }

  const titleWords = titlePart.replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);

  // Hits: palabra exacta, substring bidireccional ≥3 o traducción declarada
  const hits = tokens.filter(t => titleWords.some(w => wordMatchesToken(w, t))).length;
  if (hits / tokens.length < 0.6) return false;

  // Extras: palabras significativas de la parte-título que no son del título de la obra
  const extras = titleWords.filter(w =>
    w.length >= 3 &&
    !STOPWORDS.has(w) &&
    !STRUCTURAL.has(w) && !/^\d+$/.test(w) &&
    !tokens.some(t => wordMatchesToken(w, t))
  );
  if (extras.length > 0) return false;

  // Series: exigir tag de episodio (S04E01 / 4x01) o paquete de temporada
  if (season != null) {
    const s2 = String(season).padStart(2, '0');
    const e2 = String(episode).padStart(2, '0');
    const hasEpisodeTag = new RegExp(`s${s2}e${e2}`, 'i').test(rel)
      || new RegExp(`(?:^|[ .])${season}x${e2}(?:[ .]|$)`, 'i').test(rel)
      || new RegExp(`(?:^|[ .])${season}x${episode}(?:[ .]|$)`, 'i').test(rel);
    const isSeasonPack = new RegExp(`(?:s${s2}|temporada[ .]*${season}\\b)`, 'i').test(rel)
      && !new RegExp(`\\be\\d{2,}\\b`, 'i').test(rel.replace(new RegExp(`s${s2}e${e2}`, 'i'), ''));
    if (!hasEpisodeTag && !isSeasonPack) return false;
  }

  return true;
}

function filterStreams(streams, {
  allowOtherLanguages = false, title = null, season = null, episode = null,
  relaxedRelevance = false
} = {}) {
  return streams.filter(stream => {
    const language = detectLanguage(stream.rawTitle);
    if (!language && !allowOtherLanguages) return false;
    if (language) stream.language = language;
    if (!passesQualityFilter(stream.rawTitle) && !allowOtherLanguages) return false;
    // Estricta: para resultados de búsqueda por keywords (Prowlarr) — evita
    // shows equivocados. Relajada: para motores de sitios que buscan POR TÍTULO
    // (los sitios latinos re-titulan: "Backrooms: Sin salida").
    if (!matchesContent(stream.rawTitle, title, season, episode, relaxedRelevance)) return false;
    return true;
  });
}

module.exports = {
  detectLanguage,
  passesQualityFilter,
  filterStreams,
  matchesContent,
  LATINO_PATTERNS,
  MULTI_PATTERNS,
  CASTELLANO_PURO_PATTERNS
};
