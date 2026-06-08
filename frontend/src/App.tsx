import { useState, useEffect } from "react";
import { JoinMeetingForm } from "./components/JoinMeetingForm";
import { LiveTranscript } from "./components/LiveTranscript";
import { SessionList } from "./components/SessionList";
import { LoginPage } from "./components/LoginPage";
import { useAuth } from "./auth/AuthContext";
import { apiFetch } from "./api";

type View = "home" | "live";

function App() {
  const { user, loading, signOut } = useAuth();
  const [view, setView] = useState<View>("home");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("starting");
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Poll session status while active
  useEffect(() => {
    if (!activeSessionId) return;

    const poll = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/sessions/${activeSessionId}`);
        const data = await res.json();
        setSessionStatus(data.status);
      } catch {}
    }, 2000);

    return () => clearInterval(poll);
  }, [activeSessionId]);

  if (loading) {
    return (
      <div className="app">
        <p style={{ textAlign: "center", marginTop: "2rem" }}>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const handleSessionStarted = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setSessionStatus("starting");
    setView("live");
  };

  const handleStop = () => {
    setSessionStatus("stopped");
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
        <div className="header-right">
          <span className="user-info">{user.name}</span>
          <button className="logout-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        {view === "home" && (
          <>
            <JoinMeetingForm onSessionStarted={handleSessionStarted} />
            <SessionList
              onSelectSession={(id) => {
                setActiveSessionId(id);
                setSessionStatus("stopped");
                setView("live");
              }}
              refreshTrigger={refreshTrigger}
            />
          </>
        )}

        {view === "live" && activeSessionId && (
          <LiveTranscript
            sessionId={activeSessionId}
            status={sessionStatus}
            onStop={handleStop}
          />
        )}
      </main>
    </div>
  );
}

export default App;
