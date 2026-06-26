'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, FIELD, GROUND_Y, PLAYER, MAX_HP, MAX_METER } = require('./game');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const TICK_MS = 1000 / 60;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== Matchmaking =====
let waiting = null;
const rooms = new Set();
let roomSeq = 0;

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function makeRoom(wsA, wsB) {
  const id = ++roomSeq;
  const game = new Game();
  const room = { id, game, sockets: { left: wsA, right: wsB }, loop: null, settled: false };
  rooms.add(room);

  wsA.room = room; wsA.side = 'left';
  wsB.room = room; wsB.side = 'right';

  const config = { field: FIELD, groundY: GROUND_Y, player: PLAYER, maxHp: MAX_HP, maxMeter: MAX_METER };
  const players = {
    left: { name: wsA.account.name, ap: wsA.account.ap },
    right: { name: wsB.account.name, ap: wsB.account.ap },
  };
  send(wsA, { type: 'matched', side: 'left', config, players });
  send(wsB, { type: 'matched', side: 'right', config, players });

  let endCountdown = -1;
  room.loop = setInterval(() => {
    game.step();
    const state = game.getState();
    send(room.sockets.left, { type: 'state', state });
    send(room.sockets.right, { type: 'state', state });

    if (game.status === 'finished') {
      if (!room.settled) { room.settled = true; settleMatch(room); }
      if (endCountdown < 0) endCountdown = 150;
      if (--endCountdown <= 0) closeRoom(room, null);
    }
  }, TICK_MS);

  console.log(`[room ${id}] ${players.left.name} vs ${players.right.name}`);
}

// Apply AP changes once a match is decided, then tell each client their own
// result (AP delta, streak bonus, updated stats) plus a fresh leaderboard.
async function settleMatch(room) {
  const winSide = room.game.winner;
  const left = room.sockets.left;
  const right = room.sockets.right;

  try {
    if (winSide === 'left' || winSide === 'right') {
      const winner = room.sockets[winSide];
      const loser = room.sockets[winSide === 'left' ? 'right' : 'left'];
      const res = await db.applyResult(winner.account.key, loser.account.key);
      if (res.winner) winner.account.ap = res.winner.ap;
      if (res.loser) loser.account.ap = res.loser.ap;
      const board = await db.leaderboard(10);
      send(winner, { type: 'matchEnd', result: 'win', you: res.winner, leaderboard: board });
      send(loser, { type: 'matchEnd', result: 'lose', you: res.loser, leaderboard: board });
    } else {
      // draw: no AP / streak change — just hand back current stats
      const board = await db.leaderboard(10);
      const meL = await db.profile(left.account.key);
      const meR = await db.profile(right.account.key);
      send(left, { type: 'matchEnd', result: 'draw', you: drawStats(meL), leaderboard: board });
      send(right, { type: 'matchEnd', result: 'draw', you: drawStats(meR), leaderboard: board });
    }
  } catch (e) {
    console.error('[db] settleMatch failed:', e.message);
  }
}

function drawStats(me) {
  if (!me) return null;
  return { ap: me.ap, wins: me.wins, losses: me.losses, streak: me.streak, bestStreak: me.bestStreak, delta: 0, bonus: 0, base: 0 };
}

// Send a player their profile card data plus the current leaderboard.
async function sendProfile(ws) {
  if (!ws.account) return;
  try {
    const me = await db.profile(ws.account.key);
    const board = await db.leaderboard(10);
    if (me) ws.account.ap = me.ap;
    send(ws, { type: 'profile', me, leaderboard: board });
  } catch (e) {
    console.error('[db] sendProfile failed:', e.message);
  }
}

function closeRoom(room, reasonForSurvivor) {
  if (!rooms.has(room)) return;
  rooms.delete(room);
  if (room.loop) clearInterval(room.loop);
  for (const side of ['left', 'right']) {
    const ws = room.sockets[side];
    if (ws) {
      if (reasonForSurvivor) send(ws, { type: 'opponentLeft' });
      ws.room = null;
    }
  }
  console.log(`[room ${room.id}] closed`);
}

function enqueue(ws) {
  if (waiting && waiting.readyState === waiting.OPEN) {
    const opponent = waiting;
    waiting = null;
    makeRoom(opponent, ws);
  } else {
    waiting = ws;
    send(ws, { type: 'waiting' });
  }
}

// ===== Connections =====
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.account = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'login') {
      if (ws.account || ws.room) return;            // already in
      const password = typeof msg.password === 'string' ? msg.password : '';
      if (!password) { send(ws, { type: 'loginError', error: 'パスワードを入力してください' }); return; }
      try {
        const acc = await db.login(msg.name, password);
        ws.account = acc;
        send(ws, { type: 'loggedIn', name: acc.name, ap: acc.ap });
        await sendProfile(ws);                       // -> show the profile screen (no auto-queue)
      } catch (e) {
        console.error('[login] failed:', e.message);
        send(ws, { type: 'loginError', error: 'ログインに失敗しました' });
      }
      return;
    }

    if (msg.type === 'queue') {
      if (ws.account && !ws.room && waiting !== ws) enqueue(ws);
      return;
    }

    if (msg.type === 'profile') {
      if (ws.account && !ws.room) {
        if (waiting === ws) waiting = null;          // leaving the queue back to profile
        await sendProfile(ws);
      }
      return;
    }

    if (msg.type === 'input' && ws.room && ws.side && ws.account) {
      ws.room.game.setInput(ws.side, msg.input || {});
    }
  });

  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.room) closeRoom(ws.room, 'opponentLeft');
  });

  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

db.init()
  .catch((e) => console.error('[db] init failed (continuing):', e.message))
  .finally(() => {
    server.listen(PORT, () => console.log(`AsoFighters server listening on http://localhost:${PORT}`));
  });
