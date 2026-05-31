import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { attachWebSockets } from './ws-handler';

describe('ws-handler integration', () => {
  let server: http.Server;
  let wsUrl: string;

  beforeAll(async () => {
    server = http.createServer();
    attachWebSockets(server);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const port = (server.address() as any).port;
        wsUrl = `ws://localhost:${port}/ws`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('should reject connections without a valid token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      
      ws.on('close', (code, reason) => {
        try {
          expect(code).toBe(4001);
          expect(reason.toString()).toBe('Missing token');
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });
  });

  it('should reject connections with an invalid token', () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: 'Bearer invalid_token'
        }
      });

      ws.on('close', (code, reason) => {
        try {
          expect(code).toBe(4001);
          expect(reason.toString()).toBe('Invalid token');
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ws.on('error', (err) => {
        reject(err);
      });
    });
  });
});
