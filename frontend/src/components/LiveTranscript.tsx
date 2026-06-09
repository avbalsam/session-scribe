import { useState, useEffect } from "react";
import { useSessionSocket } from "../hooks/useTranscriptSocket";
import { API_BASE_URL } from "../config";
import { apiFetch } from "../api";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { Textarea } from "./ui/textarea";
import {
  Square,
  Play,
  Copy,
  Check,
  RefreshCw,
  Mic,
  Volume2,
  VolumeX,
  Clock,
  FileText,
  Image,
} from "lucide-react";

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
  const [corrections, setCorrections] = useState("");
  const [refining, setRefining] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fetchScreenshots = async () => {
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/screenshots`);
        const data = await res.json();
        setScreenshots(data);
      } catch {}
    };
    fetchScreenshots();
    const interval = setInterval(fetchScreenshots, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (status === "stopped" || status === "transcribing") {
      fetchTranscript();
    }
  }, [status]);

  useEffect(() => {
    if (!transcribing) return;
    const interval = setInterval(async () => {
      const res = await apiFetch(`/api/sessions/${sessionId}`);
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
      const res = await apiFetch(`/api/sessions/${sessionId}`);
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
      await apiFetch(`/api/sessions/${sessionId}/stop`, { method: "POST" });
      onStop();
    } catch (err) {
      console.error("Failed to stop session:", err);
    }
  };

  const handleTranscribe = async () => {
    setTranscribing(true);
    try {
      await apiFetch(`/api/sessions/${sessionId}/transcribe`, { method: "POST" });
    } catch (err) {
      console.error("Failed to start transcription:", err);
      setTranscribing(false);
    }
  };

  const handleRefine = async () => {
    if (!corrections.trim()) return;
    setRefining(true);
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/refine-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corrections: corrections.trim() }),
      });
      const data = await res.json();
      if (data.summary) {
        setSummary(data.summary);
        setCorrections("");
      }
    } catch (err) {
      console.error("Failed to refine summary:", err);
    } finally {
      setRefining(false);
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
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-foreground">Session</h2>
          {connected ? (
            <Badge variant="success" className="gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-slow" />
              Recording
            </Badge>
          ) : transcribing ? (
            <Badge variant="warning" className="gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse-slow" />
              Transcribing
            </Badge>
          ) : isStopped ? (
            <Badge variant="secondary">Complete</Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse-slow" />
              Connecting
            </Badge>
          )}
        </div>
        {isRecording && (
          <Button variant="destructive" size="sm" onClick={handleStop}>
            <Square className="h-3.5 w-3.5" />
            Stop Recording
          </Button>
        )}
      </div>

      {/* Recording Monitor */}
      {isRecording && (
        <Card>
          <CardContent className="p-5">
            <div className="space-y-3">
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-success via-warning to-destructive transition-all duration-150"
                  style={{ width: `${Math.min(level * 500, 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span className="font-mono">{formatDuration(duration)}</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  {level > 0.01 ? (
                    <>
                      <Volume2 className="h-3.5 w-3.5 text-success" />
                      <span className="text-success text-xs font-medium">Audio detected</span>
                    </>
                  ) : (
                    <>
                      <VolumeX className="h-3.5 w-3.5" />
                      <span className="text-xs">Silence</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Audio Playback */}
      {isStopped && (
        <Card>
          <CardContent className="p-5 space-y-4">
            <audio
              controls
              src={`${API_BASE_URL}/api/sessions/${sessionId}/audio`}
              className="w-full h-10"
            />
            {transcript.length === 0 && !transcribing && (
              <Button onClick={handleTranscribe} className="w-full">
                <FileText className="h-4 w-4" />
                Generate Transcript
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Transcribing Indicator */}
      {transcribing && (
        <Card>
          <CardContent className="p-8 flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Transcribing audio with Whisper...</p>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      {summary && (
        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Session Summary</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(summary);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-success" />
                    <span className="text-success">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap bg-muted/50 rounded-lg p-4">
              {summary}
            </div>
            <div className="space-y-3 pt-2 border-t border-border">
              <Textarea
                placeholder="Enter corrections or additional instructions..."
                value={corrections}
                onChange={(e) => setCorrections(e.target.value)}
                rows={3}
              />
              <Button
                onClick={handleRefine}
                disabled={refining || !corrections.trim()}
                variant="secondary"
                size="sm"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refining ? "animate-spin" : ""}`} />
                {refining ? "Refining..." : "Refine Summary"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transcript */}
      {transcript.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Transcript</h3>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {transcript.map((seg, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  {seg.startTime !== null && (
                    <span className="font-mono text-xs text-muted-foreground pt-0.5 shrink-0 w-10">
                      {formatTimestamp(seg.startTime)}
                    </span>
                  )}
                  <span className="text-foreground leading-relaxed">{seg.text}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Image className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Bot Screenshots</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {screenshots.map((s) => (
                <div key={s.name} className="group">
                  <img
                    src={`${API_BASE_URL}${s.url}`}
                    alt={s.name}
                    loading="lazy"
                    className="rounded-lg border border-border w-full object-cover transition-all group-hover:border-primary/50 group-hover:shadow-md"
                  />
                  <p className="text-xs text-muted-foreground mt-1.5 text-center">{s.name}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
