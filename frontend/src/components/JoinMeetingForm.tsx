import { useState, useRef, useEffect } from "react";
import { apiFetch } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { cn } from "../lib/utils";
import { Link, Hash, Upload, Mic, Square, Play } from "lucide-react";

interface Props {
  onSessionStarted: (sessionId: string, templateId?: string) => void;
  preSelectedTemplateId?: string;
}

type InputMode = "link" | "manual" | "upload" | "system-audio";

const modes: { value: InputMode; label: string; icon: typeof Link }[] = [
  { value: "link", label: "Zoom Link", icon: Link },
  { value: "manual", label: "Meeting ID", icon: Hash },
  { value: "upload", label: "Upload", icon: Upload },
  { value: "system-audio", label: "System Audio", icon: Mic },
];

export function JoinMeetingForm({ onSessionStarted, preSelectedTemplateId }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>("link");
  const [zoomLink, setZoomLink] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [botName, setBotName] = useState("Session Scribe Bot");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string; isSystem?: boolean }[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(preSelectedTemplateId || "");

  useEffect(() => {
    apiFetch("/api/templates")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setTemplates(data);
          if (!selectedTemplateId) {
            const system = data.find((t: any) => t.isSystem);
            if (system) setSelectedTemplateId(system.id);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (preSelectedTemplateId) setSelectedTemplateId(preSelectedTemplateId);
  }, [preSelectedTemplateId]);

  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!recording) {
      setRecordingDuration(0);
      return;
    }
    const interval = setInterval(() => setRecordingDuration((d) => d + 1), 1000);
    return () => clearInterval(interval);
  }, [recording]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (inputMode === "upload") {
      await handleUpload();
    } else if (inputMode === "system-audio") {
      await handleSystemAudioStart();
    } else {
      await handleZoomJoin();
    }

    setLoading(false);
  };

  const handleZoomJoin = async () => {
    if (inputMode === "link") {
      window.open(zoomLink.trim(), "_blank");
    } else {
      const normalizedId = meetingId.trim().replace(/[\s-]/g, "");
      window.open(`https://zoom.us/j/${normalizedId}`, "_blank");
    }

    const payload = inputMode === "link"
      ? { zoomLink: zoomLink.trim(), botName: botName.trim() }
      : { meetingId: meetingId.trim(), passcode: passcode.trim() || undefined, botName: botName.trim() };

    try {
      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        onSessionStarted(data.id, selectedTemplateId || undefined);
      }
    } catch (err: any) {
      setError(err.message || "Failed to start session");
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("botName", botName.trim());

    try {
      const res = await apiFetch("/api/sessions/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        onSessionStarted(data.id, selectedTemplateId || undefined);
      }
    } catch (err: any) {
      setError(err.message || "Failed to upload file");
    }
  };

  const handleSystemAudioStart = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });

      stream.getVideoTracks().forEach((t) => t.stop());

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        setError("No audio track available. Make sure to check 'Share audio' in the dialog.");
        return;
      }

      const audioStream = new MediaStream(stream.getAudioTracks());

      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "system-audio", botName: botName.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        audioStream.getTracks().forEach((t) => t.stop());
        setError(data.error);
        return;
      }

      sessionIdRef.current = data.id;

      const recorder = new MediaRecorder(audioStream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", blob, "recording.webm");

        try {
          await apiFetch(
            `/api/sessions/${sessionIdRef.current}/upload-audio`,
            { method: "POST", body: formData }
          );
        } catch (err: any) {
          console.error("Failed to upload recording:", err);
        }

        audioStream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (sessionIdRef.current) {
          onSessionStarted(sessionIdRef.current, selectedTemplateId || undefined);
        }
      };

      audioStream.getAudioTracks()[0].addEventListener("ended", () => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      });

      recorder.start(1000);
      setRecording(true);
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setError("Screen sharing was cancelled.");
      } else {
        setError(err.message || "Failed to start system audio capture");
      }
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const isValid = (() => {
    switch (inputMode) {
      case "link": return zoomLink.trim().length > 0;
      case "manual": return meetingId.trim().length > 0;
      case "upload": return file !== null;
      case "system-audio": return true;
    }
  })();

  if (recording) {
    const mins = Math.floor(recordingDuration / 60);
    const secs = recordingDuration % 60;
    const timeStr = `${mins}:${String(secs).padStart(2, "0")}`;

    return (
      <Card>
        <CardContent className="p-8 flex flex-col items-center gap-6">
          <div className="flex items-center justify-center h-16 w-16 rounded-full bg-destructive/10">
            <Mic className="h-7 w-7 text-destructive animate-pulse-slow" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground mb-1">Recording System Audio</p>
            <p className="text-3xl font-mono font-semibold text-foreground tracking-wider">{timeStr}</p>
          </div>
          <Button variant="destructive" size="lg" onClick={handleStopRecording}>
            <Square className="h-4 w-4" />
            Stop Recording & Upload
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New Session</CardTitle>
        <CardDescription>
          Start a new session by joining a meeting, uploading a recording, or capturing system audio.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Mode Selector */}
          <div className="flex gap-1 p-1 bg-muted rounded-lg">
            {modes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-all cursor-pointer border-none",
                  inputMode === value
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground bg-transparent"
                )}
                onClick={() => setInputMode(value)}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Mode-specific inputs */}
          {inputMode === "link" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="zoomLink">
                Zoom Link
              </label>
              <Input
                id="zoomLink"
                type="text"
                placeholder="https://zoom.us/j/1234567890?pwd=..."
                value={zoomLink}
                onChange={(e) => setZoomLink(e.target.value)}
                required
              />
            </div>
          )}

          {inputMode === "manual" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground" htmlFor="meetingId">
                  Meeting ID
                </label>
                <Input
                  id="meetingId"
                  type="text"
                  placeholder="123 456 7890"
                  value={meetingId}
                  onChange={(e) => setMeetingId(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground" htmlFor="passcode">
                  Passcode
                  <span className="text-muted-foreground font-normal ml-1">(optional)</span>
                </label>
                <Input
                  id="passcode"
                  type="text"
                  placeholder="Meeting passcode"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                />
              </div>
            </div>
          )}

          {inputMode === "upload" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="fileUpload">
                Video or Audio File
              </label>
              <Input
                id="fileUpload"
                type="file"
                accept="video/*,audio/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="cursor-pointer file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary"
              />
              {file && (
                <p className="text-xs text-muted-foreground">{file.name}</p>
              )}
            </div>
          )}

          {inputMode === "system-audio" && (
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Click below to start capturing your system audio. You'll be prompted to select a screen or window to share audio from.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground" htmlFor="botName">
              Session Name
            </label>
            <Input
              id="botName"
              type="text"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
            />
          </div>

          {templates.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Template</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select a template...</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.isSystem ? `${t.name} (Built-in)` : t.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/10 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <Button type="submit" disabled={loading || !isValid} className="w-full" size="lg">
            {loading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                Starting...
              </>
            ) : inputMode === "upload" ? (
              <>
                <Upload className="h-4 w-4" />
                Upload & Transcribe
              </>
            ) : inputMode === "system-audio" ? (
              <>
                <Mic className="h-4 w-4" />
                Start Recording
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Join Meeting
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
