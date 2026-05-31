import { useState, useEffect, useRef, useCallback } from "react";
import { API_BASE_URL } from "../config";

export interface TranscriptSegment {
  text: string;
  speaker: string | null;
  startTime: number | null;
  endTime: number | null;
}

export function useTranscriptSocket(sessionId: string | null) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSegments([]);
      setConnected(false);
      return;
    }

    const wsBase = API_BASE_URL
      ? API_BASE_URL.replace(/^http/, "ws")
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
    const wsUrl = `${wsBase}/ws/transcript/${sessionId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const segment: TranscriptSegment = JSON.parse(event.data);
        setSegments((prev) => [...prev, segment]);
      } catch (e) {
        console.error("[ws] Failed to parse transcript segment:", e);
      }
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  const clear = useCallback(() => setSegments([]), []);

  return { segments, connected, clear };
}
