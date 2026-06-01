import asyncio
import base64
import os
import subprocess
import tempfile
from typing import Optional

import httpx
from fastapi import FastAPI, WebSocket, BackgroundTasks, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response

from api.sessions import store, TranscriptSegment
from api.audio_handler import AudioHandler

SCREENSHOTS_DIR = os.environ.get("SCREENSHOTS_DIR", "./screenshots")
AUDIO_SAVE_DIR = os.environ.get("AUDIO_SAVE_DIR", "./audio")

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
    zoom_link = body.get("zoomLink")
    source = body.get("source")  # "system-audio" for browser recording
    bot_name = body.get("botName", "Session Scribe Bot")

    if not meeting_id and not zoom_link and source != "system-audio":
        return JSONResponse({"error": "meetingId, zoomLink, or source is required"}, status_code=400)

    session = store.create(meeting_id or zoom_link or source, passcode, bot_name)

    # Trigger the bot service to join the meeting (skip for system-audio sessions)
    if source != "system-audio":
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{BOT_SERVICE_URL}/start",
                    json={
                        "meetingId": meeting_id,
                        "zoomLink": zoom_link,
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


async def extract_audio_to_wav(input_path: str, output_path: str) -> None:
    """Extract audio from any media file and convert to WAV (16kHz mono PCM16) using ffmpeg."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-i", input_path,
        "-vn",  # no video
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        output_path,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {stderr.decode()[:500]}")


@app.post("/api/sessions/upload")
async def create_session_from_upload(
    file: UploadFile = File(...),
    botName: str = Form("Session Scribe"),
):
    """Create a session from an uploaded video/audio file."""
    os.makedirs(AUDIO_SAVE_DIR, exist_ok=True)

    session = store.create("uploaded-file", None, botName)

    # Save uploaded file to a temp location
    suffix = os.path.splitext(file.filename or "upload")[1] or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    # Extract audio to WAV
    wav_path = os.path.join(AUDIO_SAVE_DIR, f"{session.id}_upload.wav")
    try:
        await extract_audio_to_wav(tmp_path, wav_path)
    except RuntimeError as e:
        os.unlink(tmp_path)
        store.update_status(session.id, "error", str(e))
        return JSONResponse({"error": f"Audio extraction failed: {e}"}, status_code=400)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    session.audio_file_path = wav_path
    store.update_status(session.id, "stopped")
    return session.to_dict()


@app.post("/api/sessions/{session_id}/upload-audio")
async def upload_session_audio(session_id: str, file: UploadFile = File(...)):
    """Upload a recorded audio blob for an existing session (e.g. system audio recording)."""
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    os.makedirs(AUDIO_SAVE_DIR, exist_ok=True)

    suffix = os.path.splitext(file.filename or "recording")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    wav_path = os.path.join(AUDIO_SAVE_DIR, f"{session_id}_recording.wav")
    try:
        await extract_audio_to_wav(tmp_path, wav_path)
    except RuntimeError as e:
        os.unlink(tmp_path)
        store.update_status(session_id, "error", str(e))
        return JSONResponse({"error": f"Audio extraction failed: {e}"}, status_code=400)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    session.audio_file_path = wav_path
    store.update_status(session_id, "stopped")
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

        print(f"[transcribe] Got {len(session.transcript)} segments, generating summary...")

        # Generate summary using a low-cost model
        full_text = " ".join(seg.text for seg in session.transcript)
        if full_text.strip():
            session.summary = await generate_session_summary(full_text, openai_api_key)

        store.update_status(session_id, "stopped")
        print(f"[transcribe] Done — {len(session.transcript)} segments + summary for session {session_id}")

    except Exception as e:
        print(f"[transcribe] Error: {e}")
        store.update_status(session_id, "error", f"Transcription failed: {str(e)}")


async def generate_session_summary(transcript_text: str, api_key: str) -> Optional[str]:
    """Generate a therapy session summary using GPT-4o-mini."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are a clinical documentation assistant helping a therapist summarize therapy sessions. "
                                "Given a transcript of a therapy session, provide a concise clinical summary that includes:\n"
                                "1. **Presenting concerns**: What the client discussed or brought up\n"
                                "2. **Key themes**: Recurring topics, emotions, or patterns observed\n"
                                "3. **Interventions used**: Any therapeutic techniques or approaches the therapist employed\n"
                                "4. **Client progress/insights**: Notable moments of insight, breakthroughs, or resistance\n"
                                "5. **Follow-up considerations**: Topics to revisit or homework assigned\n\n"
                                "Keep the summary professional, objective, and suitable for clinical notes. "
                                "Do not include any identifying information beyond what is in the transcript. "
                                "Use concise bullet points within each section."
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"Please summarize the following therapy session transcript:\n\n{transcript_text[:15000]}",
                        },
                    ],
                    "max_tokens": 1000,
                    "temperature": 0.3,
                },
            )

        if response.status_code != 200:
            print(f"[summary] OpenAI error: {response.text[:200]}")
            return None

        result = response.json()
        return result["choices"][0]["message"]["content"]

    except Exception as e:
        print(f"[summary] Error generating summary: {e}")
        return None


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
