import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { attachWebSockets } from './ws-handler';

describe('ws-handler integration', () => {
  let server: http.Server;
  let wsUrl: string;

  beforeAll((done) => {
    server = http.createServer();
    attachWebSockets(server);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      wsUrl = `ws://localhost:${port}/ws`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should reject connections without a valid token', (done) => {
    const ws = new WebSocket(wsUrl);
    
    ws.on('close', (code, reason) => {
      expect(code).toBe(4001);
      expect(reason.toString()).toBe('Missing token');
      done();
    });
  });

  it('should reject connections with an invalid token', (done) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: 'Bearer invalid_token'
      }
    });

    ws.on('close', (code, reason) => {
      expect(code).toBe(4001);
      expect(reason.toString()).toBe('Invalid token');
      done();
    });
  });
});
