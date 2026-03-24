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
const ctx = canvas.getContext('2d');
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
const search = new URLSearchParams(location.search);
const room = search.get('room') || profile.roomCode;
const role = search.get('role') || profile.role;

if (!room || !role || !profile.username) {
  location.href = './join.html';
}

const state = {
  mePeerId: null,
  match: null,
  inputs: { up: false, down: false, left: false, right: false },
  seq: 0,
  camera: { x: 0, y: 0 },
  connectedPlayers: 1
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
    [TEAM_BLACK]: {
      team: TEAM_BLACK,
      x: TEAM_META[TEAM_BLACK].base.x,
      y: TEAM_META[TEAM_BLACK].base.y,
      holderId: null,
      atBase: true
    },
    [TEAM_WHITE]: {
      team: TEAM_WHITE,
      x: TEAM_META[TEAM_WHITE].base.x,
      y: TEAM_META[TEAM_WHITE].base.y,
      holderId: null,
      atBase: true
    }
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
  return { x: base.x, y: base.y };
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
    tagCooldownUntil: 0,
    respawnUntil: Date.now() + 800,
    carryingFlagOf: null,
    input: { up: false, down: false, left: false, right: false }
  };
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
    flag.y = TEAM_META[enemyTeam].base.y;
  } else {
    flag.holderId = null;
    flag.atBase = false;
    flag.x = player.x;
    flag.y = player.y;
  }
}

function respawnPlayer(match, playerId, reason) {
  const p = match.players[playerId];
  if (!p) return;
  dropFlag(match, playerId, true);
  const spawn = spawnFor(p.team);
  p.x = spawn.x;
  p.y = spawn.y;
  p.respawnUntil = Date.now() + RULES.respawnInvulnMs;
  addEvent(match, `${p.username} was tagged (${reason})`);
}

function processTick(match, dt) {
  const now = Date.now();
  Object.values(match.players).forEach((p) => {
    const speed = p.carryingFlagOf ? RULES.moveSpeed * RULES.carrierSpeedMultiplier : RULES.moveSpeed;
    const dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    const mag = Math.hypot(dx, dy) || 1;
    p.x = clamp(p.x + (dx / mag) * speed * dt, ARENA.playerRadius, ARENA.width - ARENA.playerRadius);
    p.y = clamp(p.y + (dy / mag) * speed * dt, ARENA.playerRadius, ARENA.height - ARENA.playerRadius);
  });

  // flag follow
  Object.values(match.flags).forEach((flag) => {
    if (flag.holderId && match.players[flag.holderId]) {
      const holder = match.players[flag.holderId];
      flag.x = holder.x;
      flag.y = holder.y;
      flag.atBase = false;
    }
  });

  // pickups + captures
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
      if (homeFlag.atBase && distSq(p, base) <= (ARENA.playerRadius + 26) ** 2) {
        match.scores[p.team] += 1;
        addEvent(match, `${p.username} captured for ${TEAM_META[p.team].label}`);
        p.carryingFlagOf = null;
        match.flags = mkFlags();

        if (match.scores[p.team] >= RULES.maxScore) {
          match.winner = p.team;
          match.endsAt = Date.now();
          addEvent(match, `${TEAM_META[p.team].label} wins!`);
        }
      }
    }
  });

  // tagging
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
    addEvent(match, match.winner === 'draw' ? 'Match ended in draw' : `${TEAM_META[match.winner].label} wins on time`);
  }
}

function onMessage(msg, fromPeerId) {
  if (!msg?.type) return;
  if (msg.type === 'disconnect') {
    statEl.status.textContent = 'Disconnected';
    return;
  }

  if (msg.type === 'event' && msg.payload?.text) {
    pushFeed(msg.payload.text);
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

function drawArena(match) {
  const scaleX = canvas.width / ARENA.width;
  const scaleY = canvas.height / ARENA.height;

  function mapX(x) {
    return x * scaleX;
  }
  function mapY(y) {
    return y * scaleY;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // sides
  ctx.fillStyle = '#101722';
  ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
  ctx.fillStyle = '#1d2230';
  ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);

  // middle line
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);

  // bases
  [TEAM_BLACK, TEAM_WHITE].forEach((team) => {
    const b = TEAM_META[team].base;
    ctx.fillStyle = team === TEAM_BLACK ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(mapX(b.x), mapY(b.y), 35, 0, Math.PI * 2);
    ctx.fill();
  });

  // flags
  Object.values(match.flags).forEach((flag) => {
    ctx.fillStyle = flag.team === TEAM_BLACK ? '#111' : '#fff';
    ctx.strokeStyle = flag.team === TEAM_BLACK ? '#fff' : '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mapX(flag.x), mapY(flag.y), ARENA.flagRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = flag.team === TEAM_BLACK ? '#fff' : '#111';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(flag.team === TEAM_BLACK ? 'B' : 'W', mapX(flag.x), mapY(flag.y) + 4);
  });

  Object.values(match.players).forEach((p) => {
    const invuln = Date.now() < p.respawnUntil;
    ctx.globalAlpha = invuln ? 0.5 : 1;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(mapX(p.x), mapY(p.y), ARENA.playerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.team === TEAM_BLACK ? '#fff' : '#111';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (p.id === state.mePeerId) {
      ctx.strokeStyle = '#4dd8ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(mapX(p.x), mapY(p.y), ARENA.playerRadius + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (p.carryingFlagOf) {
      ctx.fillStyle = '#ffd43b';
      ctx.fillRect(mapX(p.x) - 4, mapY(p.y) - 32, 8, 14);
    }

    ctx.fillStyle = '#e6edff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.username, mapX(p.x), mapY(p.y) - 24);
    ctx.globalAlpha = 1;
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

  const latest = match.events.slice(0, 8).map((e) => `<div>${new Date(e.t).toLocaleTimeString()} - ${e.text}</div>`).join('');
  statEl.feed.innerHTML = latest || '<div class="small">No events yet.</div>';
}

function sendInputIfClient() {
  if (role !== 'host') {
    net.sendToHost({ type: 'input', payload: state.inputs, seq: ++state.seq });
  }
}

function setInput(key, pressed) {
  if (key === 'w' || key === 'arrowup') state.inputs.up = pressed;
  if (key === 's' || key === 'arrowdown') state.inputs.down = pressed;
  if (key === 'a' || key === 'arrowleft') state.inputs.left = pressed;
  if (key === 'd' || key === 'arrowright') state.inputs.right = pressed;
  sendInputIfClient();
}

window.addEventListener('keydown', (e) => setInput(e.key.toLowerCase(), true));
window.addEventListener('keyup', (e) => setInput(e.key.toLowerCase(), false));
window.addEventListener('beforeunload', () => net.close());

async function start() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  window.addEventListener('resize', () => {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  });

  try {
    if (role === 'host') {
      await net.host(room);
      state.mePeerId = net.peer.id;
      state.match = createMatch(state.mePeerId);
      addPlayer(state.match, state.mePeerId, profile.username, profile.color, TEAM_BLACK);
      addEvent(state.match, `${profile.username} is hosting room ${room}`);
      net.broadcast({ type: 'event', payload: { text: 'Host online' } });
    } else {
      await net.join(room);
      state.mePeerId = net.peer.id;
      net.sendToHost({
        type: 'join-request',
        payload: { username: profile.username, color: profile.color }
      });
    }
  } catch (err) {
    errorEl.textContent = `Network error: ${err.message}`;
    return;
  }

  let last = performance.now();
  let accumulator = 0;
  const step = 1 / RULES.tickRate;

  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    if (role === 'host' && state.match) {
      const me = state.match.players[state.mePeerId];
      if (me) me.input = state.inputs;
      accumulator += dt;
      while (accumulator >= step) {
        processTick(state.match, step);
        accumulator -= step;
      }
      net.broadcast({ type: 'state', payload: state.match });
    }

    if (state.match) {
      drawArena(state.match);
      updateHud(state.match);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

start();
