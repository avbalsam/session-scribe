import { useEffect, useRef } from "react";
import { useSessionSocket } from "../hooks/useTranscriptSocket";
import { API_BASE_URL } from "../config";

interface Props {
  sessionId: string;
  status: string;
  onStop: () => void;
}

export function LiveTranscript({ sessionId, status, onStop }: Props) {
  const { level, duration, connected } = useSessionSocket(
    status === "recording" ? sessionId : null
  );

  const handleStop = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/stop`, {
        method: "POST",
      });
      onStop();
    } catch (err) {
      console.error("Failed to stop session:", err);
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const isRecording = status === "recording" || status === "starting";
  const isStopped = status === "stopped";

  return (
    <div className="live-transcript">
      <div className="transcript-header">
        <h2>Session</h2>
        <div className="status-row">
          <span
            className={`status-indicator ${connected ? "connected" : "disconnected"}`}
          >
            {connected ? "Recording" : isStopped ? "Stopped" : "Connecting..."}
          </span>
          {isRecording && (
            <button className="stop-btn" onClick={handleStop}>
              Stop Recording
            </button>
          )}
        </div>
      </div>

      <div className="transcript-body">
        {isRecording && (
          <div className="audio-monitor">
            <div className="level-meter">
              <div
                className="level-bar"
                style={{ width: `${Math.min(level * 500, 100)}%` }}
              />
            </div>
            <div className="audio-stats">
              <span className="duration">{formatDuration(duration)}</span>
              <span className="level-value">
                {level > 0.01 ? "Audio detected" : "Silence"}
              </span>
            </div>
          </div>
        )}

        {isStopped && (
          <div className="audio-playback">
            <p className="playback-label">Recording complete — {formatDuration(duration)}</p>
            <audio
              controls
              src={`${API_BASE_URL}/api/sessions/${sessionId}/audio`}
              className="audio-player"
            />
          </div>
        )}
      </div>
    </div>
  );
}
