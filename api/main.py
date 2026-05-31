import base64
import os

import httpx
from fastapi import FastAPI, WebSocket, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response

from api.sessions import store, TranscriptSegment
from api.audio_handler import AudioHandler

SCREENSHOTS_DIR = os.environ.get("SCREENSHOTS_DIR", "./screenshots")

app = FastAPI(title="Session Scribe API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

audio_handler = AudioHandler(store)

BOT_SERVICE_URL = os.environ.get("BOT_SERVICE_URL", "http://localhost:3001")


# --- REST Endpoints ---


@app.get("/api/hello")
def hello():
    return {"message": "Session Scribe API is running"}


@app.post("/api/sessions")
async def create_session(body: dict):
    meeting_id = body.get("meetingId")
    passcode = body.get("passcode")
    bot_name = body.get("botName", "Session Scribe Bot")

    if not meeting_id:
        return JSONResponse({"error": "meetingId is required"}, status_code=400)

    session = store.create(meeting_id, passcode, bot_name)

    # Trigger the bot service to join the meeting
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{BOT_SERVICE_URL}/start",
                json={
                    "meetingId": meeting_id,
                    "passcode": passcode,
                    "botName": bot_name,
                    "sessionId": session.id,
                },
                timeout=10.0,
            )
            if resp.status_code != 200:
                store.update_status(
                    session.id, "error", f"Bot service error: {resp.text}"
                )
    except httpx.ConnectError:
        store.update_status(
            session.id,
            "error",
            "Could not connect to bot service. Is it running?",
        )

    return session.to_dict()


@app.get("/api/sessions")
async def list_sessions():
    return [s.to_dict() for s in store.list_all()]


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return session.to_dict()


@app.post("/api/sessions/{session_id}/status")
async def update_session_status(session_id: str, body: dict):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    status = body.get("status", "error")
    error = body.get("error")
    store.update_status(session_id, status, error)
    return {"status": "ok"}


@app.post("/api/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    # Tell bot service to stop
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{BOT_SERVICE_URL}/stop",
                json={"sessionId": session_id},
                timeout=10.0,
            )
    except httpx.ConnectError:
        pass  # Bot may have already stopped

    store.update_status(session_id, "stopped")
    return store.get(session_id).to_dict()


@app.post("/api/sessions/{session_id}/transcribe")
async def transcribe_session(session_id: str, background_tasks: BackgroundTasks):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.audio_file_path or not os.path.exists(session.audio_file_path):
        return JSONResponse({"error": "Audio not available"}, status_code=404)
    if session.status == "transcribing":
        return JSONResponse({"error": "Transcription already in progress"}, status_code=409)

    store.update_status(session_id, "transcribing")
    background_tasks.add_task(run_whisper_transcription, session_id)
    return {"status": "transcribing"}


async def run_whisper_transcription(session_id: str):
    """Send audio to OpenAI Whisper API and store the transcript."""
    session = store.get(session_id)
    if not session:
        return

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        store.update_status(session_id, "error", "OPENAI_API_KEY not configured")
        return

    try:
        print(f"[transcribe] Starting transcription for session {session_id}")

        # Whisper API has a 25MB file limit. Send the file directly.
        async with httpx.AsyncClient(timeout=300.0) as client:
            with open(session.audio_file_path, "rb") as audio_file:
                response = await client.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {openai_api_key}"},
                    files={"file": ("audio.wav", audio_file, "audio/wav")},
                    data={
                        "model": "whisper-1",
                        "response_format": "verbose_json",
                        "timestamp_granularities[]": "segment",
                    },
                )

        if response.status_code != 200:
            error_msg = response.text[:200]
            print(f"[transcribe] OpenAI error: {error_msg}")
            store.update_status(session_id, "error", f"Whisper API error: {error_msg}")
            return

        result = response.json()
        segments = result.get("segments", [])

        # Convert to our TranscriptSegment format
        session.transcript = [
            TranscriptSegment(
                text=seg.get("text", "").strip(),
                start_time=seg.get("start"),
                end_time=seg.get("end"),
            )
            for seg in segments
            if seg.get("text", "").strip()
        ]

        store.update_status(session_id, "stopped")
        print(f"[transcribe] Done — {len(session.transcript)} segments for session {session_id}")

    except Exception as e:
        print(f"[transcribe] Error: {e}")
        store.update_status(session_id, "error", f"Transcription failed: {str(e)}")


@app.get("/api/sessions/{session_id}/audio")
async def get_session_audio(session_id: str):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.audio_file_path or not os.path.exists(session.audio_file_path):
        return JSONResponse({"error": "Audio not available"}, status_code=404)
    return FileResponse(session.audio_file_path, media_type="audio/wav")


@app.post("/api/sessions/{session_id}/screenshots")
async def upload_screenshot(session_id: str, body: dict):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    name = body.get("name", "unknown")
    data = body.get("data", "")

    # Save screenshot to disk
    session_dir = os.path.join(SCREENSHOTS_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    file_path = os.path.join(session_dir, f"{name}.png")

    with open(file_path, "wb") as f:
        f.write(base64.b64decode(data))

    return {"status": "ok", "name": name}


@app.get("/api/sessions/{session_id}/screenshots")
async def list_screenshots(session_id: str):
    session_dir = os.path.join(SCREENSHOTS_DIR, session_id)
    if not os.path.exists(session_dir):
        return []
    files = sorted(f for f in os.listdir(session_dir) if f.endswith(".png"))
    return [{"name": f.replace(".png", ""), "url": f"/api/sessions/{session_id}/screenshots/{f}"} for f in files]


@app.get("/api/sessions/{session_id}/screenshots/{filename}")
async def get_screenshot(session_id: str, filename: str):
    file_path = os.path.join(SCREENSHOTS_DIR, session_id, filename)
    if not os.path.exists(file_path):
        return JSONResponse({"error": "Screenshot not found"}, status_code=404)
    return FileResponse(file_path, media_type="image/png")


# --- WebSocket Endpoints ---


@app.websocket("/ws/audio/{session_id}")
async def audio_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_audio_ws(websocket, session_id)


@app.websocket("/ws/transcript/{session_id}")
async def transcript_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_transcript_ws(websocket, session_id)
