'use strict';

// Account + AP storage.
// "Password-only login": the SHA-256 of the password IS the account key, so the
// same password always maps to the same account. We never store the plaintext.
// Uses Postgres when DATABASE_URL is set (production), otherwise an in-memory
// Map so local development works with no database.

const crypto = require('crypto');

const MAX_NAME = 12;
const START_AP = 100;
const WIN_AP = 15;
const LOSE_AP = 10;

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}
function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s || 'Player';
}

let backend = null;

function memBackend() {
  const rows = new Map(); // key -> { name, ap, wins, losses }
  return {
    async login(name, password) {
      const key = hashPw(password);
      if (!rows.has(key)) rows.set(key, { name: cleanName(name), ap: START_AP, wins: 0, losses: 0 });
      const r = rows.get(key);
      return { key, name: r.name, ap: r.ap };
    },
    async applyResult(winnerKey, loserKey) {
      const w = rows.get(winnerKey);
      const l = rows.get(loserKey);
      if (w) { w.ap += WIN_AP; w.wins += 1; }
      if (l) { l.ap = Math.max(0, l.ap - LOSE_AP); l.losses += 1; }
      return { winnerAp: w ? w.ap : null, loserAp: l ? l.ap : null };
    },
  };
}

function pgBackend(pool) {
  return {
    async login(name, password) {
      const key = hashPw(password);
      const found = await pool.query('SELECT name, ap FROM players WHERE pwhash = $1', [key]);
      if (found.rows.length) return { key, name: found.rows[0].name, ap: found.rows[0].ap };
      await pool.query(
        'INSERT INTO players (pwhash, name, ap) VALUES ($1, $2, $3) ON CONFLICT (pwhash) DO NOTHING',
        [key, cleanName(name), START_AP]
      );
      const r = await pool.query('SELECT name, ap FROM players WHERE pwhash = $1', [key]);
      return { key, name: r.rows[0].name, ap: r.rows[0].ap };
    },
    async applyResult(winnerKey, loserKey) {
      const w = await pool.query(
        'UPDATE players SET ap = ap + $2, wins = wins + 1, updated_at = now() WHERE pwhash = $1 RETURNING ap',
        [winnerKey, WIN_AP]
      );
      const l = await pool.query(
        'UPDATE players SET ap = GREATEST(0, ap - $2), losses = losses + 1, updated_at = now() WHERE pwhash = $1 RETURNING ap',
        [loserKey, LOSE_AP]
      );
      return {
        winnerAp: w.rows[0] ? w.rows[0].ap : null,
        loserAp: l.rows[0] ? l.rows[0].ap : null,
      };
    },
  };
}

async function init() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const ssl = url.includes('railway.internal') || url.includes('localhost')
      ? false
      : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: url, ssl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        pwhash      TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        ap          INTEGER NOT NULL DEFAULT ${START_AP},
        wins        INTEGER NOT NULL DEFAULT 0,
        losses      INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    backend = pgBackend(pool);
    console.log('[db] using Postgres');
  } else {
    backend = memBackend();
    console.log('[db] using in-memory store (no DATABASE_URL)');
  }
}

module.exports = {
  init,
  login: (name, password) => backend.login(name, password),
  applyResult: (winnerKey, loserKey) => backend.applyResult(winnerKey, loserKey),
  hashPw,
  cleanName,
  START_AP,
  WIN_AP,
  LOSE_AP,
};
