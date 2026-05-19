import { useEffect, useRef, useCallback, useState } from 'react';

interface WSMessage {
  event: string;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  onMessage: (msg: WSMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function useWebSocket(options: UseWebSocketOptions) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(3000);
  // Incremented on every intentional close. Each connection captures its own
  // generation value — if it differs at close time, the close was intentional
  // (cleanup / StrictMode unmount) and we must NOT reconnect.
  const connectionGen = useRef(0);
  // Always-current options ref — prevents stale closures when state changes
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // ── Message queue: buffer messages sent while disconnected ───────────
  const pendingMessages = useRef<Record<string, unknown>[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // ── Flush queued messages on reconnect ───────────────────────────────
  function flushPending() {
    const queue = pendingMessages.current;
    if (queue.length === 0) return;
    pendingMessages.current = [];
    setPendingCount(0);
    // Re-dispatch each queued message with a small delay between them to
    // avoid flooding the server on reconnect
    let delay = 0;
    for (const msg of queue) {
      delay += 100;
      setTimeout(() => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify(msg));
        }
      }, delay);
    }
  }

  const connect = useCallback(() => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    const myGen = connectionGen.current; // captured for this specific connection

    const newWs = new WebSocket(wsUrl);
    ws.current = newWs;

    newWs.onopen = () => {
      reconnectDelay.current = 3000;
      setIsConnected(true);
      optionsRef.current.onConnect?.();
      // Flush any messages that were queued while disconnected
      flushPending();
    };

    newWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSMessage;
        optionsRef.current.onMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    newWs.onclose = () => {
      setIsConnected(false);
      optionsRef.current.onDisconnect?.();
      // Generation mismatch means cleanup already ran — do NOT reconnect
      if (connectionGen.current !== myGen) return;
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 1.5, 30000);
        connect();
      }, reconnectDelay.current);
    };

    newWs.onerror = () => {
      newWs.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connect();
    return () => {
      connectionGen.current++; // invalidate this connection's onclose handler
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      ws.current?.close();
    };
  }, [connect]);

  // ── Send with message queue fallback ─────────────────────────────────
  const send = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    } else {
      // Queue the message for replay when the WebSocket reconnects
      pendingMessages.current = [...pendingMessages.current, msg];
      setPendingCount(pendingMessages.current.length);
    }
  }, []);

  // ── Clear any pending queued messages (e.g. on navigation) ───────────
  const clearPending = useCallback(() => {
    pendingMessages.current = [];
    setPendingCount(0);
  }, []);

  return { send, isConnected, pendingCount, clearPending };
}
