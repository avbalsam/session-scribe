import { useState } from "react";
import { API_BASE_URL } from "../config";

interface Props {
  onSessionStarted: (sessionId: string) => void;
}

type InputMode = "link" | "manual";

export function JoinMeetingForm({ onSessionStarted }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>("link");
  const [zoomLink, setZoomLink] = useState("");
  const [meetingId, setMeetingId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [botName, setBotName] = useState("Session Scribe Bot");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    let body: Record<string, string | undefined>;

    if (inputMode === "link") {
      body = {
        zoomLink: zoomLink.trim(),
        botName: botName.trim(),
      };
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
      } else if (data.errorMessage) {
        setError(data.errorMessage);
      } else {
        onSessionStarted(data.id);
      }
    } catch (err: any) {
      setError(err.message || "Failed to start session");
    } finally {
      setLoading(false);
    }
  };

  const isValid = inputMode === "link" ? zoomLink.trim().length > 0 : meetingId.trim().length > 0;

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
      </div>

      {inputMode === "link" ? (
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
      ) : (
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

      <div className="form-field">
        <label htmlFor="botName">Bot Display Name</label>
        <input
          id="botName"
          type="text"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
        />
      </div>

      {error && <div className="error-message">{error}</div>}

      <button type="submit" disabled={loading || !isValid}>
        {loading ? "Joining..." : "Join Meeting"}
      </button>
    </form>
  );
}
