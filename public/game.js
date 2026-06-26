'use strict';

// ===== DOM =====
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const helpEl = document.getElementById('help');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlay-text');
const overlaySub = document.getElementById('overlay-sub');
const overlayBtn = document.getElementById('overlay-btn');

const loginEl = document.getElementById('login');
const nameInput = document.getElementById('name');
const pwInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const loginMsg = document.getElementById('loginMsg');

const profileEl = document.getElementById('profile');
const battleBtn = document.getElementById('battleBtn');
const pName = document.getElementById('p-name');
const pRank = document.getElementById('p-rank');
const pAp = document.getElementById('p-ap');
const pStats = document.getElementById('p-stats');
const pStreak = document.getElementById('p-streak');
const rankList = document.getElementById('rank-list');

// ===== State =====
let ws = null;
let mySide = null;
let cfg = null;
let meta = null;            // both players' name+ap for the in-match HUD
let latest = null;
let myProfile = null;       // { name, ap, wins, losses, streak, bestStreak, rank }
let leaderboard = [];

const COLORS = {
  left: '#4ea1ff', right: '#ff5d73',
  leftDark: '#2c5e99', rightDark: '#99384a',
  meter: '#ffd24a', kick: '#ff9f43', guard: 'rgba(120,200,255,0.85)',
};
const RANKS = [
  { name: 'Master',   min: 1000, color: '#ff7be5' },
  { name: 'Diamond',  min: 750,  color: '#7fdcff' },
  { name: 'Platinum', min: 500,  color: '#8ee6c8' },
  { name: 'Gold',     min: 300,  color: '#ffd24a' },
  { name: 'Silver',   min: 150,  color: '#cfd6e0' },
  { name: 'Bronze',   min: 0,    color: '#cd7f32' },
];
function rankFor(ap) { for (const r of RANKS) if (ap >= r.min) return r; return RANKS[RANKS.length - 1]; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showOverlay(text, sub, color, withButton) {
  overlayText.textContent = text;
  overlayText.style.color = color || '#e8edf4';
  overlaySub.innerHTML = sub || '';
  overlayBtn.classList.toggle('hidden', !withButton);
  overlay.classList.remove('hidden');
}
function hideOverlay() { overlay.classList.add('hidden'); }

// ===== Views =====
function showProfile() {
  loginEl.classList.add('hidden');
  stage.classList.add('hidden');
  helpEl.classList.add('hidden');
  hideOverlay();
  latest = null; mySide = null;
  profileEl.classList.remove('hidden');
  renderProfile();
}
function showSearching() {
  profileEl.classList.add('hidden');
  loginEl.classList.add('hidden');
  stage.classList.remove('hidden');
  helpEl.classList.remove('hidden');
  showOverlay('対戦相手を探しています…', 'もう一つのタブ／別端末でログインして<br>バトル開始するとマッチします', null, true);
}

function renderProfile() {
  if (!myProfile) return;
  const rk = rankFor(myProfile.ap);
  pName.textContent = myProfile.name;
  pRank.textContent = rk.name;
  pRank.style.color = rk.color;
  pAp.innerHTML = `<b>AP ${myProfile.ap}</b>　・　世界 #${myProfile.rank}`;
  const total = myProfile.wins + myProfile.losses;
  const rate = total ? Math.round((myProfile.wins / total) * 100) : 0;
  pStats.textContent = `戦績：${myProfile.wins}勝 ${myProfile.losses}敗（勝率 ${rate}%）`;
  pStreak.textContent = myProfile.streak > 0
    ? `🔥 現在 ${myProfile.streak}連勝中（最高 ${myProfile.bestStreak}連勝）`
    : `最高 ${myProfile.bestStreak}連勝`;

  rankList.innerHTML = '';
  leaderboard.forEach((e, i) => {
    const tier = rankFor(e.ap);
    const li = document.createElement('li');
    if (e.name === myProfile.name && e.ap === myProfile.ap) li.classList.add('me');
    li.innerHTML =
      `<span class="rk-pos">${i + 1}</span>` +
      `<span class="rk-name">${escapeHtml(e.name)}</span>` +
      `<span class="rk-tier" style="color:${tier.color}">${tier.name}</span>` +
      `<span class="rk-ap">AP ${e.ap}</span>`;
    rankList.appendChild(li);
  });
}

// ===== Login =====
function doLogin() {
  const name = nameInput.value.trim();
  const password = pwInput.value;
  if (!password) { loginMsg.textContent = 'パスワードを入力してください'; return; }
  loginBtn.disabled = true;
  loginMsg.style.color = '#9fb0c8';
  loginMsg.textContent = '接続中…';
  connect(() => ws.send(JSON.stringify({ type: 'login', name, password })));
}
loginBtn.addEventListener('click', doLogin);
pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwInput.focus(); });

battleBtn.addEventListener('click', () => {
  showSearching();
  ws.send(JSON.stringify({ type: 'queue' }));
});
overlayBtn.addEventListener('click', () => {
  hideOverlay();
  ws.send(JSON.stringify({ type: 'profile' })); // server replies 'profile' -> showProfile()
});

// ===== Connect =====
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => onOpen && onOpen();

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'loginError':
        loginBtn.disabled = false;
        loginMsg.style.color = '#ff8fa0';
        loginMsg.textContent = msg.error || 'ログインに失敗しました';
        break;

      case 'loggedIn':
        // wait for the 'profile' message to show the profile screen
        break;

      case 'profile':
        myProfile = msg.me;
        leaderboard = msg.leaderboard || [];
        showProfile();
        break;

      case 'waiting':
        // already showing the searching overlay
        break;

      case 'matched':
        mySide = msg.side;
        cfg = msg.config;
        meta = msg.players;
        canvas.width = cfg.field.width;
        canvas.height = cfg.field.height;
        hideOverlay();
        break;

      case 'state':
        latest = msg.state;
        break;

      case 'matchEnd':
        applyMatchEnd(msg);
        break;

      case 'opponentLeft':
        showOverlay('相手が退出しました', '次の対戦相手を探せます', '#e8edf4', true);
        break;
    }
  };

  ws.onclose = () => {
    if (!loginEl.classList.contains('hidden')) {
      loginBtn.disabled = false;
      loginMsg.style.color = '#ff8fa0';
      loginMsg.textContent = '接続が切れました。もう一度お試しください';
    } else {
      showOverlay('切断されました', 'リロード（F5）で再接続', '#ff8fa0', false);
    }
  };
  ws.onerror = () => {};
}

function applyMatchEnd(msg) {
  const you = msg.you || {};
  if (myProfile && you.ap != null) {
    myProfile.ap = you.ap; myProfile.wins = you.wins; myProfile.losses = you.losses;
    myProfile.streak = you.streak; myProfile.bestStreak = you.bestStreak;
  }
  if (msg.leaderboard) leaderboard = msg.leaderboard;

  let text, color;
  if (msg.result === 'win') { text = 'YOU WIN!'; color = '#7CFC9B'; }
  else if (msg.result === 'lose') { text = 'YOU LOSE'; color = '#ff8fa0'; }
  else { text = 'DRAW'; color = '#e8edf4'; }

  const newAp = you.ap, delta = you.delta || 0;
  const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
  const after = rankFor(newAp);
  const before = rankFor(newAp - delta);
  let sub = `AP ${newAp}（${deltaStr}）　ランク：<b style="color:${after.color}">${after.name}</b>`;
  if (msg.result === 'win' && you.bonus > 0) {
    sub += `<br><span style="color:#ff9f43">🔥 ${you.streak}連勝ボーナス +${you.bonus} AP</span>`;
  } else if (msg.result === 'win' && you.streak > 1) {
    sub += `<br><span style="color:#ff9f43">🔥 ${you.streak}連勝中</span>`;
  }
  if (after.name !== before.name) {
    sub += delta >= 0
      ? `<br><b style="color:${after.color}">▲ ランクアップ！</b>`
      : `<br><b style="color:#ff8fa0">▼ ランクダウン…</b>`;
  }
  showOverlay(text, sub, color, true);
}

// ===== Input =====
const input = { left: false, right: false, up: false, punch: false, kick: false, guard: false, special: false };
let lastSent = '';
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', Space: 'up',
  KeyJ: 'punch', KeyK: 'kick',
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
function gameKeysActive() { return !stage.classList.contains('hidden') && !!latest; }
window.addEventListener('keydown', (e) => {
  if (!gameKeysActive()) return;
  const a = KEYMAP[e.code];
  if (!a) return;
  e.preventDefault();
  if (!input[a]) { input[a] = true; sendInput(); }
});
window.addEventListener('keyup', (e) => {
  const a = KEYMAP[e.code];
  if (!a) return;
  e.preventDefault();
  if (input[a]) { input[a] = false; sendInput(); }
});
window.addEventListener('blur', () => {
  let changed = false;
  for (const k of Object.keys(input)) if (input[k]) { input[k] = false; changed = true; }
  if (changed) sendInput();
});

// ===== Rendering =====
function draw() {
  requestAnimationFrame(draw);
  if (!cfg || stage.classList.contains('hidden')) return;
  const W = cfg.field.width, H = cfg.field.height, groundY = cfg.groundY;

  ctx.clearRect(0, 0, W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, groundY);
  sky.addColorStop(0, '#0b0e14'); sky.addColorStop(1, '#161d2c');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, groundY);
  ctx.fillStyle = '#222b3d'; ctx.fillRect(0, groundY, W, H - groundY);
  ctx.fillStyle = '#2f3a52'; ctx.fillRect(0, groundY, W, 4);

  if (!latest) return;

  for (const pr of latest.pr || []) drawProjectile(pr);
  drawFighter(latest.left, 'left');
  drawFighter(latest.right, 'right');

  drawHud(latest.left, 'left');
  drawHud(latest.right, 'right');
  drawRoundPips();
  drawCountdown();
}

function drawFighter(p, side) {
  const PW = cfg.player.w, PH = cfg.player.h;
  const x = p.x, y = p.y;
  const base = COLORS[side];
  const dark = side === 'left' ? COLORS.leftDark : COLORS.rightDark;
  const flashing = p.s === 1 && (latest.t % 6 < 3);

  ctx.fillStyle = flashing ? '#ffffff' : base;
  roundRect(x, y + PH * 0.28, PW, PH * 0.72, 8); ctx.fill();

  const headR = PW * 0.34, headCx = x + PW / 2, headCy = y + PH * 0.2;
  ctx.fillStyle = flashing ? '#ffffff' : dark;
  ctx.beginPath(); ctx.arc(headCx, headCy, headR, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#0b0e14';
  ctx.beginPath(); ctx.arc(headCx + p.f * headR * 0.4, headCy, headR * 0.22, 0, Math.PI * 2); ctx.fill();

  if (p.ak === 1) drawLimb(p, PW, PH, base, p.ap === 2 ? 0.95 : 0.4, 0.42, '#ffd24a');
  else if (p.ak === 2) drawLimb(p, PW, PH, COLORS.kick, p.ap === 1 ? 0.45 : 1.25, 0.66, COLORS.kick, 11);
  else if (p.ak === 3) drawSpecialPose(p, PW, PH);

  if (p.g === 1) {
    const sx = p.f === 1 ? x + PW - 4 : x - 8;
    ctx.fillStyle = COLORS.guard;
    roundRect(sx, y + PH * 0.22, 12, PH * 0.74, 6); ctx.fill();
    ctx.fillStyle = 'rgba(120,200,255,0.18)';
    roundRect(x - 3, y + PH * 0.24, PW + 6, PH * 0.74, 8); ctx.fill();
  }

  if (side === mySide) {
    ctx.fillStyle = '#e8edf4';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', headCx, y - 6);
  }
}

function drawLimb(p, PW, PH, color, reachFrac, heightFrac, tipColor, tipR = 9) {
  const x = p.x, y = p.y;
  const limbY = y + PH * heightFrac;
  const startX = p.f === 1 ? x + PW : x;
  const tipX = startX + p.f * PW * reachFrac;
  ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(startX, limbY); ctx.lineTo(tipX, limbY); ctx.stroke();
  ctx.fillStyle = tipColor;
  ctx.beginPath(); ctx.arc(tipX, limbY, tipR, 0, Math.PI * 2); ctx.fill();
}

function drawSpecialPose(p, PW, PH) {
  const x = p.x, y = p.y;
  const handY = y + PH * 0.46;
  const startX = p.f === 1 ? x + PW : x;
  const tipX = startX + p.f * PW * 0.7;
  ctx.strokeStyle = '#e8edf4'; ctx.lineWidth = 9; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(startX, handY); ctx.lineTo(tipX, handY); ctx.stroke();
  const glow = ctx.createRadialGradient(tipX, handY, 2, tipX, handY, 22);
  glow.addColorStop(0, p.ap === 2 ? '#ffffff' : '#aee9ff');
  glow.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(tipX, handY, p.ap === 2 ? 26 : 18, 0, Math.PI * 2); ctx.fill();
}

function drawProjectile(pr) {
  const cx = pr.x + 15, cy = pr.y + 15, r = 16;
  const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, '#7fdcff'); g.addColorStop(1, 'rgba(60,160,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(127,220,255,0.35)';
  ctx.beginPath(); ctx.ellipse(cx - pr.d * 10, cy, 14, 6, 0, 0, Math.PI * 2); ctx.fill();
}

function drawHud(p, side) {
  const W = cfg.field.width;
  const barW = W * 0.4, pad = 18;
  const x = side === 'left' ? pad : W - pad - barW;
  const m = meta ? meta[side] : { name: side, ap: 0 };
  const rank = rankFor(m.ap);
  const align = side === 'left' ? 'left' : 'right';
  const anchor = side === 'left' ? x : x + barW;

  ctx.textAlign = align;
  ctx.fillStyle = COLORS[side];
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText(m.name, anchor, 20);

  const hpY = 28, hpH = 15;
  const hpFrac = Math.max(0, p.hp / cfg.maxHp);
  ctx.fillStyle = '#0b0e14'; ctx.strokeStyle = '#2a3346'; ctx.lineWidth = 2;
  roundRect(x, hpY, barW, hpH, 5); ctx.fill(); ctx.stroke();
  const hpW = barW * hpFrac;
  const hpFx = side === 'left' ? x : x + (barW - hpW);
  ctx.fillStyle = COLORS[side];
  roundRect(hpFx, hpY, hpW, hpH, 5); ctx.fill();

  const mY = 47, mH = 6;
  const mFrac = Math.max(0, p.mp / cfg.maxMeter);
  const full = p.mp >= cfg.maxMeter;
  ctx.fillStyle = '#0b0e14'; ctx.strokeStyle = '#2a3346';
  roundRect(x, mY, barW, mH, 3); ctx.fill(); ctx.stroke();
  const mW = barW * mFrac;
  const mFx = side === 'left' ? x : x + (barW - mW);
  ctx.fillStyle = full && (latest.t % 12 < 6) ? '#ffffff' : COLORS.meter;
  roundRect(mFx, mY, mW, mH, 3); ctx.fill();

  ctx.textAlign = align;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = rank.color;
  ctx.fillText(rank.name, anchor, 67);
  const apText = `AP ${m.ap}` + (full ? '  ★SP' : '');
  const rankW = measureBold(rank.name);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#cfd6e0';
  if (side === 'left') ctx.fillText('・ ' + apText, anchor + rankW + 6, 67);
  else ctx.fillText(apText + ' ・', anchor - rankW - 6, 67);
}
function measureBold(t) { ctx.font = 'bold 12px system-ui, sans-serif'; return ctx.measureText(t).width; }

function drawRoundPips() {
  if (!latest.roundResults) return;
  const W = cfg.field.width;
  const r = 9, gap = 26, n = 3;
  const cx0 = W / 2 - ((n - 1) * gap) / 2;
  const y = 20;
  for (let i = 0; i < n; i++) {
    const cx = cx0 + i * gap;
    const res = latest.roundResults[i];
    ctx.beginPath(); ctx.arc(cx, y, r, 0, Math.PI * 2);
    if (res === 'left') ctx.fillStyle = COLORS.left;
    else if (res === 'right') ctx.fillStyle = COLORS.right;
    else if (res === 'draw') ctx.fillStyle = '#6b7791';
    else ctx.fillStyle = '#1b2233';
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#2a3346'; ctx.stroke();
  }
}

function drawCountdown() {
  const W = cfg.field.width, H = cfg.field.height;
  if (latest.phase === 'roundover' && meta) {
    const rw = latest.roundWinner;
    const txt = rw === 'draw' ? '引き分け' : `${meta[rw].name} がラウンド取得！`;
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(txt, W / 2 + 2, H * 0.4 + 2);
    ctx.fillStyle = rw === 'left' ? COLORS.left : rw === 'right' ? COLORS.right : '#e8edf4';
    ctx.fillText(txt, W / 2, H * 0.4);
    return;
  }
  const c = latest.count;
  if (!c) return;
  ctx.textAlign = 'center';
  const isFight = c === 'FIGHT';
  ctx.font = `bold ${isFight ? 64 : 100}px system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillText(isFight ? 'FIGHT!' : c, W / 2 + 3, H * 0.44 + 3);
  ctx.fillStyle = isFight ? '#ffd24a' : '#ffffff';
  ctx.fillText(isFight ? 'FIGHT!' : c, W / 2, H * 0.44);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ===== Boot =====
requestAnimationFrame(draw);
nameInput.focus();
