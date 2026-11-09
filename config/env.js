require('dotenv').config();

// Las credenciales viven SOLO en .env (nunca hardcodeadas en código).
module.exports = {
  PORT: process.env.PORT || 7000,
  PROWLARR_URL: process.env.PROWLARR_URL || 'http://localhost:9696',
  PROWLARR_API_KEY: process.env.PROWLARR_API_KEY || '',
  CACHE_TTL_HOURS: parseInt(process.env.CACHE_TTL_HOURS || '24', 10),
  GLOBAL_TIMEOUT_MS: parseInt(process.env.GLOBAL_TIMEOUT_MS || '5000', 10),
  SOFT_TIMEOUT_MS: parseInt(process.env.SOFT_TIMEOUT_MS || '12000', 10),
  // Puertos de los 2 addons separados
  SITES_PORT: process.env.SITES_PORT || 7003,
  // FlareSolverr (antibloqueo Cloudflare)
  FLARESOLVERR_URL: process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1',
  // Base para urls deferidas /resolve: si no se define, cada addon usa su propio puerto
  RESOLVE_BASE_URL: process.env.RESOLVE_BASE_URL || '',
  DB_PATH: process.env.DB_PATH || './cache/cache.db'
};
