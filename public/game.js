'use strict';

// ===== DOM =====
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const overlaySub = document.getElementById('overlay-sub');
const roleEl = document.getElementById('role');

// ===== Networking state =====
let ws = null;
let mySide = null;          // 'left' | 'right'
let cfg = null;             // { field, groundY, player, maxHp }
let latest = null;          // most recent state snapshot from the server
let connected = false;

const COLORS = {
  left: '#4ea1ff',
  right: '#ff5d73',
  leftDark: '#2c5e99',
  rightDark: '#99384a',
};

function showOverlay(text, sub) {
  overlayText.textContent = text;
  overlaySub.textContent = sub || '';
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

// ===== Connect =====
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => { connected = true; };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'waiting':
        showOverlay('対戦相手を探しています…', 'もう一つのタブ／別端末で開くとマッチします');
        roleEl.textContent = '';
        roleEl.className = 'role';
        break;

      case 'matched':
        mySide = msg.side;
        cfg = msg.config;
        canvas.width = cfg.field.width;
        canvas.height = cfg.field.height;
        roleEl.textContent = mySide === 'left' ? 'あなた：左（青）' : 'あなた：右（赤）';
        roleEl.className = 'role ' + mySide;
        hideOverlay();
        break;

      case 'state':
        latest = msg.state;
        if (latest.status === 'finished') showResult(latest);
        else hideOverlay();
        break;

      case 'opponentLeft':
        showOverlay('相手が退出しました', 'リロードで再マッチ');
        break;
    }
  };

  ws.onclose = () => {
    connected = false;
    showOverlay('切断されました', 'リロードで再接続');
  };
  ws.onerror = () => { /* onclose will follow */ };
}

function showResult(state) {
  let text, cls;
  if (state.winner === 'draw') { text = 'DRAW'; cls = ''; }
  else if (state.winner === mySide) { text = 'YOU WIN!'; cls = ''; }
  else { text = 'YOU LOSE'; cls = ''; }
  overlayText.style.color = state.winner === mySide ? '#7CFC9B' : '#ff8fa0';
  showOverlay(text, 'リロード（F5）で再戦');
}

// ===== Input =====
const input = { left: false, right: false, up: false, punch: false };
let lastSent = '';

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', Space: 'up',
  KeyJ: 'punch', KeyF: 'punch', KeyK: 'punch',
};

function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = JSON.stringify(input);
  if (payload === lastSent) return;
  lastSent = payload;
  ws.send(JSON.stringify({ type: 'input', input }));
}

window.addEventListener('keydown', (e) => {
  const action = KEYMAP[e.code];
  if (!action) return;
  e.preventDefault();
  if (!input[action]) { input[action] = true; sendInput(); }
});
window.addEventListener('keyup', (e) => {
  const action = KEYMAP[e.code];
  if (!action) return;
  e.preventDefault();
  if (input[action]) { input[action] = false; sendInput(); }
});
// drop all inputs if the tab loses focus (avoids "stuck" movement)
window.addEventListener('blur', () => {
  let changed = false;
  for (const k of Object.keys(input)) if (input[k]) { input[k] = false; changed = true; }
  if (changed) sendInput();
});

// ===== Rendering =====
function draw() {
  requestAnimationFrame(draw);
  if (!cfg) return;

  const W = cfg.field.width;
  const H = cfg.field.height;
  const groundY = cfg.groundY;

  // background
  ctx.clearRect(0, 0, W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, '#0b0e14');
  sky.addColorStop(1, '#161d2c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, groundY);
  // ground
  ctx.fillStyle = '#222b3d';
  ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = '#2f3a52';
  ctx.fillRect(0, groundY, W, 4);

  if (!latest) return;

  drawFighter(latest.left, 'left');
  drawFighter(latest.right, 'right');

  drawHpBar(latest.left.hp, 'left');
  drawHpBar(latest.right.hp, 'right');
}

function drawFighter(p, side) {
  const PW = cfg.player.w;
  const PH = cfg.player.h;
  const x = p.x;
  const y = p.y;
  const base = COLORS[side];
  const dark = side === 'left' ? COLORS.leftDark : COLORS.rightDark;

  // hitstun flash
  const flashing = p.s === 1 && (latest.t % 6 < 3);

  // torso
  ctx.fillStyle = flashing ? '#ffffff' : base;
  roundRect(x, y + PH * 0.28, PW, PH * 0.72, 8);
  ctx.fill();

  // head
  const headR = PW * 0.34;
  const headCx = x + PW / 2;
  const headCy = y + PH * 0.2;
  ctx.fillStyle = flashing ? '#ffffff' : dark;
  ctx.beginPath();
  ctx.arc(headCx, headCy, headR, 0, Math.PI * 2);
  ctx.fill();

  // facing eye
  ctx.fillStyle = '#0b0e14';
  ctx.beginPath();
  ctx.arc(headCx + p.f * headR * 0.4, headCy, headR * 0.22, 0, Math.PI * 2);
  ctx.fill();

  // punching arm + fist
  if (p.a > 0) {
    const reach = p.a === 1 ? cfg.player.w * 0.3 : cfg.player.w * 0.85; // extends on active
    const armY = y + PH * 0.42;
    const startX = p.f === 1 ? x + PW : x;
    const fistX = startX + p.f * reach;
    ctx.strokeStyle = base;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(startX, armY);
    ctx.lineTo(fistX, armY);
    ctx.stroke();
    ctx.fillStyle = p.a === 2 ? '#ffd24a' : base; // fist glows during active frames
    ctx.beginPath();
    ctx.arc(fistX, armY, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  // "YOU" tag
  if (side === mySide) {
    ctx.fillStyle = '#e8edf4';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', headCx, y - 6);
  }
}

function drawHpBar(hp, side) {
  const W = cfg.field.width;
  const maxHp = cfg.maxHp;
  const barW = W * 0.4;
  const barH = 20;
  const pad = 20;
  const y = 16;
  const x = side === 'left' ? pad : W - pad - barW;
  const frac = Math.max(0, hp / maxHp);

  // frame
  ctx.fillStyle = '#0b0e14';
  ctx.strokeStyle = '#2a3346';
  ctx.lineWidth = 2;
  roundRect(x, y, barW, barH, 5); ctx.fill(); ctx.stroke();

  // fill (left bar drains right-to-left feel: anchor on outer edge)
  const fillW = barW * frac;
  const fx = side === 'left' ? x : x + (barW - fillW);
  ctx.fillStyle = side === 'left' ? COLORS.left : COLORS.right;
  roundRect(fx, y, fillW, barH, 5); ctx.fill();

  ctx.fillStyle = '#e8edf4';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = side === 'left' ? 'left' : 'right';
  ctx.fillText(`${Math.ceil(hp)} HP`, side === 'left' ? x + 2 : x + barW - 2, y + barH + 14);
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ===== Boot =====
showOverlay('接続中…', '');
connect();
requestAnimationFrame(draw);
