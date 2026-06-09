import { useState, useEffect } from "react";
import { apiFetch } from "../api";
import { Badge } from "./ui/badge";
import { Clock } from "lucide-react";
import { cn } from "../lib/utils";

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
  activeSessionId: string | null;
}

const statusConfig: Record<string, { label: string; variant: "success" | "destructive" | "warning" | "secondary" }> = {
  recording: { label: "Recording", variant: "success" },
  starting: { label: "Starting", variant: "warning" },
  stopped: { label: "Complete", variant: "secondary" },
  transcribing: { label: "Transcribing", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
};

export function SessionList({ onSelectSession, refreshTrigger, activeSessionId }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSessions();
  }, [refreshTrigger]);

  const fetchSessions = async () => {
    try {
      const res = await apiFetch("/api/sessions");
      const data = await res.json();
      setSessions(data);
    } catch (err) {
      console.error("Failed to fetch sessions:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="py-3">
      <div className="px-5 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Sessions
        </h2>
      </div>

      {loading && (
        <div className="px-5 py-4 text-sm text-muted-foreground">Loading...</div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="px-5 py-4 text-sm text-muted-foreground">
          No sessions yet
        </div>
      )}

      <div className="space-y-0.5">
        {sessions.map((session) => {
          const config = statusConfig[session.status] || statusConfig.stopped;
          const isActive = session.id === activeSessionId;

          return (
            <button
              key={session.id}
              className={cn(
                "w-full text-left px-5 py-3 transition-colors cursor-pointer border-none bg-transparent",
                "hover:bg-accent/50",
                isActive && "bg-accent"
              )}
              onClick={() => onSelectSession(session.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-sidebar-foreground truncate">
                    {session.botName}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    <span>{formatDate(session.createdAt)}</span>
                  </div>
                </div>
                <Badge variant={config.variant} className="shrink-0 mt-0.5">
                  {config.label}
                </Badge>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
