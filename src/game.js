import {
  ARENA,
  RULES,
  TEAM_BLACK,
  TEAM_META,
  TEAM_WHITE,
  clamp,
  distSq,
  fmtTime,
  loadProfile
} from './common.js';
import { NetClient } from './network.js';

const canvas = document.getElementById('arena');
const errorEl = document.getElementById('error');
const statEl = {
  room: document.getElementById('room-stat'),
  peers: document.getElementById('peers-stat'),
  me: document.getElementById('me-stat'),
  timer: document.getElementById('timer-stat'),
  black: document.getElementById('black-score'),
  white: document.getElementById('white-score'),
  status: document.getElementById('status-stat'),
  feed: document.getElementById('event-feed')
};

const profile = loadProfile();
const params = new URLSearchParams(location.search);
const room = params.get('room') || profile.roomCode;
const role = params.get('role') || profile.role;
if (!room || !role || !profile.username) location.href = './join.html';

const obstacles = [
  { x: -20, z: -20, w: 8, d: 8, h: 3 },
  { x: 10, z: 16, w: 12, d: 6, h: 3 },
  { x: 0, z: 0, w: 7, d: 22, h: 4 },
  { x: -42, z: 19, w: 10, d: 8, h: 3 },
  { x: 37, z: -16, w: 9, d: 10, h: 4 },
  { x: 28, z: 30, w: 7, d: 7, h: 5 }
];

const state = {
  mePeerId: null,
  match: null,
  inputs: { forward: false, back: false, left: false, right: false, jump: false, yaw: 0, pitch: 0 },
  seq: 0,
  pointerLocked: false,
  connectedPlayers: 1
};

const render = {
  engine: null,
  scene: null,
  camera: null,
  adt: null,
  playerMeshes: new Map(),
  nameplates: new Map(),
  flagMeshes: new Map()
};

const net = new NetClient({
  onState: (payload) => {
    state.match = payload;
  },
  onEvent: (msg, from) => onMessage(msg, from),
  onPeerChange: (count) => {
    state.connectedPlayers = count;
    statEl.peers.textContent = String(count);
  }
});

function pushFeed(text) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  statEl.feed.prepend(line);
  while (statEl.feed.children.length > 35) statEl.feed.removeChild(statEl.feed.lastChild);
}

function mkFlags() {
  return {
    [TEAM_BLACK]: { team: TEAM_BLACK, x: TEAM_META[TEAM_BLACK].base.x, y: ARENA.floorY, z: TEAM_META[TEAM_BLACK].base.z, holderId: null, atBase: true },
    [TEAM_WHITE]: { team: TEAM_WHITE, x: TEAM_META[TEAM_WHITE].base.x, y: ARENA.floorY, z: TEAM_META[TEAM_WHITE].base.z, holderId: null, atBase: true }
  };
}

function createMatch(hostPeerId) {
  return {
    hostPeerId,
    startedAt: Date.now(),
    endsAt: Date.now() + RULES.matchSeconds * 1000,
    scores: { [TEAM_BLACK]: 0, [TEAM_WHITE]: 0 },
    players: {},
    flags: mkFlags(),
    winner: null,
    events: []
  };
}

function assignTeam(match) {
  const counts = { [TEAM_BLACK]: 0, [TEAM_WHITE]: 0 };
  Object.values(match.players).forEach((p) => counts[p.team]++);
  return counts[TEAM_BLACK] <= counts[TEAM_WHITE] ? TEAM_BLACK : TEAM_WHITE;
}

function spawnFor(team) {
  const base = TEAM_META[team].spawn;
  return { x: base.x, y: base.y, z: base.z };
}

function addPlayer(match, id, username, color, forcedTeam = null) {
  const team = forcedTeam || assignTeam(match);
  const spawn = spawnFor(team);
  match.players[id] = {
    id,
    username,
    color,
    team,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    vy: 0,
    onGround: true,
    yaw: team === TEAM_BLACK ? 0 : Math.PI,
    pitch: 0,
    tagCooldownUntil: 0,
    respawnUntil: Date.now() + 600,
    carryingFlagOf: null,
    input: { forward: false, back: false, left: false, right: false, jump: false, yaw: 0, pitch: 0 }
  };
}

function dropFlag(match, playerId, resetToBase = false) {
  const player = match.players[playerId];
  if (!player || !player.carryingFlagOf) return;
  const enemyTeam = player.carryingFlagOf;
  const flag = match.flags[enemyTeam];
  player.carryingFlagOf = null;

  if (resetToBase) {
    flag.holderId = null;
    flag.atBase = true;
    flag.x = TEAM_META[enemyTeam].base.x;
    flag.y = ARENA.floorY;
    flag.z = TEAM_META[enemyTeam].base.z;
  } else {
    flag.holderId = null;
    flag.atBase = false;
    flag.x = player.x;
    flag.y = ARENA.floorY;
    flag.z = player.z;
  }
}

function removePlayer(match, id) {
  if (!match.players[id]) return;
  dropFlag(match, id, true);
  delete match.players[id];
}

function addEvent(match, text) {
  match.events.unshift({ t: Date.now(), text });
  match.events = match.events.slice(0, 30);
}

function respawnPlayer(match, playerId, reason) {
  const p = match.players[playerId];
  if (!p) return;
  dropFlag(match, playerId, true);
  const spawn = spawnFor(p.team);
  p.x = spawn.x;
  p.y = spawn.y;
  p.z = spawn.z;
  p.vy = 0;
  p.onGround = true;
  p.respawnUntil = Date.now() + RULES.respawnInvulnMs;
  addEvent(match, `${p.username} was tagged (${reason})`);
}

function obstacleCollision(nx, nz, radius) {
  return obstacles.some((o) => nx + radius > o.x - o.w / 2 && nx - radius < o.x + o.w / 2 && nz + radius > o.z - o.d / 2 && nz - radius < o.z + o.d / 2);
}

function processMovement(player, dt) {
  player.yaw = player.input.yaw;
  player.pitch = player.input.pitch;

  const forward = (player.input.forward ? 1 : 0) - (player.input.back ? 1 : 0);
  const strafe = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);

  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  const worldX = forward * sin + strafe * cos;
  const worldZ = forward * cos - strafe * sin;
  const mag = Math.hypot(worldX, worldZ) || 1;

  const speed = player.carryingFlagOf ? RULES.moveSpeed * RULES.carrierSpeedMultiplier : RULES.moveSpeed;
  const moveX = (worldX / mag) * speed * dt;
  const moveZ = (worldZ / mag) * speed * dt;

  let nextX = clamp(player.x + moveX, -ARENA.width / 2 + ARENA.playerRadius, ARENA.width / 2 - ARENA.playerRadius);
  let nextZ = clamp(player.z + moveZ, -ARENA.depth / 2 + ARENA.playerRadius, ARENA.depth / 2 - ARENA.playerRadius);

  if (!obstacleCollision(nextX, player.z, ARENA.playerRadius)) player.x = nextX;
  if (!obstacleCollision(player.x, nextZ, ARENA.playerRadius)) player.z = nextZ;

  if (player.input.jump && player.onGround) {
    player.vy = RULES.jumpVelocity;
    player.onGround = false;
  }

  player.vy -= RULES.gravity * dt;
  player.y += player.vy * dt;

  if (player.y <= ARENA.floorY) {
    player.y = ARENA.floorY;
    player.vy = 0;
    player.onGround = true;
  }
}

function processTick(match, dt) {
  const now = Date.now();
  Object.values(match.players).forEach((p) => processMovement(p, dt));

  Object.values(match.flags).forEach((flag) => {
    if (flag.holderId && match.players[flag.holderId]) {
      const holder = match.players[flag.holderId];
      flag.x = holder.x;
      flag.y = holder.y + 1.2;
      flag.z = holder.z;
      flag.atBase = false;
    }
  });

  Object.values(match.players).forEach((p) => {
    if (now < p.respawnUntil) return;
    const enemy = p.team === TEAM_BLACK ? TEAM_WHITE : TEAM_BLACK;
    const enemyFlag = match.flags[enemy];

    if (!p.carryingFlagOf && !enemyFlag.holderId && distSq(p, enemyFlag) <= (ARENA.playerRadius + ARENA.flagRadius) ** 2) {
      p.carryingFlagOf = enemy;
      enemyFlag.holderId = p.id;
      enemyFlag.atBase = false;
      addEvent(match, `${p.username} took ${TEAM_META[enemy].label} flag`);
    }

    if (p.carryingFlagOf) {
      const homeFlag = match.flags[p.team];
      const base = TEAM_META[p.team].base;
      if (homeFlag.atBase && distSq(p, base) <= 7 * 7) {
        match.scores[p.team] += 1;
        p.carryingFlagOf = null;
        match.flags = mkFlags();
        addEvent(match, `${p.username} captured for ${TEAM_META[p.team].label}`);
        if (match.scores[p.team] >= RULES.maxScore) {
          match.winner = p.team;
          match.endsAt = Date.now();
          addEvent(match, `${TEAM_META[p.team].label} wins!`);
        }
      }
    }
  });

  const players = Object.values(match.players);
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i];
      const b = players[j];
      if (a.team === b.team) continue;
      if (distSq(a, b) > ARENA.tagRange * ARENA.tagRange) continue;

      const aCanTag = now > a.tagCooldownUntil && now > a.respawnUntil;
      const bCanTag = now > b.tagCooldownUntil && now > b.respawnUntil;
      if (!aCanTag && !bCanTag) continue;

      if (aCanTag) {
        a.tagCooldownUntil = now + RULES.tagCooldownMs;
        respawnPlayer(match, b.id, `by ${a.username}`);
      } else if (bCanTag) {
        b.tagCooldownUntil = now + RULES.tagCooldownMs;
        respawnPlayer(match, a.id, `by ${b.username}`);
      }
    }
  }

  if (Date.now() >= match.endsAt && !match.winner) {
    match.winner =
      match.scores[TEAM_BLACK] === match.scores[TEAM_WHITE]
        ? 'draw'
        : match.scores[TEAM_BLACK] > match.scores[TEAM_WHITE]
          ? TEAM_BLACK
          : TEAM_WHITE;
  }
}

function onMessage(msg, fromPeerId) {
  if (!msg?.type) return;
  if (msg.type === 'disconnect') {
    statEl.status.textContent = 'Disconnected';
    return;
  }

  if (role !== 'host') return;
  const match = state.match;
  if (!match) return;

  if (msg.type === 'join-request') {
    addPlayer(match, fromPeerId, msg.payload.username, msg.payload.color);
    addEvent(match, `${msg.payload.username} joined`);
  }

  if (msg.type === 'input') {
    const player = match.players[fromPeerId];
    if (player) player.input = msg.payload;
  }

  if (msg.type === 'peer-left') {
    const name = match.players[msg.peerId]?.username || msg.peerId;
    removePlayer(match, msg.peerId);
    addEvent(match, `${name} left`);
  }
}

function createScene() {
  render.engine = new BABYLON.Engine(canvas, true);
  render.scene = new BABYLON.Scene(render.engine);
  render.scene.clearColor = new BABYLON.Color4(0.06, 0.09, 0.16, 1);

  const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), render.scene);
  light.intensity = 0.95;

  const dir = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -1, 0.2), render.scene);
  dir.position = new BABYLON.Vector3(30, 40, -20);
  dir.intensity = 0.45;

  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: ARENA.width, height: ARENA.depth }, render.scene);
  const gMat = new BABYLON.StandardMaterial('ground-mat', render.scene);
  gMat.diffuseColor = new BABYLON.Color3(0.12, 0.15, 0.24);
  gMat.specularColor = new BABYLON.Color3(0, 0, 0);
  ground.material = gMat;

  const stripe = BABYLON.MeshBuilder.CreateGround('stripe', { width: 1.5, height: ARENA.depth }, render.scene);
  stripe.position.y = 0.01;
  const sMat = new BABYLON.StandardMaterial('stripe-mat', render.scene);
  sMat.diffuseColor = new BABYLON.Color3(0.75, 0.8, 1);
  stripe.material = sMat;

  obstacles.forEach((o, idx) => {
    const box = BABYLON.MeshBuilder.CreateBox(`obs-${idx}`, { width: o.w, depth: o.d, height: o.h }, render.scene);
    box.position = new BABYLON.Vector3(o.x, o.h / 2, o.z);
    const mat = new BABYLON.StandardMaterial(`obs-mat-${idx}`, render.scene);
    mat.diffuseColor = new BABYLON.Color3(0.25, 0.29, 0.42);
    box.material = mat;
  });

  const blackBase = BABYLON.MeshBuilder.CreateCylinder('black-base', { diameter: 9, height: 0.6 }, render.scene);
  blackBase.position = new BABYLON.Vector3(TEAM_META[TEAM_BLACK].base.x, 0.3, TEAM_META[TEAM_BLACK].base.z);
  const blackMat = new BABYLON.StandardMaterial('black-base-mat', render.scene);
  blackMat.diffuseColor = new BABYLON.Color3(0.09, 0.09, 0.09);
  blackBase.material = blackMat;

  const whiteBase = BABYLON.MeshBuilder.CreateCylinder('white-base', { diameter: 9, height: 0.6 }, render.scene);
  whiteBase.position = new BABYLON.Vector3(TEAM_META[TEAM_WHITE].base.x, 0.3, TEAM_META[TEAM_WHITE].base.z);
  const whiteMat = new BABYLON.StandardMaterial('white-base-mat', render.scene);
  whiteMat.diffuseColor = new BABYLON.Color3(0.92, 0.92, 0.92);
  whiteBase.material = whiteMat;

  render.flagMeshes.set(TEAM_BLACK, BABYLON.MeshBuilder.CreateBox('flag-black', { size: 1.6 }, render.scene));
  render.flagMeshes.set(TEAM_WHITE, BABYLON.MeshBuilder.CreateBox('flag-white', { size: 1.6 }, render.scene));
  const fbMat = new BABYLON.StandardMaterial('fb', render.scene);
  fbMat.diffuseColor = new BABYLON.Color3(0.06, 0.06, 0.06);
  render.flagMeshes.get(TEAM_BLACK).material = fbMat;
  const fwMat = new BABYLON.StandardMaterial('fw', render.scene);
  fwMat.diffuseColor = new BABYLON.Color3(0.95, 0.95, 0.95);
  render.flagMeshes.get(TEAM_WHITE).material = fwMat;

  render.camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, 4, -10), render.scene);
  render.camera.fov = 1.05;
  render.camera.minZ = 0.1;

  render.adt = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI('ui', true, render.scene);

  canvas.addEventListener('click', async () => {
    await canvas.requestPointerLock?.();
  });

  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked = document.pointerLockElement === canvas;
  });

  document.addEventListener('mousemove', (e) => {
    if (!state.pointerLocked) return;
    state.inputs.yaw += e.movementX * 0.0026;
    state.inputs.pitch = clamp(state.inputs.pitch + e.movementY * 0.0018, -1.15, 1.15);
    sendInput();
  });

  render.engine.runRenderLoop(() => {
    if (state.match) {
      syncMeshes();
      updateHud(state.match);
    }
    render.scene.render();
  });

  window.addEventListener('resize', () => render.engine.resize());
}

function ensurePlayerMesh(player) {
  if (render.playerMeshes.has(player.id)) return;

  const body = BABYLON.MeshBuilder.CreateCapsule(`p-${player.id}`, { radius: ARENA.playerRadius, height: ARENA.playerHeight }, render.scene);
  const mat = new BABYLON.StandardMaterial(`pm-${player.id}`, render.scene);
  mat.diffuseColor = BABYLON.Color3.FromHexString(player.color || '#4dd8ff');
  body.material = mat;
  render.playerMeshes.set(player.id, body);

  const panel = new BABYLON.GUI.Rectangle(`tag-${player.id}`);
  panel.background = 'rgba(0,0,0,0.45)';
  panel.height = '28px';
  panel.width = '130px';
  panel.cornerRadius = 10;
  panel.thickness = 1;
  panel.color = 'white';
  render.adt.addControl(panel);
  panel.linkWithMesh(body);
  panel.linkOffsetY = -62;

  const text = new BABYLON.GUI.TextBlock(`tag-text-${player.id}`, player.username);
  text.fontSize = 14;
  text.color = 'white';
  panel.addControl(text);

  render.nameplates.set(player.id, panel);
}

function cleanupPlayerMesh(id) {
  render.playerMeshes.get(id)?.dispose();
  render.nameplates.get(id)?.dispose();
  render.playerMeshes.delete(id);
  render.nameplates.delete(id);
}

function syncMeshes() {
  const match = state.match;
  const ids = new Set(Object.keys(match.players));

  render.playerMeshes.forEach((_, id) => {
    if (!ids.has(id)) cleanupPlayerMesh(id);
  });

  Object.values(match.players).forEach((p) => {
    ensurePlayerMesh(p);
    const mesh = render.playerMeshes.get(p.id);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = p.yaw;
    mesh.material.diffuseColor = BABYLON.Color3.FromHexString(p.color || '#4dd8ff');

    if (p.id === state.mePeerId) {
      const eye = new BABYLON.Vector3(p.x, p.y + 1.35, p.z);
      const forward = new BABYLON.Vector3(Math.sin(state.inputs.yaw), -state.inputs.pitch * 0.6, Math.cos(state.inputs.yaw));
      render.camera.position = eye;
      render.camera.setTarget(eye.add(forward));
    }
  });

  Object.values(match.flags).forEach((flag) => {
    const mesh = render.flagMeshes.get(flag.team);
    mesh.position.set(flag.x, flag.y + 0.9, flag.z);
  });
}

function updateHud(match) {
  statEl.room.textContent = room;
  statEl.black.textContent = String(match.scores[TEAM_BLACK]);
  statEl.white.textContent = String(match.scores[TEAM_WHITE]);
  statEl.timer.textContent = fmtTime((match.endsAt - Date.now()) / 1000);

  const me = match.players[state.mePeerId];
  if (me) {
    statEl.me.innerHTML = `${me.username} <span class="tag ${me.team}-team">${TEAM_META[me.team].label}</span>`;
  }

  const status = match.winner
    ? match.winner === 'draw'
      ? 'Draw'
      : `${TEAM_META[match.winner].label} won`
    : role === 'host'
      ? 'Hosting'
      : 'Connected';
  statEl.status.textContent = status;

  const latest = match.events
    .slice(0, 8)
    .map((e) => `<div>${new Date(e.t).toLocaleTimeString()} - ${e.text}</div>`)
    .join('');
  statEl.feed.innerHTML = latest || '<div class="small">No events yet.</div>';
}

function setInput(key, pressed) {
  if (key === 'w') state.inputs.forward = pressed;
  if (key === 's') state.inputs.back = pressed;
  if (key === 'a') state.inputs.left = pressed;
  if (key === 'd') state.inputs.right = pressed;
  if (key === ' ') state.inputs.jump = pressed;
  sendInput();
}

function sendInput() {
  if (role === 'host') return;
  net.sendToHost({ type: 'input', payload: state.inputs, seq: ++state.seq });
}

window.addEventListener('keydown', (e) => setInput(e.key.toLowerCase(), true));
window.addEventListener('keyup', (e) => setInput(e.key.toLowerCase(), false));
window.addEventListener('beforeunload', () => net.close());

async function start() {
  createScene();

  try {
    if (role === 'host') {
      await net.host(room);
      state.mePeerId = net.peer.id;
      state.match = createMatch(state.mePeerId);
      addPlayer(state.match, state.mePeerId, profile.username, profile.color, TEAM_BLACK);
      addEvent(state.match, `${profile.username} is hosting room ${room}`);
    } else {
      await net.join(room);
      state.mePeerId = net.peer.id;
      net.sendToHost({ type: 'join-request', payload: { username: profile.username, color: profile.color } });
      setInterval(sendInput, 50);
    }
  } catch (err) {
    errorEl.textContent = `Network error: ${err.message}`;
    return;
  }

  let last = performance.now();
  let accum = 0;
  const step = 1 / RULES.tickRate;

  const hostLoop = () => {
    if (!state.match || role !== 'host') return;
    const me = state.match.players[state.mePeerId];
    if (me) me.input = state.inputs;

    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    accum += dt;

    while (accum >= step) {
      processTick(state.match, step);
      accum -= step;
    }

    net.broadcast({ type: 'state', payload: state.match });
  };

  setInterval(hostLoop, 1000 / RULES.tickRate);
}

start();
