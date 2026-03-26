import { randomCode } from './common.js';

export class NetClient {
  constructor({ onState, onEvent, onPeerChange }) {
    this.onState = onState;
    this.onEvent = onEvent;
    this.onPeerChange = onPeerChange;
    this.peer = null;
    this.conn = null;
    this.clients = new Map();
    this.isHost = false;
    this.hostId = null;
  }

  async host(code) {
    this.isHost = true;
    const roomCode = code || randomCode();
    const id = `gkctf-${roomCode}`;
    this.hostId = id;
    this.peer = new Peer(id);
    return new Promise((resolve, reject) => {
      this.peer.on('open', () => {
        this._wireHostListeners();
        resolve(roomCode);
      });
      this.peer.on('error', (err) => reject(err));
    });
  }

  async join(code) {
    this.isHost = false;
    this.peer = new Peer();
    const hostId = `gkctf-${code}`;
    return new Promise((resolve, reject) => {
      this.peer.on('open', () => {
        this.conn = this.peer.connect(hostId, { reliable: true });
        this.conn.on('open', () => {
          this._wireClientConn(this.conn);
          resolve();
        });
        this.conn.on('error', (err) => reject(err));
      });
      this.peer.on('error', (err) => reject(err));
    });
  }

  _wireHostListeners() {
    this.peer.on('connection', (conn) => {
      this.clients.set(conn.peer, conn);
      this.onPeerChange?.(this.clients.size + 1);
      conn.on('data', (msg) => this.onEvent?.(msg, conn.peer));
      conn.on('close', () => {
        this.clients.delete(conn.peer);
        this.onEvent?.({ type: 'peer-left', peerId: conn.peer }, conn.peer);
        this.onPeerChange?.(this.clients.size + 1);
      });
    });
  }

  _wireClientConn(conn) {
    conn.on('data', (msg) => {
      if (msg.type === 'state') this.onState?.(msg.payload);
      else this.onEvent?.(msg, 'host');
    });
    conn.on('close', () => this.onEvent?.({ type: 'disconnect' }, 'host'));
  }

  sendToHost(msg) {
    if (!this.conn || this.conn.open === false) return;
    this.conn.send(msg);
  }

  broadcast(msg) {
    this.clients.forEach((conn) => {
      if (conn.open !== false) conn.send(msg);
    });
  }

  close() {
    this.clients.forEach((conn) => conn.close());
    this.conn?.close();
    this.peer?.destroy();
  }
}
