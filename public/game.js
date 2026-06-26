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
let cfg = null;             // { field, groundY, player, maxHp, maxMeter }
let latest = null;          // most recent state snapshot from the server

const COLORS = {
  left: '#4ea1ff',
  right: '#ff5d73',
  leftDark: '#2c5e99',
  rightDark: '#99384a',
  meter: '#ffd24a',
  kick: '#ff9f43',
  guard: 'rgba(120,200,255,0.85)',
};

function showOverlay(text, sub) {
  overlayText.textContent = text;
  overlaySub.textContent = sub || '';
  overlay.classList.remove('hidden');
}
function hideOverlay() { overlay.classList.add('hidden'); }

// ===== Connect =====
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

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

  ws.onclose = () => showOverlay('切断されました', 'リロードで再接続');
  ws.onerror = () => {};
}

function showResult(state) {
  let text;
  if (state.winner === 'draw') text = 'DRAW';
  else if (state.winner === mySide) text = 'YOU WIN!';
  else text = 'YOU LOSE';
  overlayText.style.color = state.winner === mySide ? '#7CFC9B' : '#ff8fa0';
  showOverlay(text, 'リロード（F5）で再戦');
}

// ===== Input =====
const input = { left: false, right: false, up: false, punch: false, kick: false, guard: false, special: false };
let lastSent = '';

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', Space: 'up',
  KeyJ: 'punch',
  KeyK: 'kick',
  KeyL: 'guard', KeyS: 'guard',
  KeyU: 'special', KeyI: 'special',
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

  ctx.clearRect(0, 0, W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, '#0b0e14');
  sky.addColorStop(1, '#161d2c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, groundY);
  ctx.fillStyle = '#222b3d';
  ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = '#2f3a52';
  ctx.fillRect(0, groundY, W, 4);

  if (!latest) return;

  // projectiles behind fighters
  for (const pr of latest.pr || []) drawProjectile(pr);

  drawFighter(latest.left, 'left');
  drawFighter(latest.right, 'right');

  drawBars(latest.left, 'left');
  drawBars(latest.right, 'right');
}

function drawFighter(p, side) {
  const PW = cfg.player.w;
  const PH = cfg.player.h;
  const x = p.x, y = p.y;
  const base = COLORS[side];
  const dark = side === 'left' ? COLORS.leftDark : COLORS.rightDark;
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

  // eye (facing)
  ctx.fillStyle = '#0b0e14';
  ctx.beginPath();
  ctx.arc(headCx + p.f * headR * 0.4, headCy, headR * 0.22, 0, Math.PI * 2);
  ctx.fill();

  // attack limbs (ak: 1 punch, 2 kick, 3 special; ap: 1 windup, 2 active, 3 recovery)
  if (p.ak === 1) drawArm(p, PW, PH, base, p.ap === 2 ? 0.95 : 0.4, 0.42, '#ffd24a');
  else if (p.ak === 2) drawArm(p, PW, PH, COLORS.kick, p.ap === 1 ? 0.45 : 1.25, 0.66, COLORS.kick, 11);
  else if (p.ak === 3) drawSpecialPose(p, PW, PH);

  // guard shield
  if (p.g === 1) {
    const sx = p.f === 1 ? x + PW - 4 : x - 8;
    ctx.fillStyle = COLORS.guard;
    roundRect(sx, y + PH * 0.22, 12, PH * 0.74, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(120,200,255,0.18)';
    roundRect(x - 3, y + PH * 0.24, PW + 6, PH * 0.74, 8);
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

function drawArm(p, PW, PH, color, reachFrac, heightFrac, fistColor, fistR = 9) {
  const x = p.x, y = p.y;
  const limbY = y + PH * heightFrac;
  const startX = p.f === 1 ? x + PW : x;
  const tipX = startX + p.f * PW * reachFrac;
  ctx.strokeStyle = color;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(startX, limbY);
  ctx.lineTo(tipX, limbY);
  ctx.stroke();
  ctx.fillStyle = fistColor;
  ctx.beginPath();
  ctx.arc(tipX, limbY, fistR, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpecialPose(p, PW, PH) {
  const x = p.x, y = p.y;
  const handY = y + PH * 0.46;
  const startX = p.f === 1 ? x + PW : x;
  const tipX = startX + p.f * PW * 0.7;
  // both arms thrust forward
  ctx.strokeStyle = '#e8edf4';
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(startX, handY);
  ctx.lineTo(tipX, handY);
  ctx.stroke();
  // charging glow at the hands
  const glow = ctx.createRadialGradient(tipX, handY, 2, tipX, handY, 22);
  glow.addColorStop(0, p.ap === 2 ? '#ffffff' : '#aee9ff');
  glow.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(tipX, handY, p.ap === 2 ? 26 : 18, 0, Math.PI * 2);
  ctx.fill();
}

function drawProjectile(pr) {
  const cx = pr.x + 15, cy = pr.y + 15;        // server box is 30x30
  const r = 16;
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.4, '#7fdcff');
  g.addColorStop(1, 'rgba(60,160,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // small trailing streak
  ctx.fillStyle = 'rgba(127,220,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx - pr.d * 10, cy, 14, 6, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBars(p, side) {
  const W = cfg.field.width;
  const barW = W * 0.4;
  const pad = 20;
  const x = side === 'left' ? pad : W - pad - barW;

  // HP
  const hpY = 14, hpH = 18;
  const hpFrac = Math.max(0, p.hp / cfg.maxHp);
  ctx.fillStyle = '#0b0e14';
  ctx.strokeStyle = '#2a3346';
  ctx.lineWidth = 2;
  roundRect(x, hpY, barW, hpH, 5); ctx.fill(); ctx.stroke();
  const hpFillW = barW * hpFrac;
  const hpFx = side === 'left' ? x : x + (barW - hpFillW);
  ctx.fillStyle = COLORS[side];
  roundRect(hpFx, hpY, hpFillW, hpH, 5); ctx.fill();

  // Meter
  const mY = 36, mH = 8;
  const mFrac = Math.max(0, p.mp / cfg.maxMeter);
  const full = p.mp >= cfg.maxMeter;
  ctx.fillStyle = '#0b0e14';
  ctx.strokeStyle = '#2a3346';
  roundRect(x, mY, barW, mH, 4); ctx.fill(); ctx.stroke();
  const mFillW = barW * mFrac;
  const mFx = side === 'left' ? x : x + (barW - mFillW);
  ctx.fillStyle = full && (latest.t % 12 < 6) ? '#ffffff' : COLORS.meter;
  roundRect(mFx, mY, mFillW, mH, 4); ctx.fill();

  if (full) {
    ctx.fillStyle = '#ffd24a';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = side === 'left' ? 'left' : 'right';
    ctx.fillText('★ SPECIAL READY (U)', side === 'left' ? x : x + barW, mY + mH + 12);
  }
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (w <= 0) return;
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
