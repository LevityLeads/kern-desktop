'use strict';

const { EventEmitter } = require('events');
const net = require('net');
const { PROTOCOL_VERSION, isPlainObject } = require('./protocol');

const MAX_MESSAGE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 1000;
const STARTUP_RETRY_DELAY_MS = 50;
const TRANSIENT_STARTUP_ERRORS = new Set(['ENOENT', 'ECONNREFUSED', 'EBUSY']);

function pipePath(pipeName, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : pathForUnixTests(pipeName);
}

function pathForUnixTests(pipeName) {
  return `/tmp/${pipeName}.sock`;
}

function encodeMessage(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.length === 0 || json.length > MAX_MESSAGE_BYTES) {
    throw new Error('Helper protocol message is outside the allowed size');
  }
  const output = Buffer.allocUnsafe(4 + json.length);
  output.writeUInt32LE(json.length, 0);
  json.copy(output, 4);
  return output;
}

class FrameDecoder {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Helper protocol data must be a Buffer');
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size === 0 || size > MAX_MESSAGE_BYTES) {
        throw new Error('Invalid helper protocol frame size');
      }
      if (this.buffer.length < size + 4) return;
      const body = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        throw new Error('Invalid helper protocol JSON');
      }
      if (!isPlainObject(message)) throw new Error('Invalid helper protocol message');
      this.onMessage(message);
    }
  }
}

class HelperTransport extends EventEmitter {
  constructor({ pipeName, socketFactory = net.createConnection, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    super();
    this.pipeName = pipeName;
    this.socketFactory = socketFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.pending = new Map();
    this.nextRequestId = 1;
  }

  async connect(timeoutMs = 5000) {
    if (this.socket) throw new Error('Helper transport is already connected');

    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (!this.socket) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const error = new Error('Timed out connecting to capture helper');
        if (lastError?.code) error.code = lastError.code;
        throw error;
      }

      try {
        this.socket = await this._connectOnce(remainingMs);
      } catch (error) {
        if (!TRANSIENT_STARTUP_ERRORS.has(error?.code)) throw error;
        lastError = error;
        const retryDelayMs = Math.min(STARTUP_RETRY_DELAY_MS, deadline - Date.now());
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    this._bindSocket(this.socket);

    const hello = await this.request('hello', { protocolVersion: PROTOCOL_VERSION }, 2000);
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.close();
      throw new Error(`Capture helper protocol ${hello.protocolVersion} is incompatible`);
    }
    return hello;
  }

  _connectOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(pipePath(this.pipeName));
      const timer = setTimeout(() => {
        const error = new Error('Timed out connecting to capture helper');
        error.code = 'ETIMEDOUT';
        finish(error);
      }, timeoutMs);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onInitialError);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve(socket);
        }
      };
      const onConnect = () => finish();
      const onInitialError = (error) => finish(error);
      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
    });
  }

  _bindSocket(socket) {
    const decoder = new FrameDecoder((message) => this._receive(message));
    socket.on('data', (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        this._fail(error);
      }
    });
    socket.on('error', (error) => this._fail(error));
    socket.on('close', () => this._fail(new Error('Capture helper connection closed')));
  }

  _receive(message) {
    if (message.type === 'event' && typeof message.event === 'string') {
      this.emit('event', message.event, message.payload);
      return;
    }
    if (message.type !== 'response' || !Number.isSafeInteger(message.requestId)) {
      throw new Error('Unexpected capture helper message');
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result || {});
    } else {
      const error = new Error(message.error?.message || 'Capture helper rejected a command');
      error.code = message.error?.code || 'helper-error';
      pending.reject(error);
    }
  }

  request(command, payload = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Capture helper is not connected'));
    }
    if (typeof command !== 'string' || !/^[a-z][a-z-]{0,30}$/.test(command)) {
      return Promise.reject(new TypeError('Invalid helper command'));
    }

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Capture helper did not acknowledge ${command}`);
        error.code = 'helper-timeout';
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeMessage({
        type: 'request',
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command,
        payload,
      }));
    });
  }

  _fail(error) {
    if (!this.socket && this.pending.size === 0) return;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Capture helper transport closed'));
    }
    this.pending.clear();
  }
}

module.exports = {
  FrameDecoder,
  HelperTransport,
  MAX_MESSAGE_BYTES,
  REQUEST_TIMEOUT_MS,
  encodeMessage,
  pipePath,
};
