'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, FIELD, GROUND_Y, PLAYER, MAX_HP, MAX_METER } = require('./game');

const PORT = process.env.PORT || 3000;
const TICK_MS = 1000 / 60; // server simulation + broadcast rate

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== Matchmaking =====
let waiting = null;          // a single socket waiting for an opponent
const rooms = new Set();
let roomSeq = 0;

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function makeRoom(wsA, wsB) {
  const id = ++roomSeq;
  const game = new Game();
  const room = { id, game, sockets: { left: wsA, right: wsB }, loop: null };
  rooms.add(room);

  wsA.room = room; wsA.side = 'left';
  wsB.room = room; wsB.side = 'right';

  const config = { field: FIELD, groundY: GROUND_Y, player: PLAYER, maxHp: MAX_HP, maxMeter: MAX_METER };
  send(wsA, { type: 'matched', side: 'left', config });
  send(wsB, { type: 'matched', side: 'right', config });

  let endCountdown = -1;
  room.loop = setInterval(() => {
    game.step();
    const state = game.getState();
    send(room.sockets.left, { type: 'state', state });
    send(room.sockets.right, { type: 'state', state });

    if (game.status === 'finished') {
      if (endCountdown < 0) endCountdown = 120;     // ~2s of post-KO frames
      if (--endCountdown <= 0) closeRoom(room, null);
    }
  }, TICK_MS);

  console.log(`[room ${id}] started`);
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
  ws.on('pong', () => { ws.isAlive = true; });

  enqueue(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'input' && ws.room && ws.side) {
      ws.room.game.setInput(ws.side, msg.input || {});
    }
  });

  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.room) closeRoom(ws.room, 'opponentLeft');
  });

  ws.on('error', () => { /* ignore; close handler does cleanup */ });
});

// keep idle connections alive through proxies (Railway) and drop dead ones
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`AsoFighters server listening on http://localhost:${PORT}`);
});
