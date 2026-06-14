import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants (must match server) ─────────────────────────────────────────────
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
  ballista: { cost: 60,  sellValue: 30, range: 3.5, color: 0x8d6e63 },
  cannon:   { cost: 100, sellValue: 50, range: 3.5, color: 0x455a64 },
  catapult: { cost: 150, sellValue: 75, range: 5.0, color: 0x5d4037 },
  turret:   { cost: 80,  sellValue: 40, range: 3.0, color: 0x37474f },
};

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070c18);
scene.fog = new THREE.FogExp2(0x070c18, 0.018);

// ── Camera ────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 20, 16);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.minDistance = 8;
controls.maxDistance = 38;
controls.maxPolarAngle = Math.PI / 2.1;
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// ── Lights ────────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0x334466, 2.0));

const sun = new THREE.DirectionalLight(0xfff8e1, 2.8);
sun.position.set(14, 22, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-22, right:22, top:22, bottom:-22, near:1, far:80 });
scene.add(sun);

const fillLight = new THREE.DirectionalLight(0x4466aa, 0.6);
fillLight.position.set(-10, 10, -10);
scene.add(fillLight);

// ── Stars ─────────────────────────────────────────────────────────────────────
(function addStars() {
  const N = 600;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i*3]   = (Math.random() - 0.5) * 120;
    pos[i*3+1] = Math.random() * 40 + 8;
    pos[i*3+2] = (Math.random() - 0.5) * 120;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.06 })));
})();

// ── Model Cache ───────────────────────────────────────────────────────────────
const loader = new GLTFLoader();
const cache = {};

function loadModel(url) {
  return new Promise((resolve, reject) => {
    if (cache[url]) { resolve(cache[url].clone()); return; }
    loader.load(url, (gltf) => {
      gltf.scene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      cache[url] = gltf.scene;
      resolve(gltf.scene.clone());
    }, undefined, reject);
  });
}

// ── Grid Builder ──────────────────────────────────────────────────────────────
function pathTileInfo(idx) {
  const curr = PATH[idx];
  const prev = PATH[idx - 1];
  const next = PATH[idx + 1];
  if (!prev) return { model: 'tile-spawn', rotY: 0 };
  if (!next) return { model: 'tile-end-round', rotY: 0 };
  const inDx = curr.gx - prev.gx, inDz = curr.gz - prev.gz;
  const outDx = next.gx - curr.gx, outDz = next.gz - curr.gz;
  if (inDx === outDx && inDz === outDz) {
    return { model: 'tile-straight', rotY: inDz !== 0 ? Math.PI / 2 : 0 };
  }
  // Corner — determine rotation
  let rotY = 0;
  if (inDx === 1  && outDz === 1)  rotY = Math.PI;        // E→S
  if (inDz === 1  && outDx === -1) rotY = -Math.PI / 2;   // S→W
  if (inDx === -1 && outDz === -1) rotY = 0;              // W→N
  if (inDz === -1 && outDx === 1)  rotY = Math.PI / 2;    // N→E
  if (inDx === -1 && outDz === 1)  rotY = -Math.PI / 2;   // W→S (mirror)
  if (inDz === 1  && outDx === 1)  rotY = 0;              // S→E
  if (inDx === 1  && outDz === -1) rotY = Math.PI / 2;    // E→N
  if (inDz === -1 && outDx === -1) rotY = Math.PI;        // N→W
  return { model: 'tile-corner-round', rotY };
}

const GRASS_GEO  = new THREE.BoxGeometry(CELL_SIZE - 0.04, 0.18, CELL_SIZE - 0.04);
const DIRT_GEO   = new THREE.BoxGeometry(CELL_SIZE - 0.04, 0.12, CELL_SIZE - 0.04);
const GRASS_MAT  = new THREE.MeshLambertMaterial({ color: 0x2e6e2e });
const DIRT_MAT   = new THREE.MeshLambertMaterial({ color: 0x8d6e4e });

async function buildGrid(onProgress) {
  const total = GRID_SIZE * GRID_SIZE;
  let done = 0;

  // Pre-load the unique tile models
  const modelCache = {};
  const needed = new Set(['tile', 'tile-straight', 'tile-corner-round', 'tile-spawn', 'tile-end-round']);
  for (const name of needed) {
    try {
      modelCache[name] = await loadModel(`/assets/tower-defense/${name}.glb`);
    } catch { modelCache[name] = null; }
  }

  const group = new THREE.Group();

  for (let gx = 0; gx < GRID_SIZE; gx++) {
    for (let gz = 0; gz < GRID_SIZE; gz++) {
      const isPath = PATH_SET.has(`${gx},${gz}`);
      const wpos = gridToWorld(gx, gz);
      const pathIdx = PATH.findIndex(p => p.gx === gx && p.gz === gz);

      if (isPath && pathIdx !== -1) {
        const { model: mName, rotY } = pathTileInfo(pathIdx);
        const src = modelCache[mName] || modelCache['tile-straight'];
        if (src) {
          const tile = src.clone();
          tile.position.set(wpos.x, 0, wpos.z);
          tile.rotation.y = rotY;
          group.add(tile);
        } else {
          const mesh = new THREE.Mesh(DIRT_GEO, DIRT_MAT);
          mesh.position.set(wpos.x, 0, wpos.z);
          mesh.receiveShadow = true;
          group.add(mesh);
        }
      } else {
        const src = modelCache['tile'];
        if (src) {
          const tile = src.clone();
          tile.position.set(wpos.x, 0, wpos.z);
          group.add(tile);
        } else {
          const mesh = new THREE.Mesh(GRASS_GEO, GRASS_MAT);
          mesh.position.set(wpos.x, 0, wpos.z);
          mesh.receiveShadow = true;
          group.add(mesh);
        }
      }

      done++;
      onProgress(done / total);
    }
  }

  scene.add(group);

  // Border glow ring
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-10, 0.25, -10),
      new THREE.Vector3(10, 0.25, -10),
      new THREE.Vector3(10, 0.25, 10),
      new THREE.Vector3(-10, 0.25, 10),
    ]),
    new THREE.LineBasicMaterial({ color: 0x4fc3f7, opacity: 0.3, transparent: true })
  );
  scene.add(ring);
}

// ── Hover / Range ─────────────────────────────────────────────────────────────
const hoverMesh = (() => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(CELL_SIZE - 0.08, 0.35, CELL_SIZE - 0.08),
    new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.38, depthWrite: false })
  );
  m.visible = false;
  scene.add(m);
  return m;
})();

let rangeCircle = null;
function showRange(wx, wz, radius) {
  if (rangeCircle) scene.remove(rangeCircle);
  const geo = new THREE.RingGeometry(radius - 0.06, radius + 0.06, 48);
  const mat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
  rangeCircle = new THREE.Mesh(geo, mat);
  rangeCircle.rotation.x = -Math.PI / 2;
  rangeCircle.position.set(wx, 0.22, wz);
  scene.add(rangeCircle);
}
function hideRange() {
  if (rangeCircle) { scene.remove(rangeCircle); rangeCircle = null; }
}

// ── Raycasting helpers ────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse2d = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const rayHit = new THREE.Vector3();

function screenToGrid(event) {
  mouse2d.x =  (event.clientX / window.innerWidth)  * 2 - 1;
  mouse2d.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse2d, camera);
  raycaster.ray.intersectPlane(groundPlane, rayHit);
  return {
    gx: Math.floor((rayHit.x + GRID_SIZE) / CELL_SIZE),
    gz: Math.floor((rayHit.z + GRID_SIZE) / CELL_SIZE),
    wx: rayHit.x,
    wz: rayHit.z,
  };
}

// ── State ─────────────────────────────────────────────────────────────────────
let socket;
let state = null;
let selectedTower = null;
let selectedTowerId = null;
let myId = null;
let roomCode = null;
let betweenWavesTimer = null;

const enemyObjs  = new Map(); // id → { group, targetPos }
const towerObjs  = new Map(); // id → group
const bulletObjs = new Map(); // id → group
const enemyTargets = new Map(); // id → THREE.Vector3 (for interpolation)

// ── Enemy Meshes ──────────────────────────────────────────────────────────────
const UFO_FALLBACK_COLORS = {
  'ufo-a': 0x4fc3f7, 'ufo-b': 0xe040fb,
  'ufo-c': 0xffd740, 'ufo-d': 0xff5252,
};

async function makeEnemyGroup(enemy) {
  const g = new THREE.Group();
  try {
    const m = await loadModel(`/assets/tower-defense/${enemy.model}.glb`);
    m.scale.setScalar(1.1);
    g.add(m);
  } catch {
    const color = UFO_FALLBACK_COLORS[enemy.type] || 0x4fc3f7;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.2, 0.28, 10), new THREE.MeshLambertMaterial({ color }));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xaaddff, transparent: true, opacity: 0.7 }));
    dome.position.y = 0.14;
    g.add(disc); g.add(dome);
  }

  // Health bar background
  const hbBg = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.13), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, depthTest: false }));
  hbBg.position.set(0, 2.0, 0);
  hbBg.rotation.x = -Math.PI / 5;
  hbBg.renderOrder = 1;
  // Health bar fill
  const hbFill = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.13), new THREE.MeshBasicMaterial({ color: 0x4caf50, depthTest: false }));
  hbFill.position.set(0, 2.01, 0.01);
  hbFill.rotation.x = -Math.PI / 5;
  hbFill.userData.isHpBar = true;
  hbFill.renderOrder = 2;
  g.add(hbBg); g.add(hbFill);

  // Point light for glow
  const glow = new THREE.PointLight(UFO_FALLBACK_COLORS[enemy.type] || 0x4fc3f7, 0.7, 3.5);
  glow.position.set(0, 0.2, 0);
  g.add(glow);

  return g;
}

function updateHpBar(group, ratio) {
  const bar = group.children.find(c => c.userData?.isHpBar);
  if (!bar) return;
  bar.scale.x = Math.max(0.001, ratio);
  bar.position.x = -(1.1 * (1 - ratio)) / 2;
  bar.material.color.setHex(ratio > 0.5 ? 0x4caf50 : ratio > 0.25 ? 0xffd740 : 0xf44336);
}

// ── Tower Meshes ──────────────────────────────────────────────────────────────
async function makeTowerGroup(tower) {
  const g = new THREE.Group();
  const wp = gridToWorld(tower.gx, tower.gz);
  g.position.set(wp.x, 0, wp.z);
  g.userData.towerId = tower.id;

  try {
    const base = await loadModel('/assets/tower-defense/tower-round-base.glb');
    g.add(base);
  } catch { /* no base */ }

  try {
    const weapon = await loadModel(`/assets/tower-defense/weapon-${tower.type}.glb`);
    weapon.position.y = 0.5;
    g.add(weapon);
  } catch {
    const color = TOWER_UI[tower.type]?.color || 0x546e7a;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.0, 8), new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.5;
    g.add(body);
  }

  // Owner color dot on top
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 6, 6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(tower.ownerColor) })
  );
  dot.position.y = 1.6;
  g.add(dot);

  return g;
}

// ── Bullet Meshes ─────────────────────────────────────────────────────────────
const BULLET_CFG = {
  ballista: { color: 0xd4a84b, r: 0.09 },
  cannon:   { color: 0x263238, r: 0.18 },
  catapult: { color: 0x6d4c41, r: 0.22 },
  turret:   { color: 0xffd740, r: 0.07 },
};

function makeBulletGroup(towerType) {
  const cfg = BULLET_CFG[towerType] || { color: 0xffffff, r: 0.1 };
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(cfg.r, 6, 6), new THREE.MeshBasicMaterial({ color: cfg.color }));
  const light = new THREE.PointLight(cfg.color, 1.2, 2.5);
  g.add(mesh); g.add(light);
  return g;
}

// ── Scene Sync ────────────────────────────────────────────────────────────────
async function syncScene(s) {
  // Enemies
  const liveIds = new Set(s.enemies.map(e => e.id));
  for (const [id, { group }] of enemyObjs) {
    if (!liveIds.has(id)) { scene.remove(group); enemyObjs.delete(id); enemyTargets.delete(id); }
  }
  for (const e of s.enemies) {
    const target = new THREE.Vector3(e.x, e.y, e.z);
    if (!enemyObjs.has(e.id)) {
      const group = await makeEnemyGroup(e);
      group.position.copy(target);
      scene.add(group);
      enemyObjs.set(e.id, { group, model: e.model });
    }
    enemyTargets.set(e.id, target);
    // Face direction of travel
    const pathIdx = e.pathIndex;
    if (pathIdx < PATH.length - 1) {
      const c = PATH[pathIdx], n = PATH[pathIdx + 1];
      enemyObjs.get(e.id).group.rotation.y = Math.atan2(-(n.gx - c.gx), -(n.gz - c.gz));
    }
    updateHpBar(enemyObjs.get(e.id).group, e.hp / e.maxHp);
  }

  // Towers
  const liveTIds = new Set(s.towers.map(t => t.id));
  for (const [id, g] of towerObjs) {
    if (!liveTIds.has(id)) { scene.remove(g); towerObjs.delete(id); }
  }
  for (const t of s.towers) {
    if (!towerObjs.has(t.id)) {
      const g = await makeTowerGroup(t);
      scene.add(g);
      towerObjs.set(t.id, g);
    }
  }

  // Bullets
  const liveBIds = new Set(s.bullets.map(b => b.id));
  for (const [id, g] of bulletObjs) {
    if (!liveBIds.has(id)) { scene.remove(g); bulletObjs.delete(id); }
  }
  for (const b of s.bullets) {
    if (!bulletObjs.has(b.id)) {
      const g = makeBulletGroup(b.towerType);
      scene.add(g);
      bulletObjs.set(b.id, g);
    }
    bulletObjs.get(b.id).position.set(b.x, b.y, b.z);
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function updateUI(s) {
  document.getElementById('gold-display').textContent  = s.gold;
  document.getElementById('lives-display').textContent = s.lives;
  document.getElementById('wave-display').textContent  = s.wave;
  document.getElementById('total-waves').textContent   = s.totalWaves;
  document.getElementById('score-display').textContent = s.score;

  document.getElementById('lives-display').style.color = s.lives <= 5 ? '#f44336' : '';

  if (roomCode) document.getElementById('room-tag').textContent = `ROOM ${roomCode}`;

  // Players bar
  const pb = document.getElementById('players-bar');
  pb.innerHTML = '';
  for (const p of s.players) {
    const badge = document.createElement('div');
    badge.className = 'player-badge';
    badge.style.borderLeft = `3px solid ${p.color}`;
    badge.textContent = p.name;
    pb.appendChild(badge);
  }

  // Tower affordability
  document.querySelectorAll('.tower-btn').forEach(btn => {
    const cost = parseInt(btn.dataset.cost);
    btn.classList.toggle('cant-afford', s.gold < cost);
    btn.classList.toggle('active', selectedTower === btn.dataset.tower);
  });
}

let bwInterval = null;
function handleBetweenWaves(s) {
  const bwEl = document.getElementById('between-waves-ui');
  if (s.betweenWaves && s.phase === 'playing') {
    bwEl.classList.remove('hidden');
    document.getElementById('bw-title').textContent = `Wave ${s.wave} Complete! Next wave in...`;
    let t = 6;
    clearInterval(bwInterval);
    bwInterval = setInterval(() => {
      t--;
      document.getElementById('bw-countdown').textContent = t > 0 ? `${t}s` : 'Incoming!';
      if (t <= 0) { clearInterval(bwInterval); bwEl.classList.add('hidden'); }
    }, 1000);
  } else if (!s.betweenWaves) {
    bwEl.classList.add('hidden');
    clearInterval(bwInterval);
  }
}

function showBanner(text) {
  const el = document.getElementById('wave-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = 'bannerAnim 3.5s forwards';
  setTimeout(() => el.classList.add('hidden'), 3600);
}

function addMsg(text, color = '#90caf9') {
  const log = document.getElementById('msg-log');
  const el = document.createElement('div');
  el.className = 'msg';
  el.style.color = color;
  el.textContent = text;
  log.prepend(el);
  setTimeout(() => el.remove(), 3100);
}

function showSellPanel(tower) {
  const sv = TOWER_UI[tower.type]?.sellValue || 0;
  document.getElementById('sell-info').textContent =
    `${tower.type.toUpperCase()} (owner: ${tower.owner}) — Sell for ${sv}g`;
  document.getElementById('sell-panel').classList.remove('hidden');
  document.getElementById('selection-info').textContent = '';
}
function hideSellPanel() {
  document.getElementById('sell-panel').classList.add('hidden');
  document.getElementById('selection-info').textContent =
    'Click tower above, then click map to place. Right-click to cancel.';
}

// ── Input ─────────────────────────────────────────────────────────────────────
function setupInput() {
  document.querySelectorAll('.tower-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tower;
      selectedTower = selectedTower === t ? null : t;
      selectedTowerId = null;
      hideSellPanel();
      if (!selectedTower) hideRange();
      if (state) updateUI(state);
    });
  });

  canvas.addEventListener('click', e => {
    if (!state || state.phase !== 'playing') return;
    if (e.target !== canvas) return;
    const { gx, gz, wx, wz } = screenToGrid(e);

    if (selectedTower) {
      socket.emit('place-tower', { type: selectedTower, gx, gz });
    } else {
      // Select placed tower
      const t = state.towers.find(t => t.gx === gx && t.gz === gz);
      if (t) {
        selectedTowerId = t.id;
        showSellPanel(t);
        showRange(gridToWorld(t.gx, t.gz).x, gridToWorld(t.gx, t.gz).z, TOWER_UI[t.type].range * CELL_SIZE);
      } else {
        selectedTowerId = null;
        hideSellPanel();
        hideRange();
      }
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!state || state.phase !== 'playing' || !selectedTower) {
      hoverMesh.visible = false;
      return;
    }
    const { gx, gz, wx, wz } = screenToGrid(e);
    if (gx >= 0 && gx < GRID_SIZE && gz >= 0 && gz < GRID_SIZE) {
      const wp = gridToWorld(gx, gz);
      hoverMesh.position.set(wp.x, 0.18, wp.z);
      hoverMesh.visible = true;
      const bad = PATH_SET.has(`${gx},${gz}`) || state.towers.some(t => t.gx === gx && t.gz === gz);
      hoverMesh.material.color.setHex(bad ? 0xff2222 : 0x00ff88);
      showRange(wp.x, wp.z, TOWER_UI[selectedTower].range * CELL_SIZE);
    } else {
      hoverMesh.visible = false;
      hideRange();
    }
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    selectedTower = null;
    selectedTowerId = null;
    hideSellPanel();
    hoverMesh.visible = false;
    hideRange();
    if (state) updateUI(state);
  });

  document.getElementById('btn-sell').addEventListener('click', () => {
    if (selectedTowerId != null) {
      socket.emit('sell-tower', { towerId: selectedTowerId });
      selectedTowerId = null;
      hideSellPanel();
      hideRange();
    }
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
    myId = playerId;
    roomCode = code;
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
    myId = playerId;
    roomCode = code;
    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('waiting-room').classList.remove('hidden');
    document.getElementById('room-code-show').textContent = code;
    socket.emit('request-state');
  });

  socket.on('join-error', ({ message }) => {
    document.getElementById('lobby-error').textContent = message;
  });

  socket.on('player-joined', ({ name }) => {
    addMsg(`${name} joined the game!`, '#a5d6a7');
  });

  socket.on('player-left', () => {
    addMsg('A player left the game.', '#ffcc80');
  });

  socket.on('game-state', s => {
    const wasLobby = !state || state.phase === 'lobby';
    state = s;

    if (s.phase === 'playing' || s.phase === 'lobby') {
      if (wasLobby && s.phase === 'playing') {
        document.getElementById('waiting-room').classList.add('hidden');
        document.getElementById('game-ui').classList.remove('hidden');
        document.getElementById('end-screen').classList.add('hidden');
      }
      updateUI(s);
      handleBetweenWaves(s);
      syncScene(s);
    }
  });

  socket.on('wave-start', ({ wave }) => {
    showBanner(`WAVE ${wave}`);
    addMsg(`Wave ${wave} incoming!`, '#f48fb1');
  });

  socket.on('wave-complete', ({ wave, bonusGold }) => {
    showBanner(`WAVE ${wave} CLEARED  +${bonusGold}g`);
    addMsg(`Bonus: +${bonusGold} gold`, '#ffe082');
  });

  socket.on('game-over', ({ victory, score }) => {
    document.getElementById('end-screen').classList.remove('hidden');
    document.getElementById('game-ui').classList.add('hidden');
    const title = document.getElementById('end-title');
    title.textContent = victory ? 'VICTORY!' : 'GAME OVER';
    title.style.color = victory ? '#66bb6a' : '#ef5350';
    document.getElementById('end-score').textContent = `Final Score: ${score}`;
  });

  socket.on('action-error', ({ message }) => {
    addMsg(message, '#ef5350');
  });
}

// ── Render Loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  // Interpolate enemies smoothly between server ticks
  for (const [id, { group }] of enemyObjs) {
    const target = enemyTargets.get(id);
    if (target) {
      group.position.x = THREE.MathUtils.lerp(group.position.x, target.x, 0.22);
      group.position.z = THREE.MathUtils.lerp(group.position.z, target.z, 0.22);
      group.position.y = target.y + Math.sin(t * 2.5 + id * 0.7) * 0.12;
    }
    // Spin the UFO models
    const model = group.children[0];
    if (model && model.isGroup) model.rotation.y += dt * 1.2;
  }

  // Gentle tower weapon rotation
  for (const [, g] of towerObjs) {
    // Weapon is child index 1 (after base)
    const weapon = g.children[1];
    if (weapon && state) {
      const t = state.towers.find(tt => tt.gx != null && towerObjs.get(tt.id) === g);
      // Just keep them looking interesting
      if (weapon.isGroup) {
        const enemy = state?.enemies[0];
        if (enemy) {
          const dir = new THREE.Vector3(enemy.x - g.position.x, 0, enemy.z - g.position.z);
          if (dir.length() > 0.1) weapon.rotation.y = Math.atan2(dir.x, dir.z);
        }
      }
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

// ── Progress Bar ──────────────────────────────────────────────────────────────
function setProgress(p) {
  document.getElementById('loading-bar').style.width = `${Math.round(p * 100)}%`;
}
function setLoadingText(t) {
  document.getElementById('loading-text').textContent = t;
}

// ── Window resize ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setLoadingText('Building the battlefield...');
  await buildGrid(p => setProgress(p * 0.8));
  setProgress(0.9);
  setLoadingText('Charging weapons...');

  // Pre-warm enemy/tower model loading
  const preload = [
    '/assets/tower-defense/enemy-ufo-a.glb',
    '/assets/tower-defense/enemy-ufo-b.glb',
    '/assets/tower-defense/enemy-ufo-c.glb',
    '/assets/tower-defense/enemy-ufo-d.glb',
    '/assets/tower-defense/weapon-ballista.glb',
    '/assets/tower-defense/weapon-cannon.glb',
    '/assets/tower-defense/weapon-catapult.glb',
    '/assets/tower-defense/weapon-turret.glb',
    '/assets/tower-defense/tower-round-base.glb',
  ];
  let loaded = 0;
  await Promise.allSettled(preload.map(url =>
    loadModel(url).then(() => { loaded++; setProgress(0.9 + (loaded / preload.length) * 0.1); })
  ));

  setProgress(1.0);
  setLoadingText('Ready!');

  setTimeout(() => {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('lobby').classList.remove('hidden');
  }, 400);

  initSocket();
  setupLobby();
  setupInput();
  animate();
}

init();
