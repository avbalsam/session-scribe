import { useState, useEffect } from "react";
import { useSessionSocket } from "../hooks/useTranscriptSocket";
import { API_BASE_URL } from "../config";

interface Props {
  sessionId: string;
  status: string;
  onStop: () => void;
}

interface Screenshot {
  name: string;
  url: string;
}

interface TranscriptSegment {
  text: string;
  speaker: string | null;
  startTime: number | null;
  endTime: number | null;
}

interface SessionData {
  transcript: TranscriptSegment[];
  summary: string | null;
  status: string;
}

export function LiveTranscript({ sessionId, status, onStop }: Props) {
  const { level, duration, connected } = useSessionSocket(
    status === "recording" ? sessionId : null
  );
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  // Poll for screenshots
  useEffect(() => {
    const fetchScreenshots = async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/sessions/${sessionId}/screenshots`
        );
        const data = await res.json();
        setScreenshots(data);
      } catch {}
    };

    fetchScreenshots();
    const interval = setInterval(fetchScreenshots, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  // Fetch transcript when status changes to stopped
  useEffect(() => {
    if (status === "stopped" || status === "transcribing") {
      fetchTranscript();
    }
  }, [status]);

  // Poll while transcribing
  useEffect(() => {
    if (!transcribing) return;
    const interval = setInterval(async () => {
      const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`);
      const data: SessionData = await res.json();
      if (data.status === "stopped") {
        setTranscribing(false);
        setTranscript(data.transcript || []);
        setSummary(data.summary || null);
      } else if (data.status === "error") {
        setTranscribing(false);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [transcribing, sessionId]);

  const fetchTranscript = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`);
      const data: SessionData = await res.json();
      setTranscript(data.transcript || []);
      setSummary(data.summary || null);
      if (data.status === "transcribing") {
        setTranscribing(true);
      }
    } catch {}
  };

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

  const handleTranscribe = async () => {
    setTranscribing(true);
    try {
      await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/transcribe`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Failed to start transcription:", err);
      setTranscribing(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatTimestamp = (seconds: number | null) => {
    if (seconds === null) return "";
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
            className={`status-indicator ${
              connected ? "connected" : transcribing ? "transcribing" : "disconnected"
            }`}
          >
            {connected
              ? "Recording"
              : transcribing
              ? "Transcribing..."
              : isStopped
              ? "Stopped"
              : "Connecting..."}
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
            <audio
              controls
              src={`${API_BASE_URL}/api/sessions/${sessionId}/audio`}
              className="audio-player"
            />
            {transcript.length === 0 && !transcribing && (
              <button className="transcribe-btn" onClick={handleTranscribe}>
                Generate Transcript
              </button>
            )}
          </div>
        )}

        {transcribing && (
          <div className="transcribing-indicator">
            <span className="spinner" />
            <span>Transcribing audio with Whisper...</span>
          </div>
        )}

        {summary && (
          <div className="summary-section">
            <h3>Session Summary</h3>
            <div className="summary-content">{summary}</div>
          </div>
        )}

        {transcript.length > 0 && (
          <div className="transcript-section">
            <h3>Transcript</h3>
            <div className="transcript-lines">
              {transcript.map((seg, i) => (
                <div key={i} className="transcript-line">
                  {seg.startTime !== null && (
                    <span className="timestamp">
                      {formatTimestamp(seg.startTime)}
                    </span>
                  )}
                  <span className="transcript-text">{seg.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {screenshots.length > 0 && (
          <div className="screenshots-section">
            <h3>Bot Screenshots</h3>
            <div className="screenshots-grid">
              {screenshots.map((s) => (
                <div key={s.name} className="screenshot-item">
                  <img
                    src={`${API_BASE_URL}${s.url}`}
                    alt={s.name}
                    loading="lazy"
                  />
                  <span className="screenshot-label">{s.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
