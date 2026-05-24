import { describe, it, expect, vi } from 'vitest';
import { attachWebSockets } from './ws-handler';
import http from 'http';
import { WebSocketServer } from 'ws';

// Mock ws
vi.mock('ws', () => {
    return {
        WebSocketServer: vi.fn(function () { return {
            on: vi.fn(),
            handleUpgrade: vi.fn()
    }; }),
        WebSocket: {
            OPEN: 1,
            CLOSED: 3
        }
    };
});

describe('WS Handler', () => {
    it('should attach web sockets to passed server', () => {
        const mockServer = new http.Server();
        mockServer.on = vi.fn();

        attachWebSockets(mockServer);

        expect(WebSocketServer).toHaveBeenCalled();
        expect(mockServer.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
    });
});
