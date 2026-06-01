import { useState, useRef } from "react";
import { API_BASE_URL } from "../config";

interface Props {
  onSessionStarted: (sessionId: string) => void;
}

type InputMode = "link" | "manual" | "upload" | "system-audio";

export function JoinMeetingForm({ onSessionStarted }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>("link");
  const [zoomLink, setZoomLink] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [botName, setBotName] = useState("Session Scribe Bot");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  // System audio recording state
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string | null>(null);

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
    // Open Zoom for the user
    if (inputMode === "link") {
      window.open(zoomLink.trim(), "_blank");
    } else {
      const normalizedId = meetingId.trim().replace(/[\s-]/g, "");
      window.open(`https://zoom.us/j/${normalizedId}`, "_blank");
    }

    let body: Record<string, string | undefined>;
    if (inputMode === "link") {
      body = { zoomLink: zoomLink.trim(), botName: botName.trim() };
    } else {
      body = {
        meetingId: meetingId.trim(),
        passcode: passcode.trim() || undefined,
        botName: botName.trim(),
      };
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        onSessionStarted(data.id);
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
      const res = await fetch(`${API_BASE_URL}/api/sessions/upload`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        onSessionStarted(data.id);
      }
    } catch (err: any) {
      setError(err.message || "Failed to upload file");
    }
  };

  const handleSystemAudioStart = async () => {
    try {
      // Request system audio capture
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: false,
      });

      // Check we actually got an audio track
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        setError("No audio track available. Make sure to share audio.");
        return;
      }

      // Create session on backend
      const res = await fetch(`${API_BASE_URL}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "system-audio", botName: botName.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        stream.getTracks().forEach((t) => t.stop());
        setError(data.error);
        return;
      }

      sessionIdRef.current = data.id;

      // Start recording
      const recorder = new MediaRecorder(stream, {
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
        // Upload recorded audio to backend
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", blob, "recording.webm");

        try {
          await fetch(
            `${API_BASE_URL}/api/sessions/${sessionIdRef.current}/upload-audio`,
            { method: "POST", body: formData }
          );
        } catch (err: any) {
          console.error("Failed to upload recording:", err);
        }

        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
      };

      // Also stop if the user stops sharing
      stream.getAudioTracks()[0].addEventListener("ended", () => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      });

      recorder.start(1000); // collect in 1s chunks
      setRecording(true);
      onSessionStarted(data.id);
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
    return (
      <div className="join-form">
        <h2>Recording System Audio</h2>
        <p className="recording-status">Recording in progress...</p>
        <button type="button" className="stop-recording-btn" onClick={handleStopRecording}>
          Stop Recording
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="join-form">
      <h2>Join a Meeting</h2>

      <div className="form-field toggle-field">
        <button
          type="button"
          className={`toggle-btn ${inputMode === "link" ? "active" : ""}`}
          onClick={() => setInputMode("link")}
        >
          Zoom Link
        </button>
        <button
          type="button"
          className={`toggle-btn ${inputMode === "manual" ? "active" : ""}`}
          onClick={() => setInputMode("manual")}
        >
          Meeting ID
        </button>
        <button
          type="button"
          className={`toggle-btn ${inputMode === "upload" ? "active" : ""}`}
          onClick={() => setInputMode("upload")}
        >
          Upload
        </button>
        <button
          type="button"
          className={`toggle-btn ${inputMode === "system-audio" ? "active" : ""}`}
          onClick={() => setInputMode("system-audio")}
        >
          System Audio
        </button>
      </div>

      {inputMode === "link" && (
        <div className="form-field">
          <label htmlFor="zoomLink">Zoom Link</label>
          <input
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
        <>
          <div className="form-field">
            <label htmlFor="meetingId">Meeting ID</label>
            <input
              id="meetingId"
              type="text"
              placeholder="123 456 7890"
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value)}
              required
            />
          </div>
          <div className="form-field">
            <label htmlFor="passcode">Passcode (optional)</label>
            <input
              id="passcode"
              type="text"
              placeholder="Meeting passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
            />
          </div>
        </>
      )}

      {inputMode === "upload" && (
        <div className="form-field">
          <label htmlFor="fileUpload">Video or Audio File</label>
          <input
            id="fileUpload"
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          {file && <p className="file-name">{file.name}</p>}
        </div>
      )}

      {inputMode === "system-audio" && (
        <div className="form-field">
          <p className="helper-text">
            Click below to start capturing your system audio. You'll be prompted to select a screen or window to share audio from.
          </p>
        </div>
      )}

      <div className="form-field">
        <label htmlFor="botName">Session Name</label>
        <input
          id="botName"
          type="text"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
        />
      </div>

      {error && <div className="error-message">{error}</div>}

      <button type="submit" disabled={loading || !isValid}>
        {loading
          ? "Starting..."
          : inputMode === "upload"
          ? "Upload & Transcribe"
          : inputMode === "system-audio"
          ? "Start Recording"
          : "Join Meeting"}
      </button>
    </form>
  );
}
