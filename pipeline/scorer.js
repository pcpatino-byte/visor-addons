const SCORES = {
  BASE_8K: 8,
  BASE_4K: 6,
  BASE_1080P: 3,
  BASE_720P: 2,
  BASE_480P: 1,
  BONUS_IMAX: 2.5,
  BONUS_HDR: 1.5
};

function detectResolution(rawTitle) {
  if (!rawTitle) return null;
  if (/\b(8K|4320p)\b/i.test(rawTitle)) return '8K';
  if (/\b(4K|2160p|UHD)\b/i.test(rawTitle)) return '4K';
  if (/\b1080p?\b/i.test(rawTitle)) return '1080p';
  if (/\b720p?\b/i.test(rawTitle)) return '720p';
  if (/\b480p?\b/i.test(rawTitle)) return '480p';
  return null;
}

function detectImax(rawTitle) {
  return /\bIMAX\b/i.test(rawTitle);
}

function detectHdr(rawTitle) {
  return /\b(DV|Dolby\s?Vision|HDR10\+?|HDR)\b/i.test(rawTitle);
}

function scoreStream(stream) {
  if (!stream || !stream.rawTitle) return 0;

  const title = stream.rawTitle;
  const resolution = detectResolution(title);

  let score = 0;
  switch (resolution) {
    case '8K': score = SCORES.BASE_8K; break;
    case '4K': score = SCORES.BASE_4K; break;
    case '1080p': score = SCORES.BASE_1080P; break;
    case '720p': score = SCORES.BASE_720P; break;
    case '480p': score = SCORES.BASE_480P; break;
    default: score = 1;
  }

  if (detectImax(title)) score += SCORES.BONUS_IMAX;
  if (detectHdr(title)) score += SCORES.BONUS_HDR;

  stream.resolution = resolution;
  stream.score = score;

  return score;
}

function sortStreams(streams) {
  return streams.sort((a, b) => b.score - a.score);
}

function scoreAndSortStreams(streams) {
  streams.forEach(scoreStream);
  return sortStreams(streams);
}

module.exports = { scoreStream, scoreAndSortStreams, detectResolution, detectImax, detectHdr };
