function normalizeTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return '';

  let title = rawTitle
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sizeMatch = title.match(/(\d+(?:\.\d+)?)\s?(GB|MB|TB|KB)/i);
  const size = sizeMatch ? `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}` : null;

  title = title
    .replace(/(\d+(?:\.\d+)?)\s?(GB|MB|TB|KB)/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+-\s+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { clean: title, size };
}

function extractSize(rawTitle) {
  const match = rawTitle.match(/(\d+(?:\.\d+)?)\s?(GB|MB|TB|KB)/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers = { KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
  return value * (multipliers[unit] || 1);
}

module.exports = { normalizeTitle, extractSize };
