import { useState } from "react";
import { JoinMeetingForm } from "./components/JoinMeetingForm";
import { LiveTranscript } from "./components/LiveTranscript";
import { SessionList } from "./components/SessionList";
import { LoginPage } from "./components/LoginPage";
import { TemplateManager } from "./components/TemplateManager";
import { useAuth } from "./auth/AuthContext";
import { Button } from "./components/ui/button";
import { LogOut, FileText, Plus, LayoutTemplate } from "lucide-react";
import { cn } from "./lib/utils";

type View = "home" | "live" | "templates";

function App() {
  const { user, loading, signOut } = useAuth();
  const [view, setView] = useState<View>("home");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [preSelectedTemplateId, setPreSelectedTemplateId] = useState<string>("");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex items-center gap-3 text-muted-foreground">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const handleSessionStarted = (sessionId: string, templateId?: string) => {
    setActiveSessionId(sessionId);
    if (templateId) setPreSelectedTemplateId(templateId);
    setRefreshTrigger((n) => n + 1);
    setView("live");
  };

  const handleStop = () => {
    setRefreshTrigger((n) => n + 1);
  };

  const handleBack = () => {
    setView("home");
    setActiveSessionId(null);
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-72 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-5 border-b border-sidebar-border">
          <button
            onClick={handleBack}
            className="flex items-center gap-2.5 cursor-pointer bg-transparent border-none p-0"
          >
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10">
              <FileText className="h-4 w-4 text-primary" />
            </div>
            <h1 className="text-base font-semibold text-sidebar-foreground tracking-tight">
              Session Scribe
            </h1>
          </button>
        </div>

        <nav className="px-3 pt-3 space-y-1">
          <button
            onClick={() => { setView("home"); setActiveSessionId(null); }}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer border-none",
              view === "home" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50 bg-transparent"
            )}
          >
            <Plus className="h-4 w-4" />
            New Session
          </button>
          <button
            onClick={() => setView("templates")}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer border-none",
              view === "templates" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent/50 bg-transparent"
            )}
          >
            <LayoutTemplate className="h-4 w-4" />
            Templates
          </button>
        </nav>

        <div className="flex-1 overflow-y-auto">
          <SessionList
            onSelectSession={(id) => {
              setActiveSessionId(id);
              setView("live");
            }}
            refreshTrigger={refreshTrigger}
            activeSessionId={activeSessionId}
          />
        </div>

        <div className="p-4 border-t border-sidebar-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xs font-medium text-primary">
                  {user.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-sidebar-foreground truncate">
                  {user.name}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {user.email}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={signOut}
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        {view === "home" && (
          <div className="max-w-2xl mx-auto p-8">
            <JoinMeetingForm
              onSessionStarted={handleSessionStarted}
              preSelectedTemplateId={preSelectedTemplateId}
            />
          </div>
        )}

        {view === "live" && activeSessionId && (
          <LiveTranscript
            sessionId={activeSessionId}
            onStop={handleStop}
            initialTemplateId={preSelectedTemplateId}
          />
        )}

        {view === "templates" && (
          <TemplateManager
            onStartSession={(templateId) => {
              setPreSelectedTemplateId(templateId);
              setView("home");
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
