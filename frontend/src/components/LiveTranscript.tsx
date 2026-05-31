import { useEffect, useRef } from "react";
import { useTranscriptSocket, TranscriptSegment } from "../hooks/useTranscriptSocket";

interface Props {
  sessionId: string;
  onStop: () => void;
}

export function LiveTranscript({ sessionId, onStop }: Props) {
  const { segments, connected } = useTranscriptSocket(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new segments arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments]);

  const handleStop = async () => {
    try {
      await fetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
      onStop();
    } catch (err) {
      console.error("Failed to stop session:", err);
    }
  };

  return (
    <div className="live-transcript">
      <div className="transcript-header">
        <h2>Live Session</h2>
        <div className="status-row">
          <span className={`status-indicator ${connected ? "connected" : "disconnected"}`}>
            {connected ? "Recording" : "Connecting..."}
          </span>
          <button className="stop-btn" onClick={handleStop}>
            Stop Recording
          </button>
        </div>
      </div>

      <div className="transcript-body" ref={scrollRef}>
        {segments.length === 0 ? (
          <p className="placeholder">
            {connected
              ? "Listening for audio... Transcript will appear here when speech is detected."
              : "Connecting to session..."}
          </p>
        ) : (
          segments.map((seg, i) => (
            <TranscriptLine key={i} segment={seg} />
          ))
        )}
      </div>
    </div>
  );
}

function TranscriptLine({ segment }: { segment: TranscriptSegment }) {
  return (
    <div className="transcript-line">
      {segment.speaker && (
        <span className="speaker-label">{segment.speaker}:</span>
      )}
      <span className="transcript-text">{segment.text}</span>
    </div>
  );
}
