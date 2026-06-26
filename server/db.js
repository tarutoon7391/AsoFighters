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
const STREAK_STEP = 5;        // bonus AP per win in a streak
const STREAK_BONUS_MAX = 25;  // cap on the streak bonus

// bonus for reaching `streak` consecutive wins (streak counted AFTER this win)
function streakBonus(streak) {
  return Math.min(STREAK_BONUS_MAX, Math.max(0, streak - 1) * STREAK_STEP);
}

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}
function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return s || 'Player';
}

let backend = null;

function memBackend() {
  const rows = new Map(); // key -> { name, ap, wins, losses, streak, bestStreak }

  function rankOf(ap) {
    let r = 1;
    for (const v of rows.values()) if (v.ap > ap) r++;
    return r;
  }

  return {
    async login(name, password) {
      const key = hashPw(password);
      if (!rows.has(key)) rows.set(key, { name: cleanName(name), ap: START_AP, wins: 0, losses: 0, streak: 0, bestStreak: 0 });
      const r = rows.get(key);
      return { key, name: r.name, ap: r.ap };
    },
    async profile(key) {
      const r = rows.get(key);
      if (!r) return null;
      return { name: r.name, ap: r.ap, wins: r.wins, losses: r.losses, streak: r.streak, bestStreak: r.bestStreak, rank: rankOf(r.ap) };
    },
    async leaderboard(limit) {
      return [...rows.values()]
        .sort((a, b) => b.ap - a.ap || b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((x) => ({ name: x.name, ap: x.ap, wins: x.wins, losses: x.losses }));
    },
    async applyResult(winnerKey, loserKey) {
      const w = rows.get(winnerKey);
      const l = rows.get(loserKey);
      let winner = null, loser = null;
      if (w) {
        const oldAp = w.ap;
        w.streak += 1;
        w.bestStreak = Math.max(w.bestStreak, w.streak);
        const bonus = streakBonus(w.streak);
        w.ap += WIN_AP + bonus;
        w.wins += 1;
        winner = { ap: w.ap, wins: w.wins, losses: w.losses, streak: w.streak, bestStreak: w.bestStreak, delta: w.ap - oldAp, bonus, base: WIN_AP };
      }
      if (l) {
        const oldAp = l.ap;
        l.ap = Math.max(0, l.ap - LOSE_AP);
        l.losses += 1;
        l.streak = 0;
        loser = { ap: l.ap, wins: l.wins, losses: l.losses, streak: l.streak, bestStreak: l.bestStreak, delta: l.ap - oldAp, bonus: 0, base: -LOSE_AP };
      }
      return { winner, loser };
    },
  };
}

function pgBackend(pool) {
  const COLS = 'name, ap, wins, losses, streak, best_streak';
  const shape = (r) => ({ name: r.name, ap: r.ap, wins: r.wins, losses: r.losses, streak: r.streak, bestStreak: r.best_streak });

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
    async profile(key) {
      const r = await pool.query(`SELECT ${COLS} FROM players WHERE pwhash = $1`, [key]);
      if (!r.rows.length) return null;
      const me = shape(r.rows[0]);
      const rk = await pool.query('SELECT count(*)::int + 1 AS rank FROM players WHERE ap > $1', [me.ap]);
      me.rank = rk.rows[0].rank;
      return me;
    },
    async leaderboard(limit) {
      const r = await pool.query(
        'SELECT name, ap, wins, losses FROM players ORDER BY ap DESC, wins DESC, name ASC LIMIT $1',
        [limit]
      );
      return r.rows.map((x) => ({ name: x.name, ap: x.ap, wins: x.wins, losses: x.losses }));
    },
    async applyResult(winnerKey, loserKey) {
      const wc = await pool.query('SELECT ap, streak, best_streak FROM players WHERE pwhash = $1', [winnerKey]);
      const lc = await pool.query('SELECT ap FROM players WHERE pwhash = $1', [loserKey]);

      let winner = null, loser = null;
      if (wc.rows.length) {
        const oldAp = wc.rows[0].ap;
        const newStreak = wc.rows[0].streak + 1;
        const bestStreak = Math.max(wc.rows[0].best_streak, newStreak);
        const bonus = streakBonus(newStreak);
        const gain = WIN_AP + bonus;
        const w = await pool.query(
          `UPDATE players SET ap = ap + $2, wins = wins + 1, streak = $3, best_streak = $4, updated_at = now()
           WHERE pwhash = $1 RETURNING ${COLS}`,
          [winnerKey, gain, newStreak, bestStreak]
        );
        winner = { ...shape(w.rows[0]), delta: w.rows[0].ap - oldAp, bonus, base: WIN_AP };
      }
      if (lc.rows.length) {
        const oldAp = lc.rows[0].ap;
        const l = await pool.query(
          `UPDATE players SET ap = GREATEST(0, ap - $2), losses = losses + 1, streak = 0, updated_at = now()
           WHERE pwhash = $1 RETURNING ${COLS}`,
          [loserKey, LOSE_AP]
        );
        loser = { ...shape(l.rows[0]), delta: l.rows[0].ap - oldAp, bonus: 0, base: -LOSE_AP };
      }
      return { winner, loser };
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
        streak      INTEGER NOT NULL DEFAULT 0,
        best_streak INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // migrations for tables created before these columns existed
    await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS streak INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS best_streak INTEGER NOT NULL DEFAULT 0');
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
  profile: (key) => backend.profile(key),
  leaderboard: (limit) => backend.leaderboard(limit),
  applyResult: (winnerKey, loserKey) => backend.applyResult(winnerKey, loserKey),
  hashPw,
  cleanName,
  START_AP,
  WIN_AP,
  LOSE_AP,
};
