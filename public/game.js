import * as THREE from 'three';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader }     from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants (must mirror server.js) ─────────────────────────────────────────
const CELL_SIZE = 2;
const GRID_SIZE = 10;

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
const PATH_SET = new Set(PATH.map(p => `${p.gx},${p.gz}`));

function gridToWorld(gx, gz) {
  return new THREE.Vector3(
    gx * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2,
    0,
    gz * CELL_SIZE - (GRID_SIZE * CELL_SIZE / 2) + CELL_SIZE / 2
  );
}

const TOWER_UI = {
  ballista: { cost: 60,  sellValue: 30, range: 3.5 },
  cannon:   { cost: 100, sellValue: 50, range: 3.5 },
  catapult: { cost: 150, sellValue: 75, range: 5.0 },
  turret:   { cost: 80,  sellValue: 40, range: 3.0 },
};

const UPGRADE_COSTS = {
  ballista: [null, 45,  70],
  cannon:   [null, 75, 110],
  catapult: [null, 115, 165],
  turret:   [null, 60,  88],
};

const LEVEL_RANGE_MULT = [1.0, 1.15, 1.3];

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060c18);
scene.fog = new THREE.FogExp2(0x060c18, 0.016);

// ── Camera ────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 130);
camera.position.set(0, 20, 16);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.minDistance = 7;
controls.maxDistance = 40;
controls.maxPolarAngle = Math.PI / 2.05;
controls.enableDamping = true;
controls.dampingFactor = 0.07;

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x2a3f5f, 2.2));

const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-22, right:22, top:22, bottom:-22, near:1, far:80 });
scene.add(sun);
scene.add(new THREE.DirectionalLight(0x3355aa, 0.5)).position.set(-10, 10, -10);

// ── Starfield ─────────────────────────────────────────────────────────────────
(function () {
  const N = 700;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i*3]   = (Math.random() - 0.5) * 130;
    pos[i*3+1] = Math.random() * 40 + 8;
    pos[i*3+2] = (Math.random() - 0.5) * 130;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.055 })));
})();

// ── Model Loader (GLB with pending-coalescing) ────────────────────────────────
const gltfLoader = new GLTFLoader();
const glbCache   = {};
const glbPending = {};

function loadGLB(url) {
  return new Promise((resolve, reject) => {
    if (glbCache[url]) { resolve(glbCache[url].clone()); return; }
    if (glbPending[url]) { glbPending[url].push({ resolve, reject }); return; }
    glbPending[url] = [{ resolve, reject }];
    gltfLoader.load(url, (gltf) => {
      gltf.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      glbCache[url] = gltf.scene;
      glbPending[url].forEach(p => p.resolve(gltf.scene.clone()));
      delete glbPending[url];
    }, undefined, (err) => {
      glbPending[url].forEach(p => p.reject(err));
      delete glbPending[url];
    });
  });
}

// ── Grid ──────────────────────────────────────────────────────────────────────
function pathTileInfo(idx) {
  const curr = PATH[idx];
  const prev = PATH[idx - 1];
  const next = PATH[idx + 1];

  if (!prev)  return { model: 'tile-spawn',     rotY: 0 };
  if (!next)  return { model: 'tile-end-round',  rotY: 0 };

  const inDx  = curr.gx - prev.gx, inDz  = curr.gz - prev.gz;
  const outDx = next.gx - curr.gx, outDz = next.gz - curr.gz;

  // Straight
  if (inDx === outDx && inDz === outDz) {
    return { model: 'tile-straight', rotY: inDz !== 0 ? Math.PI / 2 : 0 };
  }

  // Corner — determine the tile orientation
  // The tile default is assumed NE (enter from North, exit East)
  let rotY = 0;
  if (inDx ===  1 && outDz ===  1) rotY = Math.PI;       // W-enter S-exit  (SW)
  if (inDz ===  1 && outDx === -1) rotY = -Math.PI / 2;  // N-enter W-exit  (NW)
  if (inDx === -1 && outDz ===  1) rotY = Math.PI / 2;   // E-enter S-exit  (SE)
  if (inDz ===  1 && outDx ===  1) rotY = 0;             // N-enter E-exit  (NE)
  return { model: 'tile-corner-round', rotY };
}

// Pseudo-random but deterministic per cell (for decoration)
function cellRand(gx, gz) {
  const h = Math.sin(gx * 127.1 + gz * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

async function buildGrid(onProgress) {
  const needed = ['tile', 'tile-straight', 'tile-corner-round', 'tile-spawn',
                  'tile-end-round', 'tile-tree', 'detail-tree', 'detail-crystal'];
  const models = {};
  let loaded = 0;
  await Promise.allSettled(needed.map(n =>
    loadGLB(`/assets/tower-defense/${n}.glb`)
      .then(m => { models[n] = m; })
      .catch(() => { models[n] = null; })
      .finally(() => { loaded++; onProgress(loaded / needed.length * 0.6); })
  ));

  const group = new THREE.Group();
  const grassMat  = new THREE.MeshLambertMaterial({ color: 0x2a5e2a });
  const pathMat   = new THREE.MeshLambertMaterial({ color: 0x7a5c3e });
  const grassGeo  = new THREE.BoxGeometry(CELL_SIZE - 0.04, 0.16, CELL_SIZE - 0.04);
  const pathGeo   = new THREE.BoxGeometry(CELL_SIZE - 0.04, 0.10, CELL_SIZE - 0.04);

  for (let gx = 0; gx < GRID_SIZE; gx++) {
    for (let gz = 0; gz < GRID_SIZE; gz++) {
      const isPath  = PATH_SET.has(`${gx},${gz}`);
      const wpos    = gridToWorld(gx, gz);
      const pathIdx = PATH.findIndex(p => p.gx === gx && p.gz === gz);

      if (isPath && pathIdx !== -1) {
        const { model: mName, rotY } = pathTileInfo(pathIdx);
        const src = models[mName] || models['tile-straight'];
        if (src) {
          const t = src.clone(); t.position.set(wpos.x, 0, wpos.z); t.rotation.y = rotY;
          group.add(t);
        } else {
          const m = new THREE.Mesh(pathGeo, pathMat);
          m.position.set(wpos.x, 0, wpos.z); m.receiveShadow = true; group.add(m);
        }
      } else {
        const r = cellRand(gx, gz);
        let tileModel = null;
        if (r < 0.18 && models['tile-tree']) tileModel = models['tile-tree'].clone();
        else if (models['tile'])             tileModel = models['tile'].clone();

        if (tileModel) {
          tileModel.position.set(wpos.x, 0, wpos.z);
          group.add(tileModel);
        } else {
          const m = new THREE.Mesh(grassGeo, grassMat);
          m.position.set(wpos.x, 0, wpos.z); m.receiveShadow = true; group.add(m);
        }

        // Sparse decorative details on plain grass tiles
        if (r > 0.18 && r < 0.22 && models['detail-crystal']) {
          const d = models['detail-crystal'].clone();
          d.position.set(wpos.x + (cellRand(gx+1,gz) - 0.5) * 0.8, 0, wpos.z + (cellRand(gx,gz+1) - 0.5) * 0.8);
          d.rotation.y = r * Math.PI * 2;
          group.add(d);
        }
      }
    }
    onProgress(0.6 + ((gx + 1) / GRID_SIZE) * 0.25);
  }

  scene.add(group);

  // Grid border
  const border = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-10, 0.25, -10), new THREE.Vector3(10, 0.25, -10),
      new THREE.Vector3(10, 0.25, 10),   new THREE.Vector3(-10, 0.25, 10),
      new THREE.Vector3(-10, 0.25, -10),
    ]),
    new THREE.LineBasicMaterial({ color: 0x4fc3f7, opacity: 0.25, transparent: true })
  );
  scene.add(border);
}

// ── Hover indicator ───────────────────────────────────────────────────────────
const hoverMesh = (() => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(CELL_SIZE - 0.06, 0.3, CELL_SIZE - 0.06),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.35, depthWrite: false })
  );
  m.visible = false; scene.add(m); return m;
})();

let rangeCircle = null;
function showRange(wx, wz, radius) {
  if (rangeCircle) { scene.remove(rangeCircle); rangeCircle = null; }
  const geo = new THREE.RingGeometry(radius - 0.05, radius + 0.05, 52);
  rangeCircle = new THREE.Mesh(geo,
    new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  rangeCircle.rotation.x = -Math.PI / 2;
  rangeCircle.position.set(wx, 0.22, wz);
  scene.add(rangeCircle);
}
function hideRange() {
  if (rangeCircle) { scene.remove(rangeCircle); rangeCircle = null; }
}

// ── Raycasting ────────────────────────────────────────────────────────────────
const raycaster   = new THREE.Raycaster();
const mouse2d     = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const rayHit      = new THREE.Vector3();

function screenToGrid(event) {
  mouse2d.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse2d.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse2d, camera);
  raycaster.ray.intersectPlane(groundPlane, rayHit);
  return {
    gx: Math.floor((rayHit.x + GRID_SIZE) / CELL_SIZE),
    gz: Math.floor((rayHit.z + GRID_SIZE) / CELL_SIZE),
  };
}

// ── Entity collections ────────────────────────────────────────────────────────
const enemyObjs   = new Map(); // id → group
const enemyTarget = new Map(); // id → THREE.Vector3 (server position for lerp)
const dyingObjs   = new Map(); // id → { group, timer }
const towerObjs   = new Map(); // id → group
const bulletObjs  = new Map(); // id → group

// ── Enemy meshes ──────────────────────────────────────────────────────────────
const UFO_GLOW = { 'ufo-a': 0x4fc3f7, 'ufo-b': 0xdf40f0, 'ufo-c': 0xffd740, 'ufo-d': 0xff3333 };
const UFO_COL  = { 'ufo-a': 0x2090c0, 'ufo-b': 0x8020a0, 'ufo-c': 0xa08000, 'ufo-d': 0x900000 };

async function makeEnemyGroup(enemy) {
  const g = new THREE.Group();

  try {
    const m = await loadGLB(`/assets/tower-defense/${enemy.model}.glb`);
    m.scale.setScalar(1.05);
    g.add(m);
  } catch {
    const col  = UFO_COL[enemy.type] || 0x2090c0;
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.58, 0.18, 0.26, 12),
      new THREE.MeshLambertMaterial({ color: col })
    );
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0xaaccee, transparent: true, opacity: 0.65 })
    );
    dome.position.y = 0.13;
    g.add(disc); g.add(dome);
  }

  // Health bar — added to scene directly so it can billboard
  const hbBgMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.12),
    new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true, opacity: 0.8 })
  );
  hbBgMesh.renderOrder = 10;

  const hbFillMat = new THREE.MeshBasicMaterial({ color: 0x44cc44, depthTest: false });
  const hbFillMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.12), hbFillMat);
  hbFillMesh.renderOrder = 11;

  scene.add(hbBgMesh);
  scene.add(hbFillMesh);
  g.userData.hbBg   = hbBgMesh;
  g.userData.hbFill = hbFillMesh;
  g.userData.hpRatio = 1;

  // Point glow
  const glow = new THREE.PointLight(UFO_GLOW[enemy.type] || 0x4fc3f7, 0.65, 3.5);
  glow.position.y = 0.2;
  g.add(glow);

  return g;
}

function updateHpBar(group, ratio) {
  group.userData.hpRatio = ratio;
  const fill = group.userData.hbFill;
  if (!fill) return;
  fill.scale.x = Math.max(0.001, ratio);
  const col = ratio > 0.55 ? 0x44cc44 : ratio > 0.25 ? 0xffcc00 : 0xee2222;
  fill.material.color.setHex(col);
}

function removeEnemyHpBars(group) {
  if (group.userData.hbBg)   scene.remove(group.userData.hbBg);
  if (group.userData.hbFill) scene.remove(group.userData.hbFill);
}

// ── Tower meshes ──────────────────────────────────────────────────────────────
const TOWER_COLORS = { ballista: 0x8d6e63, cannon: 0x455a64, catapult: 0x5d4037, turret: 0x37474f };

async function makeTowerGroup(tower) {
  const g = new THREE.Group();
  const wp = gridToWorld(tower.gx, tower.gz);
  g.position.set(wp.x, 0, wp.z);
  g.userData.towerId = tower.id;

  try {
    const base = await loadGLB('/assets/tower-defense/tower-round-base.glb');
    g.add(base);
  } catch { /* use weapon alone */ }

  try {
    const weapon = await loadGLB(`/assets/tower-defense/weapon-${tower.type}.glb`);
    weapon.position.y = 0.4;
    weapon.userData.isWeapon = true;
    g.add(weapon);
  } catch {
    const col  = TOWER_COLORS[tower.type] || 0x546e7a;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.38, 0.9, 8),
      new THREE.MeshLambertMaterial({ color: col })
    );
    body.position.y = 0.45;
    body.userData.isWeapon = true;
    g.add(body);
  }

  // Owner dot
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 6, 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tower.ownerColor) })
  );
  dot.position.y = 1.5;
  g.add(dot);

  return g;
}

function updateTowerLevel(group, level) {
  // Remove old level dots
  group.children.filter(c => c.userData.isLvlDot).forEach(c => group.remove(c));
  for (let i = 0; i < level; i++) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0xffd740, emissive: 0xffd740, emissiveIntensity: 0.6 })
    );
    dot.position.set(-0.2 + i * 0.2, 1.7, 0);
    dot.userData.isLvlDot = true;
    group.add(dot);
  }
}

// ── Bullet meshes ─────────────────────────────────────────────────────────────
const AMMO_GLOW = { arrow: 0xd4a84b, cannonball: 0x78909c, boulder: 0x8d6e63, bullet: 0xffd740 };

async function makeBulletGroup(ammo) {
  const g = new THREE.Group();
  const glowCol = AMMO_GLOW[ammo] || 0xffffff;

  try {
    const m = await loadGLB(`/assets/tower-defense/weapon-ammo-${ammo}.glb`);
    m.scale.setScalar(0.9);
    g.add(m);
  } catch {
    const sizes = { arrow: 0.08, cannonball: 0.18, boulder: 0.22, bullet: 0.07 };
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(sizes[ammo] || 0.1, 6, 6),
      new THREE.MeshBasicMaterial({ color: glowCol })
    );
    g.add(mesh);
  }

  const light = new THREE.PointLight(glowCol, 1.0, 2.2);
  g.add(light);
  return g;
}

// ── Scene Sync ────────────────────────────────────────────────────────────────
async function syncScene(s) {
  // ── Enemies ──
  const liveEnemyIds = new Set(s.enemies.map(e => e.id));

  for (const [id, group] of enemyObjs) {
    if (!liveEnemyIds.has(id)) {
      // Start death animation
      removeEnemyHpBars(group);
      dyingObjs.set(id, { group, timer: 0.4 });
      enemyObjs.delete(id);
      enemyTarget.delete(id);
    }
  }

  for (const e of s.enemies) {
    const pos = new THREE.Vector3(e.x, e.y, e.z);
    if (!enemyObjs.has(e.id)) {
      const group = await makeEnemyGroup(e);
      group.position.copy(pos);
      scene.add(group);
      enemyObjs.set(e.id, group);
    }
    enemyTarget.set(e.id, pos);
    updateHpBar(enemyObjs.get(e.id), e.hp / e.maxHp);

    // Face direction of travel
    const pi = e.pathIndex;
    if (pi < PATH.length - 1) {
      const curr = PATH[pi], next = PATH[pi + 1];
      enemyObjs.get(e.id).rotation.y = Math.atan2(-(next.gx - curr.gx), -(next.gz - curr.gz));
    }
  }

  // ── Towers ──
  const liveTowerIds = new Set(s.towers.map(t => t.id));
  for (const [id, g] of towerObjs) {
    if (!liveTowerIds.has(id)) { scene.remove(g); towerObjs.delete(id); }
  }
  for (const t of s.towers) {
    if (!towerObjs.has(t.id)) {
      const g = await makeTowerGroup(t);
      scene.add(g);
      towerObjs.set(t.id, g);
    }
    updateTowerLevel(towerObjs.get(t.id), t.level);
  }

  // ── Bullets ──
  const liveBulletIds = new Set(s.bullets.map(b => b.id));
  for (const [id, g] of bulletObjs) {
    if (!liveBulletIds.has(id)) { scene.remove(g); bulletObjs.delete(id); }
  }
  for (const b of s.bullets) {
    if (!bulletObjs.has(b.id)) {
      const g = await makeBulletGroup(b.ammo || b.towerType);
      scene.add(g);
      bulletObjs.set(b.id, g);
    }
    bulletObjs.get(b.id).position.set(b.x, b.y, b.z);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let state         = null;
let selectedTower = null;   // type string when placing
let selectedTowerId = null; // id of placed tower when inspecting
let myId          = null;
let roomCode      = null;
let bwInterval    = null;

// ── UI ────────────────────────────────────────────────────────────────────────
function updateHUD(s) {
  document.getElementById('gold-display').textContent  = s.gold;
  document.getElementById('lives-display').textContent = s.lives;
  document.getElementById('wave-display').textContent  = s.wave;
  document.getElementById('total-waves').textContent   = s.totalWaves;
  document.getElementById('score-display').textContent = s.score;
  document.getElementById('kills-display').textContent = s.kills;
  document.getElementById('lives-display').style.color = s.lives <= 5 ? '#f44336' : '';

  const enemyStat = document.getElementById('enemy-count-stat');
  const enemyCount = document.getElementById('enemy-count');
  if (s.phase === 'playing' && !s.betweenWaves) {
    const total = s.enemies.length + s.spawnLeft;
    enemyStat.style.display = total > 0 ? '' : 'none';
    enemyCount.textContent  = total;
  } else {
    enemyStat.style.display = 'none';
  }

  if (roomCode) document.getElementById('room-tag').textContent = `ROOM ${roomCode}`;

  const pb = document.getElementById('players-bar');
  pb.innerHTML = '';
  for (const p of s.players) {
    const b = document.createElement('div');
    b.className = 'player-badge';
    b.style.borderLeftColor = p.color;
    b.textContent = p.name;
    pb.appendChild(b);
  }

  // Tower button affordability
  document.querySelectorAll('.tower-btn').forEach(btn => {
    btn.classList.toggle('cant-afford', s.gold < parseInt(btn.dataset.cost, 10));
    btn.classList.toggle('active', selectedTower === btn.dataset.tower);
  });

  // Update selected tower panel
  if (selectedTowerId) {
    const t = s.towers.find(t => t.id === selectedTowerId);
    if (t) refreshSelectedPanel(t, s.gold);
    else   clearSelectedPanel();
  }
}

function refreshSelectedPanel(t, gold) {
  document.getElementById('sel-name-level').innerHTML =
    `${t.type.toUpperCase()} &nbsp;` + levelDots(t.level);
  document.getElementById('sel-owner').textContent = `placed by ${t.owner}`;

  // Targeting buttons
  document.querySelectorAll('.tgt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === t.targeting);
  });

  // Upgrade button
  const btnUpg = document.getElementById('btn-upgrade');
  if (t.level < 3) {
    const cost = UPGRADE_COSTS[t.type]?.[t.level] ?? 0;
    btnUpg.textContent = `Upgrade to Lv.${t.level + 1} (${cost}g)`;
    btnUpg.classList.remove('hidden');
    btnUpg.classList.toggle('cant-afford', gold < cost);
    btnUpg.disabled = gold < cost;
  } else {
    btnUpg.classList.add('hidden');
  }

  // Sell button
  const baseSell = TOWER_UI[t.type]?.sellValue || 0;
  const sellVal  = Math.floor(baseSell * (1 + (t.level - 1) * 0.5));
  document.getElementById('btn-sell').textContent = `Sell (${sellVal}g)`;

  // Show range ring
  const wp = gridToWorld(t.gx, t.gz);
  showRange(wp.x, wp.z, t.range * CELL_SIZE);
}

function levelDots(level) {
  let html = '<span class="lvl-dots">';
  for (let i = 1; i <= 3; i++) {
    html += `<span class="lvl-dot${i <= level ? ' filled' : ''}"></span>`;
  }
  return html + '</span>';
}

function showSelectedPanel(towerId) {
  selectedTowerId = towerId;
  selectedTower   = null;
  document.querySelectorAll('.tower-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sel-tower-info').classList.remove('hidden');
  document.getElementById('placement-hint').classList.add('hidden');
  hoverMesh.visible = false;
}

function clearSelectedPanel() {
  selectedTowerId = null;
  document.getElementById('sel-tower-info').classList.add('hidden');
  document.getElementById('placement-hint').classList.remove('hidden');
  hideRange();
}

function showBanner(text) {
  const el = document.getElementById('wave-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none'; void el.offsetWidth;
  el.style.animation = 'bannerAnim 3s forwards';
  setTimeout(() => el.classList.add('hidden'), 3100);
}

function addMsg(text, color = '#7090a0') {
  const log = document.getElementById('msg-log');
  const el  = document.createElement('div');
  el.className = 'msg'; el.style.color = color; el.textContent = text;
  log.prepend(el);
  setTimeout(() => el.remove(), 3100);
}

let lastBetweenWaves = false;
function handleBetweenWaves(s) {
  const bwEl = document.getElementById('between-waves-ui');
  if (s.betweenWaves && s.phase === 'playing') {
    bwEl.classList.remove('hidden');
    document.getElementById('bw-title').textContent =
      `Wave ${s.wave} complete! Next wave in...`;
    if (!lastBetweenWaves) {
      clearInterval(bwInterval);
      let ms = s.nextWaveMs;
      const tick = () => {
        ms -= 200;
        const secs = Math.max(0, Math.ceil(ms / 1000));
        document.getElementById('bw-timer').textContent = secs > 0 ? `${secs}s` : 'Incoming!';
        if (ms <= 0) clearInterval(bwInterval);
      };
      tick();
      bwInterval = setInterval(tick, 200);
    }
  } else {
    bwEl.classList.add('hidden');
    clearInterval(bwInterval);
  }
  lastBetweenWaves = s.betweenWaves;
}

// ── Input ─────────────────────────────────────────────────────────────────────
function setupInput() {
  document.querySelectorAll('.tower-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tower;
      if (selectedTower === t) {
        selectedTower = null;
      } else {
        selectedTower = t;
        clearSelectedPanel();
        hoverMesh.visible = false;
      }
      if (state) updateHUD(state);
    });
  });

  canvas.addEventListener('click', e => {
    if (!state || state.phase !== 'playing') return;
    if (e.target !== canvas) return;
    const { gx, gz } = screenToGrid(e);

    if (selectedTower) {
      socket.emit('place-tower', { type: selectedTower, gx, gz });
    } else {
      const t = state.towers.find(t => t.gx === gx && t.gz === gz);
      if (t) showSelectedPanel(t.id);
      else   clearSelectedPanel();
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!state || state.phase !== 'playing' || !selectedTower) {
      hoverMesh.visible = false;
      return;
    }
    const { gx, gz } = screenToGrid(e);
    if (gx >= 0 && gx < GRID_SIZE && gz >= 0 && gz < GRID_SIZE) {
      const wp  = gridToWorld(gx, gz);
      const bad = PATH_SET.has(`${gx},${gz}`) || state.towers.some(t => t.gx === gx && t.gz === gz);
      hoverMesh.position.set(wp.x, 0.18, wp.z);
      hoverMesh.material.color.setHex(bad ? 0xff2222 : 0x00ff88);
      hoverMesh.visible = true;
      showRange(wp.x, wp.z, TOWER_UI[selectedTower].range * LEVEL_RANGE_MULT[0] * CELL_SIZE);
    } else {
      hoverMesh.visible = false;
      hideRange();
    }
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    selectedTower = null;
    clearSelectedPanel();
    hoverMesh.visible = false;
    hideRange();
    if (state) updateHUD(state);
  });

  document.querySelectorAll('.tgt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!selectedTowerId) return;
      socket.emit('set-targeting', { towerId: selectedTowerId, mode: btn.dataset.mode });
    });
  });

  document.getElementById('btn-upgrade').addEventListener('click', () => {
    if (selectedTowerId) socket.emit('upgrade-tower', { towerId: selectedTowerId });
  });

  document.getElementById('btn-sell').addEventListener('click', () => {
    if (!selectedTowerId) return;
    socket.emit('sell-tower', { towerId: selectedTowerId });
    clearSelectedPanel();
    hideRange();
  });
}

// ── Lobby UI ──────────────────────────────────────────────────────────────────
function setupLobby() {
  document.getElementById('btn-solo').addEventListener('click', () => {
    const name = document.getElementById('player-name').value.trim() || 'Commander';
    socket.emit('create-room', { name, solo: true });
  });

  document.getElementById('btn-create').addEventListener('click', () => {
    const name = document.getElementById('player-name').value.trim() || 'Commander';
    socket.emit('create-room', { name, solo: false });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    const name = document.getElementById('player-name').value.trim() || 'Commander';
    if (!code) { document.getElementById('lobby-error').textContent = 'Enter a room code'; return; }
    socket.emit('join-room', { code, name });
  });

  document.getElementById('room-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  document.getElementById('player-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-solo').click();
  });

  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('start-game');
  });

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(roomCode || '').then(() => {
      const btn = document.getElementById('btn-copy-code');
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy Code'), 2000);
    });
  });

  document.getElementById('btn-restart').addEventListener('click', () => location.reload());
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('room-created', ({ code, playerId, solo }) => {
    myId = playerId; roomCode = code;
    document.getElementById('lobby').classList.add('hidden');
    if (solo) {
      document.getElementById('game-ui').classList.remove('hidden');
      socket.emit('request-state');
    } else {
      document.getElementById('waiting-room').classList.remove('hidden');
      document.getElementById('room-code-show').textContent = code;
    }
  });

  socket.on('room-joined', ({ code, playerId }) => {
    myId = playerId; roomCode = code;
    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('waiting-room').classList.remove('hidden');
    document.getElementById('room-code-show').textContent = code;
    socket.emit('request-state');
  });

  socket.on('join-error', ({ message }) => {
    document.getElementById('lobby-error').textContent = message;
  });

  socket.on('player-joined', ({ name }) => addMsg(`${name} joined.`, '#a5d6a7'));
  socket.on('player-left',   ()          => addMsg('A player disconnected.', '#ffcc80'));

  socket.on('game-state', s => {
    const wasLobby = !state || state.phase === 'lobby';
    state = s;
    if (s.phase === 'playing') {
      if (wasLobby) {
        document.getElementById('waiting-room').classList.add('hidden');
        document.getElementById('game-ui').classList.remove('hidden');
        document.getElementById('end-screen').classList.add('hidden');
      }
      updateHUD(s);
      handleBetweenWaves(s);
      syncScene(s);
    }
  });

  socket.on('wave-start', ({ wave }) => {
    showBanner(`WAVE ${wave}`);
    addMsg(`Wave ${wave} incoming!`, '#f48fb1');
  });

  socket.on('wave-complete', ({ wave, bonusGold }) => {
    showBanner(`WAVE ${wave} CLEARED`);
    addMsg(`Wave ${wave} done. +${bonusGold} gold`, '#ffe082');
  });

  socket.on('game-over', ({ victory, score, kills }) => {
    document.getElementById('end-screen').classList.remove('hidden');
    document.getElementById('game-ui').classList.add('hidden');
    const title = document.getElementById('end-title');
    title.textContent = victory ? 'VICTORY' : 'DEFEATED';
    title.style.color = victory ? '#66bb6a' : '#ef5350';
    document.getElementById('end-stats').innerHTML =
      `Score: <span>${score}</span><br>Kills: <span>${kills}</span>`;
  });

  socket.on('action-error', ({ message }) => addMsg(message, '#ef5350'));
}

// ── Animation loop ────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
const _tmpV  = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t  = clock.elapsedTime;

  // Smooth enemy position lerp + bobbing
  for (const [id, group] of enemyObjs) {
    const tgt = enemyTarget.get(id);
    if (tgt) {
      group.position.x = THREE.MathUtils.lerp(group.position.x, tgt.x, 0.25);
      group.position.z = THREE.MathUtils.lerp(group.position.z, tgt.z, 0.25);
      group.position.y = tgt.y + Math.sin(t * 2.8 + id * 0.9) * 0.1;
    }
    // Spin the UFO body (first child)
    const body = group.children[0];
    if (body?.isGroup || body?.isMesh) body.rotation.y += dt * 1.1;

    // Billboard health bars toward camera
    const pos = group.position.clone().add(new THREE.Vector3(0, 2.0, 0));
    const bg   = group.userData.hbBg;
    const fill = group.userData.hbFill;
    if (bg) {
      bg.position.copy(pos);
      bg.quaternion.copy(camera.quaternion);
      fill.position.copy(pos);
      fill.quaternion.copy(camera.quaternion);
      // Offset fill so it's centered on ratio
      const ratio = group.userData.hpRatio ?? 1;
      fill.position.x += ((ratio - 1) * 1.1) / 2;
    }
  }

  // Death animation: float up + shrink
  for (const [id, dying] of dyingObjs) {
    dying.timer -= dt;
    const prog = dying.timer / 0.4;
    dying.group.scale.setScalar(Math.max(0, prog));
    dying.group.position.y += dt * 3;
    if (dying.timer <= 0) {
      scene.remove(dying.group);
      dyingObjs.delete(id);
    }
  }

  // Tower weapon rotation — aim at nearest enemy in range
  if (state) {
    for (const [id, g] of towerObjs) {
      const tower = state.towers.find(t => t.id === id);
      if (!tower || !state.enemies.length) continue;
      const wp = g.position;
      const rangeWU = tower.range * CELL_SIZE;

      let bestProgress = -1;
      let bestEnemy   = null;
      for (const e of state.enemies) {
        const dx = e.x - wp.x, dz = e.z - wp.z;
        if (dx*dx + dz*dz <= rangeWU*rangeWU) {
          const prog = e.pathIndex + e.progress;
          if (prog > bestProgress) { bestProgress = prog; bestEnemy = e; }
        }
      }

      const weapon = g.children.find(c => c.userData?.isWeapon);
      if (weapon && bestEnemy) {
        const targetY = Math.atan2(bestEnemy.x - wp.x, bestEnemy.z - wp.z);
        weapon.rotation.y = THREE.MathUtils.lerp(weapon.rotation.y, targetY, 0.12);
      }
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Progress ──────────────────────────────────────────────────────────────────
function setProgress(p) {
  document.getElementById('loading-bar').style.width  = `${Math.round(p * 100)}%`;
}
function setLoadText(t) {
  document.getElementById('loading-text').textContent = t;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setLoadText('Building battlefield...');
  await buildGrid(p => setProgress(p));

  setLoadText('Pre-loading models...');
  const preload = [
    'enemy-ufo-a', 'enemy-ufo-b', 'enemy-ufo-c', 'enemy-ufo-d',
    'weapon-ballista', 'weapon-cannon', 'weapon-catapult', 'weapon-turret',
    'weapon-ammo-arrow', 'weapon-ammo-bullet', 'weapon-ammo-cannonball', 'weapon-ammo-boulder',
    'tower-round-base',
  ];
  let loaded = 0;
  await Promise.allSettled(preload.map(n =>
    loadGLB(`/assets/tower-defense/${n}.glb`)
      .finally(() => { loaded++; setProgress(0.85 + (loaded / preload.length) * 0.15); })
  ));

  setProgress(1);
  setLoadText('Ready!');

  setTimeout(() => {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('lobby').classList.remove('hidden');
  }, 300);

  initSocket();
  setupLobby();
  setupInput();
  animate();
}

init();
