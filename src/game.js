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
import { createFlag } from "./flag.js";

// create flags
const blackFlag = createFlag(scene, {
  position: new BABYLON.Vector3(-20, 0, 0),
  color: new BABYLON.Color3(0.1, 0.1, 0.1)
});

const whiteFlag = createFlag(scene, {
  position: new BABYLON.Vector3(20, 0, 0),
  color: new BABYLON.Color3(1, 1, 1)
});

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
  { x: -20, z: -20, w: 8, d: 8, h: 3, rotX: 0.2, rotY: 0.3, rotZ: 0.1, color: [0.8, 0.3, 0.3] },
  { x: 10, z: 16, w: 12, d: 6, h: 3, rotX: 0.0, rotY: 1.2, rotZ: 0.4, color: [0.3, 0.8, 0.4] },
  { x: 0, z: 0, w: 7, d: 22, h: 4, rotX: 0.5, rotY: 0.6, rotZ: 0.2, color: [0.3, 0.5, 0.9] },
  { x: -42, z: 19, w: 10, d: 8, h: 3, rotX: 0.1, rotY: 2.0, rotZ: 0.3, color: [0.9, 0.8, 0.3] },
  { x: 37, z: -16, w: 9, d: 10, h: 4, rotX: 0.3, rotY: 0.9, rotZ: 0.6, color: [0.6, 0.3, 0.8] },
  { x: 28, z: 30, w: 7, d: 7, h: 5, rotX: 0.7, rotY: 1.5, rotZ: 0.2, color: [0.2, 0.9, 0.9] }
];

const state = {
  mePeerId: null,
  match: null,
  localPlayer: null,
  inputs: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, hideTags: false, yaw: 0, pitch: 0 },
  pointerLocked: false,
  connectedPlayers: 1,
  lastFrameMs: performance.now(),
  lastPoseSentAt: 0
};

const security = {
  peers: new Map() // peerId -> {lastPoseAt,lastX,lastY,lastZ,strikes}
};

const render = {
  engine: null,
  scene: null,
  camera: null,
  adt: null,
  playerMeshes: new Map(),
  nameplates: new Map(),
  flagMeshes: new Map(),
  interpolatedPlayers: new Map(),
  obstacleMeshes: []
};

const net = new NetClient({
  onState: (payload) => applyIncomingState(payload),
  onEvent: (msg, from) => onMessage(msg, from),
  onPeerChange: (count) => {
    state.connectedPlayers = count;
    statEl.peers.textContent = String(count);
  }
});

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

function newPlayerState(id, username, color, team) {
  const spawn = spawnFor(team);
  return {
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
    carryingFlagOf: null
  };
}

function addPlayer(match, id, username, color, forcedTeam = null) {
  const team = forcedTeam || assignTeam(match);
  match.players[id] = newPlayerState(id, username, color, team);
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
  security.peers.delete(id);
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

function simulateLocalPlayer(player, dt) {
  if (!player) return;
  player.yaw = state.inputs.yaw;
  player.pitch = state.inputs.pitch;

  const forward = (state.inputs.forward ? 1 : 0) - (state.inputs.back ? 1 : 0);
  const strafe = (state.inputs.right ? 1 : 0) - (state.inputs.left ? 1 : 0);
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  const worldX = forward * sin + strafe * cos;
  const worldZ = forward * cos - strafe * sin;
  const mag = Math.hypot(worldX, worldZ) || 1;

  let speed = player.carryingFlagOf ? RULES.moveSpeed * RULES.carrierSpeedMultiplier : RULES.moveSpeed;
  if (state.inputs.sprint) speed *= RULES.sprintMultiplier;
  const moveX = (worldX / mag) * speed * dt;
  const moveZ = (worldZ / mag) * speed * dt;

  const nextX = clamp(player.x + moveX, -ARENA.width / 2 + ARENA.playerRadius, ARENA.width / 2 - ARENA.playerRadius);
  const nextZ = clamp(player.z + moveZ, -ARENA.depth / 2 + ARENA.playerRadius, ARENA.depth / 2 - ARENA.playerRadius);

  if (!obstacleCollision(nextX, player.z, ARENA.playerRadius)) player.x = nextX;
  if (!obstacleCollision(player.x, nextZ, ARENA.playerRadius)) player.z = nextZ;

  if (state.inputs.jump && player.onGround) {
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

function isVulnerableOnEnemySide(player) {
  return player.team === TEAM_BLACK ? player.x > 0 : player.x < 0;
}

function processTick(match) {
  const now = Date.now();

  Object.values(match.flags).forEach((flag) => {
    if (flag.holderId && match.players[flag.holderId]) {
      const holder = match.players[flag.holderId];
      blackFlag.setPosition(new BABYLON.Vector3(flag.x, flag.y, flag.z));
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

      // Territory logic: black is only taggable on white side (x > 0), white only on black side (x < 0)
      if (aCanTag && isVulnerableOnEnemySide(b)) {
        a.tagCooldownUntil = now + RULES.tagCooldownMs;
        respawnPlayer(match, b.id, `by ${a.username}`);
      } else if (bCanTag && isVulnerableOnEnemySide(a)) {
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

function sanitizePose(raw) {
  const p = raw || {};
  return {
    x: Number.isFinite(p.x) ? p.x : 0,
    y: Number.isFinite(p.y) ? p.y : ARENA.floorY,
    z: Number.isFinite(p.z) ? p.z : 0,
    vy: Number.isFinite(p.vy) ? p.vy : 0,
    onGround: !!p.onGround,
    yaw: Number.isFinite(p.yaw) ? p.yaw : 0,
    pitch: clamp(Number.isFinite(p.pitch) ? p.pitch : 0, -1.2, 1.2)
  };
}

function acceptPose(peerId, payload) {
  const now = Date.now();
  const pose = sanitizePose(payload);
  const track = security.peers.get(peerId) || { lastPoseAt: now, lastX: pose.x, lastY: pose.y, lastZ: pose.z, strikes: 0 };

  const dt = Math.max(0.016, (now - track.lastPoseAt) / 1000);
  const dx = pose.x - track.lastX;
  const dy = pose.y - track.lastY;
  const dz = pose.z - track.lastZ;
  const distance = Math.hypot(dx, dy, dz);
  const maxDistance = RULES.moveSpeed * dt * 1.6 + 2.5;

  if (distance > maxDistance) {
    track.strikes += 1;
  } else {
    track.strikes = Math.max(0, track.strikes - 1);
  }

  track.lastPoseAt = now;
  track.lastX = pose.x;
  track.lastY = pose.y;
  track.lastZ = pose.z;
  security.peers.set(peerId, track);

  if (track.strikes > 18) return null;

  pose.x = clamp(pose.x, -ARENA.width / 2 + ARENA.playerRadius, ARENA.width / 2 - ARENA.playerRadius);
  pose.z = clamp(pose.z, -ARENA.depth / 2 + ARENA.playerRadius, ARENA.depth / 2 - ARENA.playerRadius);
  pose.y = clamp(pose.y, ARENA.floorY, ARENA.floorY + 20);
  return pose;
}

function applyIncomingState(payload) {
  state.match = payload;
  const me = payload?.players?.[state.mePeerId];
  if (!me) return;

  if (!state.localPlayer) {
    state.localPlayer = structuredClone(me);
    return;
  }

  // Preserve client-side movement, but accept server corrections for hard state changes.
  const snapNeeded = Math.hypot(state.localPlayer.x - me.x, state.localPlayer.y - me.y, state.localPlayer.z - me.z) > 6 || me.respawnUntil > state.localPlayer.respawnUntil;
  if (role === 'client' && snapNeeded) {
    state.localPlayer = structuredClone(me);
  }

  if (role === 'host') {
    state.localPlayer = structuredClone(me);
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

  if (msg.type === 'pose') {
    const player = match.players[fromPeerId];
    if (!player) return;
    const pose = acceptPose(fromPeerId, msg.payload);
    if (!pose) return;

    player.x = pose.x;
    player.y = pose.y;
    player.z = pose.z;
    player.vy = pose.vy;
    player.onGround = pose.onGround;
    player.yaw = pose.yaw;
    player.pitch = pose.pitch;
  }

  if (msg.type === 'peer-left') {
    const name = match.players[msg.peerId]?.username || msg.peerId;
    removePlayer(match, msg.peerId);
    addEvent(match, `${name} left`);
  }
}

function loadFlag(team, file) {
  BABYLON.SceneLoader.ImportMesh("", "./models/", file, render.scene, (meshes) => {
    const root = new BABYLON.TransformNode(`flag-${team}`, render.scene);

    meshes.forEach(m => m.parent = root);

    root.scaling = new BABYLON.Vector3(1.2, 1.2, 1.2);

    render.flagMeshes.set(team, root);
  });
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
    const box = BABYLON.MeshBuilder.CreateBox(
      `obs-${idx}`,
      { width: o.w, depth: o.d, height: o.h },
      render.scene
    );
  
    // Position
    box.position = new BABYLON.Vector3(o.x, o.h / 2, o.z);
  
    // Rotation on ALL axes
    box.rotation = new BABYLON.Vector3(
      o.rotX || 0,
      o.rotY || 0,
      o.rotZ || 0
    );
  
    // Material + color
    const mat = new BABYLON.StandardMaterial(`obs-mat-${idx}`, render.scene);
    const c = o.color || [0.25, 0.29, 0.42];
    mat.diffuseColor = new BABYLON.Color3(c[0], c[1], c[2]);
  
    box.material = mat;
  
    render.obstacleMeshes.push(box);
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

  const blackFlag = createFlag(render.scene, {
    position: new BABYLON.Vector3(-20, 0, 0),
    color: new BABYLON.Color3(0.1, 0.1, 0.1)
  });

  const whiteFlag = createFlag(render.scene, {
    position: new BABYLON.Vector3(20, 0, 0),
    color: new BABYLON.Color3(1, 1, 1)
  });

  render.flagMeshes.set(TEAM_BLACK, blackFlag);
  render.flagMeshes.set(TEAM_WHITE, whiteFlag);

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
  });

  render.engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - state.lastFrameMs) / 1000);
    state.lastFrameMs = now;

    simulateLocalPlayer(state.localPlayer, dt);
    syncLocalToMatch();

    if (state.match) {
      syncMeshes(dt);
      updateHud(state.match);
    }

    maybeSendPose(now);
    render.scene.render();
  });

  window.addEventListener('resize', () => render.engine.resize());
}

function syncLocalToMatch() {
  if (!state.match || !state.localPlayer || !state.mePeerId) return;
  const p = state.match.players[state.mePeerId];
  if (!p) return;

  p.x = state.localPlayer.x;
  p.y = state.localPlayer.y;
  p.z = state.localPlayer.z;
  p.vy = state.localPlayer.vy;
  p.onGround = state.localPlayer.onGround;
  p.yaw = state.localPlayer.yaw;
  p.pitch = state.localPlayer.pitch;
}

function maybeSendPose(nowMs) {
  if (role !== 'client' || !state.localPlayer) return;
  if (nowMs - state.lastPoseSentAt < 90) return;
  state.lastPoseSentAt = nowMs;

  net.sendToHost({
    type: 'pose',
    payload: {
      x: state.localPlayer.x,
      y: state.localPlayer.y,
      z: state.localPlayer.z,
      vy: state.localPlayer.vy,
      onGround: state.localPlayer.onGround,
      yaw: state.localPlayer.yaw,
      pitch: state.localPlayer.pitch
    }
  });
}

function ensurePlayerMesh(player) {
  if (render.playerMeshes.has(player.id)) return;

  BABYLON.SceneLoader.ImportMesh(
    "",
    "./models/",          // folder
    "character.glb",      // your model
    render.scene,
    (meshes) => {
      const root = new BABYLON.TransformNode(`p-${player.id}`, render.scene);

      meshes.forEach(m => {
        m.parent = root;
      });

      root.scaling = new BABYLON.Vector3(1, 1, 1); // adjust size
      render.playerMeshes.set(player.id, root);

      // OPTIONAL: color tint
      meshes.forEach(m => {
        if (m.material) {
          m.material = m.material.clone();
          m.material.albedoColor = BABYLON.Color3.FromHexString(player.color || '#4dd8ff');
        }
      });

      // nameplate (same as before)
      const panel = new BABYLON.GUI.Rectangle(`tag-${player.id}`);
      panel.height = '28px';
      panel.width = '130px';
      render.adt.addControl(panel);
      panel.linkWithMesh(root);
      panel.linkOffsetY = -62;

      const text = new BABYLON.GUI.TextBlock();
      text.text = player.username;
      panel.addControl(text);

      render.nameplates.set(player.id, panel);
    }
  );
}

function cleanupPlayerMesh(id) {
  render.playerMeshes.get(id)?.dispose();
  render.nameplates.get(id)?.dispose();
  render.playerMeshes.delete(id);
  render.nameplates.delete(id);
  render.interpolatedPlayers.delete(id);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function syncMeshes(dt) {
  const match = state.match;
  const ids = new Set(Object.keys(match.players));

  render.playerMeshes.forEach((_, id) => {
    if (!ids.has(id)) cleanupPlayerMesh(id);
  });

  const smoothing = clamp(dt * 12, 0.08, 0.3);

  Object.values(match.players).forEach((auth) => {
    ensurePlayerMesh(auth);
    const mesh = render.playerMeshes.get(auth.id);

    const target = auth.id === state.mePeerId && state.localPlayer ? state.localPlayer : auth;

    let interp = render.interpolatedPlayers.get(auth.id);
    if (!interp) {
      interp = { x: target.x, y: target.y, z: target.z, yaw: target.yaw };
      render.interpolatedPlayers.set(auth.id, interp);
    }

    if (auth.id === state.mePeerId) {
      interp.x = target.x;
      interp.y = target.y;
      interp.z = target.z;
      interp.yaw = target.yaw;
    } else {
      interp.x = lerp(interp.x, target.x, smoothing);
      interp.y = lerp(interp.y, target.y, smoothing);
      interp.z = lerp(interp.z, target.z, smoothing);
      interp.yaw = lerp(interp.yaw, target.yaw, smoothing);
    }

    mesh.position.set(interp.x, interp.y, interp.z);
    mesh.rotation.y = interp.yaw;
    mesh.material.diffuseColor = BABYLON.Color3.FromHexString(auth.color || '#4dd8ff');

    if (auth.id === state.mePeerId) {
      const eye = new BABYLON.Vector3(interp.x, interp.y + 1.35, interp.z);
      const forward = new BABYLON.Vector3(Math.sin(state.inputs.yaw), -state.inputs.pitch * 0.6, Math.cos(state.inputs.yaw));
      render.camera.position = eye;
      render.camera.setTarget(eye.add(forward));
    }

    const panel = render.nameplates.get(auth.id);
    if (panel) {
      if (state.inputs.hideTags) {
        panel.isVisible = false;
      } else {
        const camPos = render.camera.position;
        const targetHead = new BABYLON.Vector3(interp.x, interp.y + 1.6, interp.z);
        const toTarget = targetHead.subtract(camPos);
        const distance = toTarget.length();
        const dir = toTarget.normalize();
        const ray = new BABYLON.Ray(camPos, dir, distance);
        const hit = render.scene.pickWithRay(ray, (m) => render.obstacleMeshes.includes(m), false);
        const blocked = !!(hit && hit.hit && hit.distance < distance - 0.3);
        panel.isVisible = !blocked;

        const fadeStart = 12;
        const fadeEnd = 70;
        const t = clamp((distance - fadeStart) / (fadeEnd - fadeStart), 0, 1);
        const alpha = 1 - t * 0.82;
        panel.alpha = alpha;
        const scale = 1 - t * 0.45;
        panel.scaleX = scale;
        panel.scaleY = scale;
      }
    }
  });

  Object.values(match.flags).forEach((flag) => {
    const flagObj = render.flagMeshes.get(flag.team);
    if (flagObj) {
      flagObj.setPosition(new BABYLON.Vector3(flag.x, flag.y, flag.z));
    }
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
  if (key === 'control') state.inputs.sprint = pressed;
  if (key === 'shift') state.inputs.hideTags = pressed;
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
      state.localPlayer = structuredClone(state.match.players[state.mePeerId]);
      addEvent(state.match, `${profile.username} is hosting room ${room}`);
    } else {
      await net.join(room);
      state.mePeerId = net.peer.id;
      net.sendToHost({ type: 'join-request', payload: { username: profile.username, color: profile.color } });
    }
  } catch (err) {
    errorEl.textContent = `Network error: ${err.message}`;
    return;
  }

  const hostLoop = () => {
    if (!state.match || role !== 'host') return;
    processTick(state.match);
    net.broadcast({ type: 'state', payload: state.match });
  };

  setInterval(hostLoop, 1000 / RULES.tickRate);
}

start();
