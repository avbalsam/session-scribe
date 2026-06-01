import express from "express";
import http from "http";
import https from "https";
import { joinZoomMeeting, waitForMeetingEnd, screenshot, ZoomSession } from "./zoom-joiner";
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
    debugInterval?: ReturnType<typeof setInterval>;
  }
>();

/**
 * POST /start
 * Start a bot that joins a Zoom meeting and captures audio.
 */
app.post("/start", async (req, res) => {
  const { meetingId, zoomLink, passcode, botName, sessionId } = req.body;

  if ((!meetingId && !zoomLink) || !sessionId) {
    return res.status(400).json({ error: "(meetingId or zoomLink) and sessionId are required" });
  }

  if (activeSessions.has(sessionId)) {
    return res.status(409).json({ error: "Session already active" });
  }

  console.log(`[bot] Starting session ${sessionId} for meeting ${meetingId || zoomLink}`);

  // Respond immediately — the join process takes time
  res.json({ status: "starting", sessionId });

  const backendHttpUrl = BACKEND_WS_URL.replace(/^ws/, "http");

  // Join + capture in the background
  try {
    // 1. Join the meeting
    const zoomSession = await joinZoomMeeting({
      meetingId,
      zoomLink,
      passcode,
      botName: botName || "Session Scribe Bot",
      sessionId,
      backendUrl: backendHttpUrl,
      headless: process.env.HEADLESS !== "false",
    });

    // 2. Start audio capture with connection verification
    let audioConnected = false;
    const capture = await startAudioCapture(zoomSession.page, {
      wsUrl: BACKEND_WS_URL,
      sessionId,
      onConnect: () => {
        audioConnected = true;
      },
      onChunk: () => {},
      onError: (err) => {
        console.error(`[bot] Audio capture error for ${sessionId}:`, err.message);
        if (!audioConnected) {
          reportStatus(backendHttpUrl, sessionId, "error", `Audio WebSocket failed: ${err.message}`);
        }
      },
      onClose: () => {
        console.log(`[bot] Audio WebSocket closed for ${sessionId}`);
      },
    });

    // Wait for audio WebSocket to connect (up to 10s)
    for (let i = 0; i < 20 && !audioConnected; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!audioConnected) {
      console.error(`[bot] Audio WebSocket did not connect for ${sessionId} after 10s`);
      reportStatus(backendHttpUrl, sessionId, "error", "Audio WebSocket failed to connect to backend");
      await capture.stop();
      await zoomSession.browser.close();
      activeSessions.delete(sessionId);
      return;
    }

    // Start periodic debug screenshots every 10s
    let debugCount = 0;
    const debugInterval = setInterval(async () => {
      debugCount++;
      try {
        await screenshot(zoomSession.page, `debug-${String(debugCount).padStart(3, "0")}`, sessionId, backendHttpUrl);
      } catch (e: any) {
        console.error(`[bot] Debug screenshot failed: ${e.message}`);
      }
    }, 10000);

    activeSessions.set(sessionId, {
      session: zoomSession,
      stopCapture: capture.stop,
      debugInterval,
    });

    console.log(`[bot] Session ${sessionId} fully active — audio streaming, debug screenshots every 10s`);

    // 3. Monitor for meeting end
    const endReason = await waitForMeetingEnd(zoomSession.page);
    console.log(`[bot] Meeting ended for session ${sessionId}: ${endReason}`);

    // Auto-cleanup when meeting ends
    await cleanupSession(sessionId);
  } catch (error: any) {
    console.error(`[bot] Failed to start session ${sessionId}:`, error.message);
    reportStatus(backendHttpUrl, sessionId, "error", error.message);
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

  if (entry.debugInterval) {
    clearInterval(entry.debugInterval);
  }

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

/**
 * Report session status back to the backend.
 */
function reportStatus(backendUrl: string, sessionId: string, status: string, error?: string) {
  const url = `${backendUrl}/api/sessions/${sessionId}/status`;
  const body = JSON.stringify({ status, error });
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;

  const req = client.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, () => {});
  req.on("error", (e) => {
    console.error(`[bot] Failed to report status: ${e.message}`);
  });
  req.write(body);
  req.end();
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
