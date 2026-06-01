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


@app.post("/api/sessions/{session_id}/refine-summary")
async def refine_session_summary(session_id: str, body: dict):
    session = store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.summary:
        return JSONResponse({"error": "No summary to refine"}, status_code=400)

    corrections = body.get("corrections", "").strip()
    if not corrections:
        return JSONResponse({"error": "corrections field is required"}, status_code=400)

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        return JSONResponse({"error": "OPENAI_API_KEY not configured"}, status_code=500)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {openai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are a clinical documentation assistant. You previously generated a "
                                "DIR/Floortime session note. The therapist has provided corrections or "
                                "additional instructions. Apply their feedback to produce an updated session "
                                "note. Preserve the same structure and style, only modifying what the "
                                "therapist has asked to change."
                            ),
                        },
                        {
                            "role": "user",
                            "content": (
                                f"Here is the current session note:\n\n{session.summary}\n\n"
                                f"Please apply the following corrections:\n\n{corrections}"
                            ),
                        },
                    ],
                    "max_tokens": 3000,
                    "temperature": 0.3,
                },
            )

        if response.status_code != 200:
            return JSONResponse(
                {"error": f"OpenAI error: {response.text[:200]}"},
                status_code=502,
            )

        result = response.json()
        session.summary = result["choices"][0]["message"]["content"]
        return {"summary": session.summary}

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


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
    """Generate a DIR/Floortime session note from a therapy session transcript."""
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
                                "You are a clinical documentation assistant for a DIR/Floortime therapist (QHP). "
                                "Given a transcript of a therapy session, generate a detailed session note in the following structure:\n\n"
                                "1. **Header**: Include Client (use CLIENT as placeholder), DIR Player name (identify from transcript), and QHP: Avital Balsam\n\n"
                                "2. **Opening summary paragraph**: QHP observed CLIENT's performance in relevant developmental areas "
                                "(reciprocal communication, shared attention, symbolic thinking, emotional regulation, flexible problem solving, "
                                "peer interaction) throughout the session activities. Note any areas of improvement.\n\n"
                                "3. **Activities list**: Brief bullet list of activities that occurred during the session.\n\n"
                                "4. **Detailed narrative paragraphs**: For each major activity or interaction, write a paragraph describing:\n"
                                "   - What CLIENT did and how they engaged\n"
                                "   - Which developmental capacities were demonstrated\n"
                                "   - How CLIENT remained emotionally connected and socially engaged\n"
                                "   - Any quotes from CLIENT (use exact words from transcript when available)\n\n"
                                "5. **Communication paragraph**: Describe CLIENT's verbal communication, including direct quotes from the session.\n\n"
                                "6. **Skills generalizing**: List skills that are generalizing across multiple settings.\n\n"
                                "7. **DIR strategies utilized**: List the DIR strategies used during the session (e.g., Following the child's lead, "
                                "Expanding circles of communication, Co-regulation through playful affect, Supporting symbolic thinking, "
                                "Declarative language, Reflecting the child's intent, Supporting peer interaction, "
                                "Encouraging shared problem solving, Supporting flexible thinking during transitions, Modeling complex language).\n\n"
                                "8. **QHP coaching paragraph**: Describe coaching provided to the DIR Player regarding supporting the client's "
                                "development, including specific strategies modeled or discussed.\n\n"
                                "Use professional clinical language. Refer to the child as CLIENT throughout. "
                                "Focus on developmental capacities, emotional engagement, and social connection. "
                                "Do not include identifying information beyond what is structurally required.\n\n"
                                "Here is an example of a completed session note for reference:\n\n"
                                "---\n"
                                "Client: CLIENT\n"
                                "DIR Player: Halka\n"
                                "QHP: Avital Balsam\n\n"
                                "QHP observed CLIENT's performance in reciprocal communication, shared attention, symbolic thinking, "
                                "emotional regulation, flexible problem solving, and peer interaction throughout highly interactive movement "
                                "activities, imaginative play, cooperative transitions, and collaborative conversations with Halka and peers. "
                                "CLIENT is showing improvement in flexible thinking as seen by transitioning between multiple activities and "
                                "environments while remaining emotionally connected and engaged with Halka and peers throughout the session.\n\n"
                                "Activities during the session included:\n\n"
                                "Building and discussing pretend models including a dinosaur and camper while organizing backpacks and materials\n\n"
                                "Participating in indoor and outdoor movement activities including walking safely outside, transitioning between "
                                "rooms, and discussing gym activities\n\n"
                                "Engaging in imaginative and problem-solving conversations involving a crawling bug, prize trading, and room availability\n\n"
                                "CLIENT remained emotionally engaged throughout imaginative conversations involving building a dinosaur and camper "
                                "model with Halka and peers. CLIENT participated in symbolic conversations about where the camper should go, what "
                                "the dinosaur was doing, and how different pretend items could work together. CLIENT demonstrated increased shared "
                                "attention by remaining connected during extended collaborative conversations and responding to ideas introduced by "
                                "peers and Halka.\n\n"
                                "CLIENT also participated in cooperative transitions while moving between indoor and outdoor spaces. During these "
                                "transitions, Halka supported CLIENT in walking safely, staying with the group, and adapting to changes when certain "
                                "rooms were unavailable for activities. CLIENT demonstrated improved flexibility when plans changed and tolerated "
                                "redirection while remaining emotionally regulated and socially engaged.\n\n"
                                "CLIENT used verbal communication to comment on activities, share ideas, ask questions, and engage socially throughout "
                                "the session. CLIENT stated, \"The dinosaur needs to go in the camper,\" \"The bug is crawling fast,\" and \"Can we "
                                "play in the gym?\" CLIENT also participated in conversations about backpacks, prizes, rooms, and transitions between "
                                "activities while remaining emotionally connected and engaged.\n\n"
                                "CLIENT demonstrated growing emotional regulation skills by remaining engaged during multiple transitions, "
                                "environmental changes, and unexpected situations throughout the session. CLIENT also demonstrated improved peer "
                                "interaction skills through cooperative conversations, shared imaginative play, collaborative problem solving, and "
                                "group movement activities.\n\n"
                                "The following skills are generalizing across multiple settings:\n\n"
                                "Flexible thinking\n\n"
                                "Reciprocal communication\n\n"
                                "DIR strategies utilized during the session included:\n\n"
                                "Following the child's lead\n\n"
                                "Expanding circles of communication\n\n"
                                "Co-regulation through playful affect\n\n"
                                "Supporting symbolic thinking and imaginative play\n\n"
                                "Declarative language\n\n"
                                "Reflecting the child's intent\n\n"
                                "Supporting peer interaction\n\n"
                                "Encouraging shared problem solving\n\n"
                                "Supporting flexible thinking during transitions\n\n"
                                "Modeling complex language\n\n"
                                "QHP provided coaching to Halka regarding supporting emotional regulation and flexibility during highly active "
                                "transitions and socially demanding group activities. QHP modeled the use of declarative comments, playful affect, "
                                "and reflective language to support longer circles of communication and deeper emotional engagement. Guidance was "
                                "also provided on continuing to expand imaginative play themes, collaborative problem-solving opportunities, and "
                                "peer interactions through movement-based activities and emotionally meaningful shared experiences.\n"
                                "---"
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"Please generate a DIR/Floortime session note from the following therapy session transcript:\n\n{transcript_text[:15000]}",
                        },
                    ],
                    "max_tokens": 3000,
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
