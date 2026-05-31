import { useState, useEffect } from "react";

interface SessionSummary {
  id: string;
  meetingId: string;
  botName: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
}

interface Props {
  onSelectSession: (sessionId: string) => void;
  refreshTrigger: number;
}

export function SessionList({ onSelectSession, refreshTrigger }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions();
  }, [refreshTrigger]);

  const fetchSessions = async () => {
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json();
      setSessions(data);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <p>Loading sessions...</p>;
  if (sessions.length === 0) return null;

  return (
    <div className="session-list">
      <h2>Past Sessions</h2>
      <div className="session-items">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="session-item"
            onClick={() => onSelectSession(session.id)}
          >
            <div className="session-item-header">
              <span className="meeting-id">Meeting: {session.meetingId}</span>
              <span className={`session-status status-${session.status}`}>
                {session.status}
              </span>
            </div>
            <div className="session-item-meta">
              <span>{new Date(session.createdAt).toLocaleString()}</span>
              <span>{session.botName}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
