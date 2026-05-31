import { useState } from "react";

interface Props {
  onSessionStarted: (sessionId: string) => void;
}

export function JoinMeetingForm({ onSessionStarted }: Props) {
  const [meetingId, setMeetingId] = useState("");
  const [passcode, setPasscode] = useState("");
  const [botName, setBotName] = useState("Session Scribe Bot");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId: meetingId.trim(),
          passcode: passcode.trim() || undefined,
          botName: botName.trim(),
        }),
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

  return (
    <form onSubmit={handleSubmit} className="join-form">
      <h2>Join a Meeting</h2>

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

      <button type="submit" disabled={loading || !meetingId.trim()}>
        {loading ? "Joining..." : "Join Meeting"}
      </button>
    </form>
  );
}
