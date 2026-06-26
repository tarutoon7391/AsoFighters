'use strict';

// ===== Game constants (the server is the single source of truth) =====
const FIELD = { width: 800, height: 400 };
const GROUND_Y = 340;                 // y of the floor (player feet rest here)
const PLAYER = { w: 48, h: 72 };
const MAX_HP = 100;

const MOVE_SPEED = 4.2;               // horizontal walk speed (px / tick)
const GRAVITY = 0.9;                  // downward accel (px / tick^2)
const JUMP_V = -15;                   // initial jump velocity
const FRICTION = 0.8;                 // horizontal damping when no input / airborne knockback

// Punch timeline (in ticks). total = windup + active + recovery
const PUNCH = {
  windup: 3,
  active: 5,
  recovery: 9,
  reach: 40,                          // how far the fist extends in front
  hitH: 50,                           // vertical size of the hitbox
  damage: 9,
  knockback: 3,                       // < MOVE_SPEED so the attacker can keep pressure
  hitstun: 14,                        // ticks the victim is stunned
};
const PUNCH_TOTAL = PUNCH.windup + PUNCH.active + PUNCH.recovery;

const ROUND_OVER_DELAY = 90;          // ticks to keep showing the field after a KO

function makePlayer(side) {
  const startX = side === 'left' ? FIELD.width * 0.25 : FIELD.width * 0.75 - PLAYER.w;
  return {
    side,
    x: startX,
    y: GROUND_Y - PLAYER.h,
    vx: 0,
    vy: 0,
    onGround: true,
    facing: side === 'left' ? 1 : -1, // 1 = facing right, -1 = facing left
    hp: MAX_HP,
    attack: 0,                        // counts UP from 1..PUNCH_TOTAL while punching; 0 = not attacking
    hasHit: false,                    // current punch already connected?
    hitstun: 0,
    input: { left: false, right: false, up: false, punch: false },
  };
}

class Game {
  constructor() {
    this.players = { left: makePlayer('left'), right: makePlayer('right') };
    this.status = 'playing';          // 'playing' | 'finished'
    this.winner = null;               // 'left' | 'right' | 'draw'
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
    };
  }

  // advance the simulation by one tick
  step() {
    this.tick++;

    if (this.status === 'finished') {
      // let players fall / settle, then stop
      for (const side of ['left', 'right']) this._physics(this.players[side]);
      if (this.overTimer > 0) this.overTimer--;
      return;
    }

    const left = this.players.left;
    const right = this.players.right;

    // face each other based on current positions
    this._updateFacing(left, right);
    this._updateFacing(right, left);

    // resolve intentions (move / jump / start punch)
    this._control(left);
    this._control(right);

    // physics integration
    this._physics(left);
    this._physics(right);

    // keep fighters from overlapping (simple horizontal push-apart)
    this._separate(left, right);

    // advance punches and resolve hits
    this._resolveAttack(left, right);
    this._resolveAttack(right, left);

    // KO check
    if (left.hp <= 0 || right.hp <= 0) {
      this.status = 'finished';
      this.overTimer = ROUND_OVER_DELAY;
      if (left.hp <= 0 && right.hp <= 0) this.winner = 'draw';
      else if (left.hp <= 0) this.winner = 'right';
      else this.winner = 'left';
    }
  }

  _updateFacing(p, foe) {
    // don't flip mid-punch (feels bad); otherwise face the opponent
    if (p.attack > 0) return;
    const pc = p.x + PLAYER.w / 2;
    const fc = foe.x + PLAYER.w / 2;
    p.facing = fc >= pc ? 1 : -1;
  }

  _control(p) {
    const busy = p.hitstun > 0 || p.attack > 0;

    if (!busy) {
      // horizontal movement
      let move = 0;
      if (p.input.left) move -= 1;
      if (p.input.right) move += 1;
      p.vx = move * MOVE_SPEED;

      // jump
      if (p.input.up && p.onGround) {
        p.vy = JUMP_V;
        p.onGround = false;
      }

      // start a punch. We keep the current vx (set just above from movement
      // input) so that walking forward + punch becomes a small lunge, while a
      // standing punch (no movement input) stays in place. This lets the
      // attacker keep pace with the knockback they deal and pressure the foe.
      if (p.input.punch) {
        p.attack = 1;
        p.hasHit = false;
      }
    } else {
      // while busy we don't accept walk input; bleed off horizontal speed
      if (p.onGround) p.vx *= FRICTION;
    }
  }

  _physics(p) {
    // gravity
    p.vy += GRAVITY;
    p.x += p.vx;
    p.y += p.vy;

    // floor
    const feet = p.y + PLAYER.h;
    if (feet >= GROUND_Y) {
      p.y = GROUND_Y - PLAYER.h;
      p.vy = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    // walls
    if (p.x < 0) { p.x = 0; if (p.vx < 0) p.vx = 0; }
    if (p.x + PLAYER.w > FIELD.width) { p.x = FIELD.width - PLAYER.w; if (p.vx > 0) p.vx = 0; }

    // tick down stun
    if (p.hitstun > 0) p.hitstun--;
  }

  _separate(a, b) {
    // need vertical overlap for the bodies to collide at all
    const vOverlap = a.y < b.y + PLAYER.h && a.y + PLAYER.h > b.y;
    if (!vOverlap) return;
    const ac = a.x + PLAYER.w / 2;
    const bc = b.x + PLAYER.w / 2;
    const overlapX = PLAYER.w - Math.abs(ac - bc); // >0 means the boxes overlap horizontally
    if (overlapX <= 0) return;
    const half = overlapX / 2;
    if (ac <= bc) { a.x -= half; b.x += half; }
    else { a.x += half; b.x -= half; }
    // clamp back inside the field
    a.x = Math.max(0, Math.min(FIELD.width - PLAYER.w, a.x));
    b.x = Math.max(0, Math.min(FIELD.width - PLAYER.w, b.x));
  }

  _resolveAttack(attacker, victim) {
    if (attacker.attack === 0) return;

    // is the punch in its active window right now?
    const phase = attacker.attack;
    const active =
      phase > PUNCH.windup && phase <= PUNCH.windup + PUNCH.active;

    if (active && !attacker.hasHit) {
      const box = this._punchBox(attacker);
      if (this._overlaps(box, this._bodyBox(victim))) {
        attacker.hasHit = true;
        victim.hp = Math.max(0, victim.hp - PUNCH.damage);
        victim.hitstun = PUNCH.hitstun;
        victim.vx = attacker.facing * PUNCH.knockback; // knock away
        if (victim.attack > 0 && victim.attack <= PUNCH.windup) {
          victim.attack = 0; // interrupt a punch that hadn't become active yet
        }
      }
    }

    // advance / end the punch
    attacker.attack++;
    if (attacker.attack > PUNCH_TOTAL) {
      attacker.attack = 0;
      attacker.hasHit = false;
    }
  }

  _punchBox(p) {
    const fistTop = p.y + 12;
    if (p.facing === 1) {
      return { x: p.x + PLAYER.w, y: fistTop, w: PUNCH.reach, h: PUNCH.hitH };
    }
    return { x: p.x - PUNCH.reach, y: fistTop, w: PUNCH.reach, h: PUNCH.hitH };
  }

  _bodyBox(p) {
    return { x: p.x, y: p.y, w: PLAYER.w, h: PLAYER.h };
  }

  _overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // compact snapshot for the network
  getState() {
    const snap = (p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
      f: p.facing,
      hp: p.hp,
      // attack phase: 0 none, 1 windup, 2 active, 3 recovery (so the client can draw the fist)
      a:
        p.attack === 0
          ? 0
          : p.attack <= PUNCH.windup
          ? 1
          : p.attack <= PUNCH.windup + PUNCH.active
          ? 2
          : 3,
      s: p.hitstun > 0 ? 1 : 0,
    });
    return {
      t: this.tick,
      status: this.status,
      winner: this.winner,
      left: snap(this.players.left),
      right: snap(this.players.right),
    };
  }
}

module.exports = { Game, FIELD, GROUND_Y, PLAYER, MAX_HP };
