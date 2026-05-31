import { useState } from "react";
import { JoinMeetingForm } from "./components/JoinMeetingForm";
import { LiveTranscript } from "./components/LiveTranscript";
import { SessionList } from "./components/SessionList";

type View = "home" | "live";

function App() {
  const [view, setView] = useState<View>("home");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleSessionStarted = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setView("live");
  };

  const handleStop = () => {
    setActiveSessionId(null);
    setView("home");
    setRefreshTrigger((n) => n + 1);
  };

  const handleBack = () => {
    setView("home");
    setActiveSessionId(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1 onClick={handleBack} style={{ cursor: "pointer" }}>
          Session Scribe
        </h1>
        <p className="subtitle">Zoom meeting transcription</p>
      </header>

      <main className="app-main">
        {view === "home" && (
          <>
            <JoinMeetingForm onSessionStarted={handleSessionStarted} />
            <SessionList
              onSelectSession={(id) => {
                setActiveSessionId(id);
                setView("live");
              }}
              refreshTrigger={refreshTrigger}
            />
          </>
        )}

        {view === "live" && activeSessionId && (
          <LiveTranscript sessionId={activeSessionId} onStop={handleStop} />
        )}
      </main>
    </div>
  );
}

export default App;
