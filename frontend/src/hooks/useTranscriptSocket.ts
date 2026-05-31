import { useState, useEffect, useRef, useCallback } from "react";
import { API_BASE_URL } from "../config";

export interface TranscriptSegment {
  text: string;
  speaker: string | null;
  startTime: number | null;
  endTime: number | null;
}

export interface SessionSocket {
  segments: TranscriptSegment[];
  level: number;
  duration: number;
  connected: boolean;
  clear: () => void;
}

export function useSessionSocket(sessionId: string | null): SessionSocket {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [level, setLevel] = useState(0);
  const [duration, setDuration] = useState(0);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSegments([]);
      setLevel(0);
      setDuration(0);
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
        const msg = JSON.parse(event.data);
        if (msg.type === "level") {
          setLevel(msg.level);
          setDuration(msg.duration);
        } else if (msg.type === "transcript") {
          setSegments((prev) => [...prev, {
            text: msg.text,
            speaker: msg.speaker,
            startTime: msg.startTime,
            endTime: msg.endTime,
          }]);
        }
      } catch (e) {
        console.error("[ws] Failed to parse message:", e);
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

  const clear = useCallback(() => {
    setSegments([]);
    setLevel(0);
    setDuration(0);
  }, []);

  return { segments, level, duration, connected, clear };
}
