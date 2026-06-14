const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets/tower-defense', express.static(
  path.join(__dirname, '../kenney_tower-defense-kit/Models/GLB format')
));

// ── Constants ─────────────────────────────────────────────────────────────────

const CELL_SIZE = 2;
const GRID_SIZE = 10;
const TICK_MS   = 50;        // 20 ticks/sec
const BETWEEN_WAVE_MS = 7000; // ms between waves

// Serpentine path: right → down → left → down → right
const PATH = [
  {gx:0,gz:0},{gx:1,gz:0},{gx:2,gz:0},{gx:3,gz:0},{gx:4,gz:0},
  {gx:5,gz:0},{gx:6,gz:0},{gx:7,gz:0},{gx:8,gz:0},{gx:9,gz:0},
  {gx:9,gz:1},{gx:9,gz:2},{gx:9,gz:3},{gx:9,gz:4},
  {gx:8,gz:4},{gx:7,gz:4},{gx:6,gz:4},{gx:5,gz:4},{gx:4,gz:4},
  {gx:3,gz:4},{gx:2,gz:4},{gx:1,gz:4},
  {gx:1,gz:5},{gx:1,gz:6},{gx:1,gz:7},{gx:1,gz:8},
  {gx:2,gz:8},{gx:3,gz:8},{gx:4,gz:8},{gx:5,gz:8},{gx:6,gz:8},
  {gx:7,gz:8},{gx:8,gz:8},{gx:9,gz:8},
];

const PATH_SET   = new Set(PATH.map(p => `${p.gx},${p.gz}`));
const PATH_WORLD = PATH.map(p => ({
  x: p.gx * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2,
  z: p.gz * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2,
}));

function gridToWorld(gx, gz) {
  return {
    x: gx * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2,
    z: gz * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2,
  };
}

// ── Definitions ───────────────────────────────────────────────────────────────

const ENEMY_DEFS = {
  'ufo-a': { hp: 80,   speed: 2.2, reward: 10,  model: 'enemy-ufo-a' },
  'ufo-b': { hp: 260,  speed: 1.4, reward: 28,  model: 'enemy-ufo-b' },
  'ufo-c': { hp: 120,  speed: 4.0, reward: 18,  model: 'enemy-ufo-c' },
  'ufo-d': { hp: 1600, speed: 0.85,reward: 220, model: 'enemy-ufo-d' },
};

// Base stats at level 1; levels scale via LEVEL_MULT
const TOWER_DEFS = {
  ballista: { damage: 28,  range: 3.5, fireRate: 2.5, cost: 60,  sellValue: 30, splash: 0,   ammo: 'arrow'      },
  cannon:   { damage: 70,  range: 3.5, fireRate: 1.0, cost: 100, sellValue: 50, splash: 0,   ammo: 'cannonball'  },
  catapult: { damage: 140, range: 5.0, fireRate: 0.5, cost: 150, sellValue: 75, splash: 1.8, ammo: 'boulder'    },
  turret:   { damage: 13,  range: 3.0, fireRate: 5.0, cost: 80,  sellValue: 40, splash: 0,   ammo: 'bullet'     },
};

// Per-level multipliers [lvl1, lvl2, lvl3]
const LEVEL_MULT = [
  { dmg: 1.0,  range: 1.0  },
  { dmg: 1.8,  range: 1.15 },
  { dmg: 2.75, range: 1.3  },
];

// Upgrade cost to reach next level (index = current level, so [1] = cost to reach 2)
function upgradeCost(type, toLevel) {
  const base = TOWER_DEFS[type].cost;
  return toLevel === 2 ? Math.floor(base * 0.75) : Math.floor(base * 1.1);
}

const WAVES = [
  [{type:'ufo-a', count:8,  interval:1.3}],
  [{type:'ufo-a', count:14, interval:1.0}],
  [{type:'ufo-a', count:12, interval:0.9}, {type:'ufo-b', count:4,  interval:2.0}],
  [{type:'ufo-b', count:10, interval:1.5}],
  [{type:'ufo-a', count:18, interval:0.6}, {type:'ufo-b', count:6,  interval:1.2}, {type:'ufo-c', count:6,  interval:1.0}],
  [{type:'ufo-c', count:18, interval:0.7}],
  [{type:'ufo-b', count:12, interval:1.0}, {type:'ufo-c', count:12, interval:0.6}],
  [{type:'ufo-a', count:25, interval:0.4}, {type:'ufo-b', count:10, interval:0.7}],
  [{type:'ufo-c', count:22, interval:0.45},{type:'ufo-d', count:1,  interval:8.0}],
  [{type:'ufo-a', count:12, interval:0.3}, {type:'ufo-b', count:12, interval:0.4}, {type:'ufo-c', count:12, interval:0.35},{type:'ufo-d', count:3, interval:5.0}],
];

// ── Targeting ─────────────────────────────────────────────────────────────────

function pickTarget(tower, enemies) {
  const def   = TOWER_DEFS[tower.type];
  const lm    = LEVEL_MULT[(tower.level || 1) - 1];
  const rangeWU = def.range * lm.range * CELL_SIZE;
  const wp    = gridToWorld(tower.gx, tower.gz);

  const inRange = enemies.filter(e => {
    if (e.dead) return false;
    const dx = e.x - wp.x, dz = e.z - wp.z;
    return dx * dx + dz * dz <= rangeWU * rangeWU;
  });
  if (!inRange.length) return null;

  switch (tower.targeting || 'first') {
    case 'last':
      return inRange.reduce((a, b) =>
        (a.pathIndex + a.progress) < (b.pathIndex + b.progress) ? a : b);
    case 'strong':
      return inRange.reduce((a, b) => a.hp > b.hp ? a : b);
    case 'close': {
      return inRange.reduce((a, b) => {
        const da = (a.x - wp.x) ** 2 + (a.z - wp.z) ** 2;
        const db = (b.x - wp.x) ** 2 + (b.z - wp.z) ** 2;
        return da < db ? a : b;
      });
    }
    default: // 'first'
      return inRange.reduce((a, b) =>
        (a.pathIndex + a.progress) > (b.pathIndex + b.progress) ? a : b);
  }
}

// ── Room ──────────────────────────────────────────────────────────────────────

const rooms = new Map();
let nextId = 1;
const uid = () => nextId++;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class GameRoom {
  constructor(code) {
    this.code     = code;
    this.players  = new Map();
    this.phase    = 'lobby';
    this.gold     = 200;
    this.lives    = 20;
    this.score    = 0;
    this.kills    = 0;
    this.wave     = 0;
    this.enemies  = [];
    this.towers   = [];
    this.bullets  = [];
    this.spawnQueue    = [];
    this.spawnTimer    = 0;
    this.waveComplete  = false;
    this.betweenWaves  = false;
    this.nextWaveAt    = 0;
    this._interval     = null;
    this._lastTick     = Date.now();
  }

  addPlayer(sid, name) {
    const palette = ['#4fc3f7', '#f48fb1', '#a5d6a7', '#ffe082'];
    this.players.set(sid, { name, color: palette[this.players.size % 4] });
  }

  removePlayer(sid) {
    this.players.delete(sid);
    if (this.players.size === 0) this.stop();
  }

  start() {
    if (this.phase !== 'lobby') return;
    this.phase     = 'playing';
    this._lastTick = Date.now();
    this._launchWave();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    clearInterval(this._interval);
    this._interval = null;
  }

  _launchWave() {
    if (this.wave >= WAVES.length) {
      this.phase = 'victory';
      rooms.delete(this.code);
      this.broadcast('game-over', { victory: true, score: this.score, kills: this.kills });
      this.stop();
      return;
    }
    this.betweenWaves = false;
    this.waveComplete = false;
    this.spawnQueue   = [];
    for (const grp of WAVES[this.wave]) {
      for (let i = 0; i < grp.count; i++) {
        this.spawnQueue.push({ type: grp.type, delay: grp.interval });
      }
    }
    this.wave++;
    this.spawnTimer = 1.5; // brief pause before first spawn
    this.broadcast('wave-start', { wave: this.wave });
  }

  _tick() {
    const now = Date.now();
    const dt  = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;

    if (this.phase !== 'playing') return;

    // Spawn enemies from queue
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.spawnQueue.length > 0) {
      const next = this.spawnQueue.shift();
      this.spawnTimer = next.delay;
      this._spawnEnemy(next.type);
    }

    // Move enemies along path
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.progress += (e.speed / CELL_SIZE) * dt;
      while (e.progress >= 1 && e.pathIndex < PATH.length - 1) {
        e.progress -= 1;
        e.pathIndex++;
      }
      if (e.pathIndex >= PATH.length - 1 && e.progress >= 1) {
        e.dead = true;
        this.lives = Math.max(0, this.lives - 1);
        if (this.lives <= 0) {
          this.phase = 'gameover';
          rooms.delete(this.code);
          this.broadcast('game-over', { victory: false, score: this.score, kills: this.kills });
          this.stop();
          return;
        }
        continue;
      }
      const p1 = PATH_WORLD[e.pathIndex];
      const p2 = PATH_WORLD[Math.min(e.pathIndex + 1, PATH_WORLD.length - 1)];
      e.x = p1.x + (p2.x - p1.x) * e.progress;
      e.z = p1.z + (p2.z - p1.z) * e.progress;
    }

    // Tower targeting and shooting
    for (const tower of this.towers) {
      tower.cooldown = Math.max(0, tower.cooldown - dt);
      if (tower.cooldown > 0) continue;

      const target = pickTarget(tower, this.enemies);
      if (!target) continue;

      const def = TOWER_DEFS[tower.type];
      const lm  = LEVEL_MULT[(tower.level || 1) - 1];
      tower.cooldown    = 1 / def.fireRate;
      tower.lastTargetX = target.x;
      tower.lastTargetZ = target.z;

      this.bullets.push({
        id:         uid(),
        targetId:   target.id,
        x:          gridToWorld(tower.gx, tower.gz).x,
        y:          1.5,
        z:          gridToWorld(tower.gx, tower.gz).z,
        damage:     Math.round(def.damage * lm.dmg),
        splash:     def.splash,
        speed:      def.splash > 0 ? 9 : 15,
        ammo:       def.ammo,
        towerType:  tower.type,
        dead:       false,
      });
    }

    // Move bullets toward their homing targets
    for (const b of this.bullets) {
      if (b.dead) continue;
      const tgt = this.enemies.find(e => e.id === b.targetId && !e.dead);
      if (!tgt) { b.dead = true; continue; }

      const tx = tgt.x, ty = 1.2, tz = tgt.z;
      const dx = tx - b.x, dy = ty - b.y, dz = tz - b.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 0.45) {
        if (b.splash > 0) {
          const r2 = (b.splash * CELL_SIZE) ** 2;
          for (const e of this.enemies) {
            if (e.dead) continue;
            if ((e.x - tx) ** 2 + (e.z - tz) ** 2 <= r2) this._damage(e, b.damage);
          }
        } else {
          this._damage(tgt, b.damage);
        }
        b.dead = true;
      } else {
        const s = b.speed * dt / dist;
        b.x += dx * s; b.y += dy * s; b.z += dz * s;
      }
    }

    // Remove dead entities
    this.enemies = this.enemies.filter(e => !e.dead);
    this.bullets = this.bullets.filter(b => !b.dead);

    // Wave completion
    if (!this.waveComplete && !this.betweenWaves &&
        this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.waveComplete = true;
      this.betweenWaves = true;
      this.nextWaveAt   = Date.now() + BETWEEN_WAVE_MS;
      const bonus = 40 + this.wave * 10;
      this.gold += bonus;
      this.broadcast('wave-complete', { wave: this.wave, bonusGold: bonus });
      setTimeout(() => {
        if (this.phase === 'playing') this._launchWave();
      }, BETWEEN_WAVE_MS);
    }

    this._broadcastState();
  }

  _damage(enemy, dmg) {
    enemy.hp -= dmg;
    if (enemy.hp <= 0 && !enemy.dead) {
      enemy.dead  = true;
      this.gold  += enemy.reward;
      this.score += enemy.reward * 10;
      this.kills++;
    }
  }

  _spawnEnemy(type) {
    const def = ENEMY_DEFS[type];
    const sp  = PATH_WORLD[0];
    this.enemies.push({
      id: uid(), type, model: def.model,
      pathIndex: 0, progress: 0,
      x: sp.x, y: 1.2, z: sp.z,
      hp: def.hp, maxHp: def.hp,
      speed: def.speed, reward: def.reward,
      dead: false,
    });
  }

  placeTower(sid, type, gx, gz) {
    const def = TOWER_DEFS[type];
    if (!def)                                    return { error: 'Unknown tower type' };
    if (this.gold < def.cost)                   return { error: 'Not enough gold' };
    if (PATH_SET.has(`${gx},${gz}`))             return { error: 'Cannot place on path' };
    if (this.towers.some(t => t.gx === gx && t.gz === gz)) return { error: 'Cell occupied' };
    if (gx < 0 || gx >= GRID_SIZE || gz < 0 || gz >= GRID_SIZE) return { error: 'Out of bounds' };

    this.gold -= def.cost;
    const p = this.players.get(sid) || { name: 'Unknown', color: '#fff' };
    this.towers.push({
      id: uid(), type, gx, gz, level: 1, targeting: 'first',
      cooldown: 0,
      range: def.range, damage: def.damage, fireRate: def.fireRate,
      owner: p.name, ownerColor: p.color,
      lastTargetX: null, lastTargetZ: null,
    });
    return { success: true };
  }

  upgradeTower(sid, towerId) {
    const tower = this.towers.find(t => t.id === towerId);
    if (!tower) return { error: 'Tower not found' };
    const lvl = tower.level || 1;
    if (lvl >= 3) return { error: 'Already max level' };
    const cost = upgradeCost(tower.type, lvl + 1);
    if (this.gold < cost) return { error: 'Not enough gold' };
    this.gold -= cost;
    tower.level = lvl + 1;
    return { success: true };
  }

  setTargeting(sid, towerId, mode) {
    const tower = this.towers.find(t => t.id === towerId);
    if (!tower) return { error: 'Tower not found' };
    if (!['first', 'last', 'strong', 'close'].includes(mode)) return { error: 'Invalid mode' };
    tower.targeting = mode;
    return { success: true };
  }

  sellTower(sid, towerId) {
    const idx = this.towers.findIndex(t => t.id === towerId);
    if (idx === -1) return { error: 'Tower not found' };
    const tower = this.towers[idx];
    const def   = TOWER_DEFS[tower.type];
    // Sell value increases with level
    const sellVal = Math.floor(def.sellValue * (1 + (tower.level - 1) * 0.5));
    this.gold += sellVal;
    this.towers.splice(idx, 1);
    return { success: true, refund: sellVal };
  }

  getState() {
    return {
      phase:       this.phase,
      wave:        this.wave,
      totalWaves:  WAVES.length,
      gold:        this.gold,
      lives:       this.lives,
      score:       this.score,
      kills:       this.kills,
      betweenWaves:this.betweenWaves,
      nextWaveMs:  this.betweenWaves ? Math.max(0, this.nextWaveAt - Date.now()) : 0,
      spawnLeft:   this.spawnQueue.length,
      players:     [...this.players.entries()].map(([id, p]) => ({ id, ...p })),
      enemies:     this.enemies.filter(e => !e.dead).map(e => ({
        id: e.id, type: e.type, model: e.model,
        x: e.x, y: e.y, z: e.z,
        hp: e.hp, maxHp: e.maxHp,
        pathIndex: e.pathIndex, progress: e.progress,
      })),
      towers: this.towers.map(t => ({
        id: t.id, type: t.type, gx: t.gx, gz: t.gz,
        level: t.level || 1, targeting: t.targeting || 'first',
        range: TOWER_DEFS[t.type].range * LEVEL_MULT[(t.level||1)-1].range,
        owner: t.owner, ownerColor: t.ownerColor,
        lastTargetX: t.lastTargetX, lastTargetZ: t.lastTargetZ,
      })),
      bullets: this.bullets.filter(b => !b.dead).map(b => ({
        id: b.id, x: b.x, y: b.y, z: b.z, ammo: b.ammo, towerType: b.towerType,
      })),
    };
  }

  broadcast(ev, data) { io.to(this.code).emit(ev, data); }
  _broadcastState()   { io.to(this.code).emit('game-state', this.getState()); }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let room = null;

  socket.on('create-room', ({ name, solo }) => {
    const code = genCode();
    const r    = new GameRoom(code);
    rooms.set(code, r);
    r.addPlayer(socket.id, name || 'Commander');
    socket.join(code);
    room = r;
    socket.emit('room-created', { code, playerId: socket.id, solo: !!solo });
    if (solo) r.start();
  });

  socket.on('join-room', ({ code, name }) => {
    const r = rooms.get(code.toUpperCase());
    if (!r)                  { socket.emit('join-error', { message: 'Room not found' }); return; }
    if (r.players.size >= 4) { socket.emit('join-error', { message: 'Room is full' });  return; }
    if (r.phase !== 'lobby') { socket.emit('join-error', { message: 'Game already started' }); return; }
    r.addPlayer(socket.id, name || `Player ${r.players.size + 1}`);
    socket.join(code.toUpperCase());
    room = r;
    socket.emit('room-joined', { code: code.toUpperCase(), playerId: socket.id });
    r.broadcast('player-joined', { name: name || `Player ${r.players.size}` });
  });

  socket.on('start-game', () => {
    if (!room || room.phase !== 'lobby') return;
    room.start();
  });

  socket.on('place-tower', ({ type, gx, gz }) => {
    if (!room || room.phase !== 'playing') return;
    const res = room.placeTower(socket.id, type, gx, gz);
    if (res.error) socket.emit('action-error', { message: res.error });
  });

  socket.on('upgrade-tower', ({ towerId }) => {
    if (!room || room.phase !== 'playing') return;
    const res = room.upgradeTower(socket.id, towerId);
    if (res.error) socket.emit('action-error', { message: res.error });
  });

  socket.on('set-targeting', ({ towerId, mode }) => {
    if (!room || room.phase !== 'playing') return;
    room.setTargeting(socket.id, towerId, mode);
  });

  socket.on('sell-tower', ({ towerId }) => {
    if (!room || room.phase !== 'playing') return;
    const res = room.sellTower(socket.id, towerId);
    if (res.error) socket.emit('action-error', { message: res.error });
  });

  socket.on('request-state', () => {
    if (!room) return;
    socket.emit('game-state', room.getState());
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size > 0) room.broadcast('player-left', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UFO Assault  →  http://localhost:${PORT}`));
