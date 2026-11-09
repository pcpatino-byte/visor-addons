const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const env = require('../config/env');

const dbPath = path.resolve(__dirname, '..', env.DB_PATH);
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function initDb() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS streams_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        imdb_id TEXT NOT NULL,
        engine_source TEXT,
        raw_title TEXT,
        stream_data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `, (err) => {
      if (err) return reject(err);
      db.run(`CREATE INDEX IF NOT EXISTS idx_imdb_id ON streams_cache(imdb_id)`, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function getCachedStreams(imdbId) {
  return new Promise((resolve, reject) => {
    const ttlMs = env.CACHE_TTL_HOURS * 3600 * 1000;
    const minTimestamp = Date.now() - ttlMs;

    db.all(
      `SELECT stream_data FROM streams_cache WHERE imdb_id = ? AND timestamp >= ?`,
      [imdbId, minTimestamp],
      (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return resolve(null);
        try {
          const streams = rows.map(r => JSON.parse(r.stream_data));
          resolve(streams);
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

function saveStreamsToCache(imdbId, streams) {
  return new Promise((resolve, reject) => {
    if (!streams || streams.length === 0) return resolve();

    const timestamp = Date.now();
    const stmt = db.prepare(`
      INSERT INTO streams_cache (imdb_id, engine_source, raw_title, stream_data, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      for (const s of streams) {
        stmt.run(
          imdbId,
          s.source || 'unknown',
          s.title || s.rawTitle || '',
          JSON.stringify(s),
          timestamp
        );
      }
      db.run('COMMIT', (err) => {
        stmt.finalize();
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

module.exports = {
  initDb,
  getCachedStreams,
  saveStreamsToCache
};
