'use strict';

// ===== Game constants (the server is the single source of truth) =====
const FIELD = { width: 800, height: 400 };
const GROUND_Y = 340;                 // y of the floor (player feet rest here)
const PLAYER = { w: 48, h: 72 };
const MAX_HP = 100;
const MAX_METER = 100;                // full meter => can fire a special

const MOVE_SPEED = 4.2;               // horizontal walk speed (px / tick)
const GRAVITY = 0.9;                  // downward accel (px / tick^2)
const JUMP_V = -15;                   // initial jump velocity
const FRICTION = 0.8;                 // horizontal damping when busy / airborne

// Melee attacks. total = windup + active + recovery (in ticks).
// meterStart = gauge gained just for swinging; meterHit = bonus on connect.
const ATTACKS = {
  punch: {
    windup: 3, active: 5, recovery: 9,
    reach: 40, hitH: 50, yOff: 12,
    damage: 9, knockback: 3, hitstun: 14,
    meterStart: 4, meterHit: 10,
  },
  kick: {
    windup: 5, active: 6, recovery: 15,
    reach: 56, hitH: 44, yOff: 30,         // lands lower & reaches further
    damage: 15, knockback: 6, hitstun: 19,
    meterStart: 6, meterHit: 16,
  },
};

// Special move: a projectile ("energy ball"). Costs a full meter.
const SPECIAL = { windup: 12, recovery: 22, releaseAt: 12 };
const PROJECTILE = {
  speed: 7.5, w: 30, h: 30, yOff: 22,
  damage: 22, knockback: 8, hitstun: 22,
  blockChip: 6,                            // chip damage even when guarded
};

const GUARD = {
  meterGain: 5,                            // defender builds a little when blocking
  meleeStun: 8,                            // blockstun on a guarded melee hit
  specialStun: 13,
  pushback: 0.4,                           // fraction of knockback applied when blocking
};
const HIT_METER = 6;                       // gauge the victim gains when actually hit

const ROUND_OVER_DELAY = 90;

function clampMeter(v) { return Math.max(0, Math.min(MAX_METER, v)); }

function makePlayer(side) {
  const startX = side === 'left' ? FIELD.width * 0.25 : FIELD.width * 0.75 - PLAYER.w;
  return {
    side,
    x: startX,
    y: GROUND_Y - PLAYER.h,
    vx: 0,
    vy: 0,
    onGround: true,
    facing: side === 'left' ? 1 : -1,      // 1 = facing right, -1 = facing left
    hp: MAX_HP,
    meter: 0,
    action: null,                          // { kind:'punch'|'kick'|'special', frame, hasHit }
    guarding: false,
    hitstun: 0,
    input: { left: false, right: false, up: false, punch: false, kick: false, guard: false, special: false },
  };
}

class Game {
  constructor() {
    this.players = { left: makePlayer('left'), right: makePlayer('right') };
    this.projectiles = [];                 // { owner:'left'|'right', x, y, vx }
    this.status = 'playing';               // 'playing' | 'finished'
    this.winner = null;                    // 'left' | 'right' | 'draw'
    this.tick = 0;
    this.overTimer = 0;
  }

  setInput(side, input) {
    const p = this.players[side];
    if (!p) return;
    p.input = {
      left: !!input.left,
      right: !!input.right,
      up: !!input.up,
      punch: !!input.punch,
      kick: !!input.kick,
      guard: !!input.guard,
      special: !!input.special,
    };
  }

  step() {
    this.tick++;

    if (this.status === 'finished') {
      for (const side of ['left', 'right']) this._physics(this.players[side]);
      if (this.overTimer > 0) this.overTimer--;
      return;
    }

    const left = this.players.left;
    const right = this.players.right;

    this._updateFacing(left, right);
    this._updateFacing(right, left);

    this._control(left);
    this._control(right);

    this._physics(left);
    this._physics(right);

    this._separate(left, right);

    this._resolveAction(left, right);
    this._resolveAction(right, left);

    this._updateProjectiles();

    if (left.hp <= 0 || right.hp <= 0) {
      this.status = 'finished';
      this.overTimer = ROUND_OVER_DELAY;
      if (left.hp <= 0 && right.hp <= 0) this.winner = 'draw';
      else if (left.hp <= 0) this.winner = 'right';
      else this.winner = 'left';
    }
  }

  _updateFacing(p, foe) {
    if (p.action) return;                  // don't flip mid-attack
    const pc = p.x + PLAYER.w / 2;
    const fc = foe.x + PLAYER.w / 2;
    p.facing = fc >= pc ? 1 : -1;
  }

  _control(p) {
    p.guarding = false;
    const busy = p.hitstun > 0 || p.action;

    if (busy) {
      if (p.onGround) p.vx *= FRICTION;
      return;
    }

    // guard: only on the ground; locks the player in place
    if (p.input.guard && p.onGround) {
      p.guarding = true;
      p.vx *= FRICTION;
      return;
    }

    // movement
    let move = 0;
    if (p.input.left) move -= 1;
    if (p.input.right) move += 1;
    p.vx = move * MOVE_SPEED;

    // jump
    if (p.input.up && p.onGround) {
      p.vy = JUMP_V;
      p.onGround = false;
    }

    // attacks: special > kick > punch
    if (p.input.special && p.meter >= MAX_METER && p.onGround) {
      p.meter = 0;
      p.action = { kind: 'special', frame: 1, hasHit: false };
      p.vx = 0;                            // plant while casting
    } else if (p.input.kick) {
      p.action = { kind: 'kick', frame: 1, hasHit: false };
      p.meter = clampMeter(p.meter + ATTACKS.kick.meterStart);
    } else if (p.input.punch) {
      p.action = { kind: 'punch', frame: 1, hasHit: false };
      p.meter = clampMeter(p.meter + ATTACKS.punch.meterStart);
    }
  }

  _physics(p) {
    p.vy += GRAVITY;
    p.x += p.vx;
    p.y += p.vy;

    const feet = p.y + PLAYER.h;
    if (feet >= GROUND_Y) {
      p.y = GROUND_Y - PLAYER.h;
      p.vy = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    if (p.x < 0) { p.x = 0; if (p.vx < 0) p.vx = 0; }
    if (p.x + PLAYER.w > FIELD.width) { p.x = FIELD.width - PLAYER.w; if (p.vx > 0) p.vx = 0; }

    if (p.hitstun > 0) p.hitstun--;
  }

  _separate(a, b) {
    const vOverlap = a.y < b.y + PLAYER.h && a.y + PLAYER.h > b.y;
    if (!vOverlap) return;
    const ac = a.x + PLAYER.w / 2;
    const bc = b.x + PLAYER.w / 2;
    const overlapX = PLAYER.w - Math.abs(ac - bc);
    if (overlapX <= 0) return;
    const half = overlapX / 2;
    if (ac <= bc) { a.x -= half; b.x += half; }
    else { a.x += half; b.x -= half; }
    a.x = Math.max(0, Math.min(FIELD.width - PLAYER.w, a.x));
    b.x = Math.max(0, Math.min(FIELD.width - PLAYER.w, b.x));
  }

  _resolveAction(attacker, victim) {
    const act = attacker.action;
    if (!act) return;

    if (act.kind === 'special') {
      if (act.frame === SPECIAL.releaseAt) this._spawnProjectile(attacker);
      act.frame++;
      if (act.frame > SPECIAL.windup + SPECIAL.recovery) attacker.action = null;
      return;
    }

    const A = ATTACKS[act.kind];
    const total = A.windup + A.active + A.recovery;
    const active = act.frame > A.windup && act.frame <= A.windup + A.active;

    if (active && !act.hasHit) {
      const box = this._meleeBox(attacker, A);
      if (this._overlaps(box, this._bodyBox(victim))) {
        act.hasHit = true;
        this._applyHit(attacker, victim, {
          dmg: A.damage, kb: A.knockback, stun: A.hitstun,
          meterHit: A.meterHit, dir: attacker.facing, srcCx: attacker.x + PLAYER.w / 2,
          isSpecial: false,
        });
      }
    }

    act.frame++;
    if (act.frame > total) attacker.action = null;
  }

  _spawnProjectile(p) {
    const y = p.y + PROJECTILE.yOff;
    const x = p.facing === 1 ? p.x + PLAYER.w : p.x - PROJECTILE.w;
    this.projectiles.push({ owner: p.side, x, y, vx: p.facing * PROJECTILE.speed });
  }

  _updateProjectiles() {
    const remove = new Set();

    for (let i = 0; i < this.projectiles.length; i++) {
      const pr = this.projectiles[i];
      pr.x += pr.vx;

      if (pr.x < -60 || pr.x > FIELD.width + 60) { remove.add(i); continue; }

      const foe = this.players[pr.owner === 'left' ? 'right' : 'left'];
      const owner = this.players[pr.owner];
      const box = { x: pr.x, y: pr.y, w: PROJECTILE.w, h: PROJECTILE.h };
      if (this._overlaps(box, this._bodyBox(foe))) {
        this._applyHit(owner, foe, {
          dmg: PROJECTILE.damage, kb: PROJECTILE.knockback, stun: PROJECTILE.hitstun,
          meterHit: 0, dir: Math.sign(pr.vx), srcCx: pr.x + PROJECTILE.w / 2,
          isSpecial: true,
        });
        remove.add(i);
      }
    }

    // opposing projectiles cancel each other out
    for (let i = 0; i < this.projectiles.length; i++) {
      for (let j = i + 1; j < this.projectiles.length; j++) {
        const a = this.projectiles[i], b = this.projectiles[j];
        if (a.owner === b.owner) continue;
        const ba = { x: a.x, y: a.y, w: PROJECTILE.w, h: PROJECTILE.h };
        const bb = { x: b.x, y: b.y, w: PROJECTILE.w, h: PROJECTILE.h };
        if (this._overlaps(ba, bb)) { remove.add(i); remove.add(j); }
      }
    }

    if (remove.size) {
      this.projectiles = this.projectiles.filter((_, i) => !remove.has(i));
    }
  }

  // opts: { dmg, kb, stun, meterHit, dir, srcCx, isSpecial }
  _applyHit(attacker, victim, opts) {
    attacker.meter = clampMeter(attacker.meter + opts.meterHit);

    // block only counts if the victim is guarding and the hit comes from the front
    const vc = victim.x + PLAYER.w / 2;
    const fromFront = Math.sign(opts.srcCx - vc) === victim.facing;
    const blocking = victim.guarding && victim.onGround && fromFront;

    if (blocking) {
      const chip = opts.isSpecial ? PROJECTILE.blockChip : 0;
      victim.hp = Math.max(0, victim.hp - chip);
      victim.hitstun = opts.isSpecial ? GUARD.specialStun : GUARD.meleeStun;
      victim.vx = opts.dir * opts.kb * GUARD.pushback;
      victim.meter = clampMeter(victim.meter + GUARD.meterGain);
    } else {
      victim.hp = Math.max(0, victim.hp - opts.dmg);
      victim.hitstun = opts.stun;
      victim.vx = opts.dir * opts.kb;
      victim.meter = clampMeter(victim.meter + HIT_METER);
      // interrupt the victim's attack if it hadn't reached its active frames
      if (victim.action && victim.action.kind !== 'special') {
        const VA = ATTACKS[victim.action.kind];
        if (victim.action.frame <= VA.windup) victim.action = null;
      }
    }
  }

  _meleeBox(p, A) {
    const top = p.y + A.yOff;
    if (p.facing === 1) return { x: p.x + PLAYER.w, y: top, w: A.reach, h: A.hitH };
    return { x: p.x - A.reach, y: top, w: A.reach, h: A.hitH };
  }

  _bodyBox(p) { return { x: p.x, y: p.y, w: PLAYER.w, h: PLAYER.h }; }

  _overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  getState() {
    const snap = (p) => {
      let ak = 0, ap = 0;
      if (p.action) {
        if (p.action.kind === 'punch') ak = 1;
        else if (p.action.kind === 'kick') ak = 2;
        else ak = 3;
        if (p.action.kind === 'special') {
          ap = p.action.frame < SPECIAL.releaseAt ? 1 : (p.action.frame === SPECIAL.releaseAt ? 2 : 3);
        } else {
          const A = ATTACKS[p.action.kind];
          ap = p.action.frame <= A.windup ? 1
             : p.action.frame <= A.windup + A.active ? 2 : 3;
        }
      }
      return {
        x: Math.round(p.x),
        y: Math.round(p.y),
        f: p.facing,
        hp: p.hp,
        mp: Math.round(p.meter),
        g: p.guarding ? 1 : 0,
        s: p.hitstun > 0 ? 1 : 0,
        ak,
        ap,
      };
    };

    return {
      t: this.tick,
      status: this.status,
      winner: this.winner,
      left: snap(this.players.left),
      right: snap(this.players.right),
      pr: this.projectiles.map((p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
        d: Math.sign(p.vx),
      })),
    };
  }
}

module.exports = { Game, FIELD, GROUND_Y, PLAYER, MAX_HP, MAX_METER };
