import express from "express";
import { joinZoomMeeting, waitForMeetingEnd, ZoomSession } from "./zoom-joiner";
import { startAudioCapture } from "./audio-capture";

const app = express();
app.use(express.json());

const PORT = process.env.BOT_PORT || 3001;
const BACKEND_WS_URL = process.env.BACKEND_WS_URL || "ws://localhost:8000";

// Track active sessions
const activeSessions = new Map<
  string,
  {
    session: ZoomSession;
    stopCapture: () => Promise<void>;
  }
>();

/**
 * POST /start
 * Start a bot that joins a Zoom meeting and captures audio.
 */
app.post("/start", async (req, res) => {
  const { meetingId, passcode, botName, sessionId } = req.body;

  if (!meetingId || !sessionId) {
    return res.status(400).json({ error: "meetingId and sessionId are required" });
  }

  if (activeSessions.has(sessionId)) {
    return res.status(409).json({ error: "Session already active" });
  }

  console.log(`[bot] Starting session ${sessionId} for meeting ${meetingId}`);

  // Respond immediately — the join process takes time
  res.json({ status: "starting", sessionId });

  // Join + capture in the background
  try {
    // 1. Join the meeting
    const zoomSession = await joinZoomMeeting({
      meetingId,
      passcode,
      botName: botName || "Session Scribe Bot",
      headless: process.env.HEADLESS !== "false",
    });

    // 2. Start audio capture
    const capture = await startAudioCapture(zoomSession.page, {
      wsUrl: BACKEND_WS_URL,
      sessionId,
      onChunk: (size) => {
        // Could emit events here for monitoring
      },
      onError: (err) => {
        console.error(`[bot] Audio capture error for ${sessionId}:`, err.message);
      },
      onClose: () => {
        console.log(`[bot] Audio WebSocket closed for ${sessionId}`);
      },
    });

    activeSessions.set(sessionId, {
      session: zoomSession,
      stopCapture: capture.stop,
    });

    console.log(`[bot] Session ${sessionId} fully active`);

    // 3. Monitor for meeting end
    const endReason = await waitForMeetingEnd(zoomSession.page);
    console.log(`[bot] Meeting ended for session ${sessionId}: ${endReason}`);

    // Auto-cleanup when meeting ends
    await cleanupSession(sessionId);
  } catch (error: any) {
    console.error(`[bot] Failed to start session ${sessionId}:`, error.message);
    activeSessions.delete(sessionId);
  }
});

/**
 * POST /stop
 * Stop a running session.
 */
app.post("/stop", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  if (!activeSessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }

  await cleanupSession(sessionId);
  res.json({ status: "stopped", sessionId });
});

/**
 * GET /health
 * Health check with active session info.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    activeSessions: activeSessions.size,
    sessions: Array.from(activeSessions.keys()),
  });
});

/**
 * Clean up a session — stop audio capture and close the browser.
 */
async function cleanupSession(sessionId: string) {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;

  console.log(`[bot] Cleaning up session ${sessionId}`);

  try {
    await entry.stopCapture();
  } catch (e: any) {
    console.error(`[bot] Error stopping capture: ${e.message}`);
  }

  try {
    await entry.session.browser.close();
  } catch (e: any) {
    console.error(`[bot] Error closing browser: ${e.message}`);
  }

  activeSessions.delete(sessionId);
  console.log(`[bot] Session ${sessionId} cleaned up`);
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[bot] Shutting down...");
  for (const sessionId of activeSessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`[bot] Session Scribe Bot service listening on port ${PORT}`);
  console.log(`[bot] Backend WebSocket URL: ${BACKEND_WS_URL}`);
});
