export const STORAGE_KEYS = {
  color: 'ctf_color',
  username: 'ctf_username',
  roomCode: 'ctf_room_code',
  role: 'ctf_role'
};

export const TEAM_BLACK = 'black';
export const TEAM_WHITE = 'white';

export const TEAM_META = {
  [TEAM_BLACK]: {
    label: 'Black',
    color: '#202020',
    spawn: { x: -45, y: 1.1, z: 0 },
    base: { x: -56, y: 1.1, z: 0 }
  },
  [TEAM_WHITE]: {
    label: 'White',
    color: '#efefef',
    spawn: { x: 45, y: 1.1, z: 0 },
    base: { x: 56, y: 1.1, z: 0 }
  }
};

export const ARENA = {
  width: 140,
  depth: 90,
  playerRadius: 1,
  playerHeight: 2.2,
  tagRange: 3.4,
  flagRadius: 1.1,
  floorY: 1.1
};

export const RULES = {
  maxScore: 3,
  tickRate: 30,
  moveSpeed: 13,
  sprintMultiplier: 1.35,
  carrierSpeedMultiplier: 0.84,
  jumpVelocity: 8.8,
  gravity: 24,
  tagCooldownMs: 1400,
  respawnInvulnMs: 1500,
  matchSeconds: 7 * 60
};

export function randomCode() {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

export function isValidCode(code) {
  return /^\d{6}$/.test(code || '');
}

export function isValidUsername(name) {
  return /^[a-zA-Z0-9_\- ]{3,16}$/.test((name || '').trim());
}

export function saveProfile({ color, username, roomCode, role }) {
  if (color) localStorage.setItem(STORAGE_KEYS.color, color);
  if (username) localStorage.setItem(STORAGE_KEYS.username, username.trim());
  if (roomCode) localStorage.setItem(STORAGE_KEYS.roomCode, roomCode);
  if (role) localStorage.setItem(STORAGE_KEYS.role, role);
}

export function loadProfile() {
  return {
    color: localStorage.getItem(STORAGE_KEYS.color) || '#34d399',
    username: localStorage.getItem(STORAGE_KEYS.username) || '',
    roomCode: localStorage.getItem(STORAGE_KEYS.roomCode) || '',
    role: localStorage.getItem(STORAGE_KEYS.role) || ''
  };
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function distSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const dy = (a.y || 0) - (b.y || 0);
  return dx * dx + dy * dy + dz * dz;
}

export function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}
