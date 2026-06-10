import asyncio
import base64
import os
import tempfile
import uuid
from typing import Optional

import math

import httpx
from fastapi import FastAPI, WebSocket, BackgroundTasks, UploadFile, File, Form, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, Response

from fastapi import Request
from fastapi.responses import StreamingResponse

from api.sessions import store, TranscriptSegment
from api.audio_handler import AudioHandler
from api.auth import User, get_current_user, AUTH_SERVICE_URL
from api.database import init_db, close_db, get_pool

AUDIO_SAVE_DIR = os.environ.get("AUDIO_SAVE_DIR", "./audio")

app = FastAPI(title="Session Scribe API")

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

audio_handler = AudioHandler(store)

BOT_SERVICE_URL = os.environ.get("BOT_SERVICE_URL", "http://localhost:3001")


@app.on_event("startup")
async def startup():
    await init_db()


@app.on_event("shutdown")
async def shutdown():
    await close_db()


# --- Auth Proxy (same-origin for frontend cookies) ---


@app.api_route("/api/auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def auth_proxy(request: Request, path: str):
    """Reverse proxy auth requests to the auth service so cookies stay same-origin."""
    url = f"{AUTH_SERVICE_URL}/api/auth/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()

    async with httpx.AsyncClient() as client:
        resp = await client.request(
            method=request.method,
            url=url,
            headers=headers,
            content=body,
            params=request.query_params,
            timeout=15.0,
            follow_redirects=False,
        )

    # Forward response with headers (including set-cookie)
    excluded = {"content-encoding", "transfer-encoding", "content-length"}
    response_headers = {
        k: v for k, v in resp.headers.multi_items() if k.lower() not in excluded
    }

    return StreamingResponse(
        iter([resp.content]),
        status_code=resp.status_code,
        headers=response_headers,
    )


# --- REST Endpoints ---


@app.get("/api/hello")
def hello():
    return {"message": "Session Scribe API is running"}


# Auth is handled by the separate auth-service (Better Auth).
# FastAPI validates sessions via the get_current_user dependency.


@app.post("/api/sessions")
async def create_session(body: dict, user: User = Depends(get_current_user)):
    meeting_id = body.get("meetingId")
    passcode = body.get("passcode")
    zoom_link = body.get("zoomLink")
    source = body.get("source")  # "system-audio" for browser recording
    bot_name = body.get("botName", "Session Scribe Bot")

    if not meeting_id and not zoom_link and source != "system-audio":
        return JSONResponse({"error": "meetingId, zoomLink, or source is required"}, status_code=400)

    template_id = body.get("templateId")
    session = await store.create(meeting_id or zoom_link or source, passcode, bot_name, owner_id=user.id, template_id=template_id)

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
                    await store.update_status(
                        session.id, "error", f"Bot service error: {resp.text}"
                    )
        except httpx.ConnectError:
            await store.update_status(
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
    user: User = Depends(get_current_user),
):
    """Create a session from an uploaded video/audio file."""
    os.makedirs(AUDIO_SAVE_DIR, exist_ok=True)

    session = await store.create("uploaded-file", None, botName, owner_id=user.id)

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
        await store.update_status(session.id, "error", str(e))
        return JSONResponse({"error": f"Audio extraction failed: {e}"}, status_code=400)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    await store.set_audio_path(session.id, wav_path)
    await store.update_status(session.id, "stopped")
    return session.to_dict()


@app.post("/api/sessions/{session_id}/upload-audio")
async def upload_session_audio(session_id: str, file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """Upload a recorded audio blob for an existing session (e.g. system audio recording)."""
    session = await store.get_owned(session_id, user.id)
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
        await store.update_status(session_id, "error", str(e))
        return JSONResponse({"error": f"Audio extraction failed: {e}"}, status_code=400)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    await store.set_audio_path(session_id, wav_path)
    await store.update_status(session_id, "stopped")
    session = await store.get(session_id)
    return session.to_dict()


@app.get("/api/sessions")
async def list_sessions(user: User = Depends(get_current_user)):
    sessions = await store.list_by_owner(user.id)
    return [s.to_dict() for s in sessions]


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return session.to_dict()


@app.post("/api/sessions/{session_id}/status")
async def update_session_status(session_id: str, body: dict):
    session = await store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    status = body.get("status", "error")
    error = body.get("error")
    await store.update_status(session_id, status, error)
    return {"status": "ok"}


@app.post("/api/sessions/{session_id}/stop")
async def stop_session(session_id: str, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
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

    await store.update_status(session_id, "stopped")
    session = await store.get(session_id)
    return session.to_dict()


@app.post("/api/sessions/{session_id}/transcribe")
async def transcribe_session(session_id: str, request: Request, background_tasks: BackgroundTasks, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.audio_file_path or not os.path.exists(session.audio_file_path):
        return JSONResponse({"error": "Audio not available"}, status_code=404)
    if session.status == "transcribing":
        return JSONResponse({"error": "Transcription already in progress"}, status_code=409)

    # Optionally override the template for this transcription
    try:
        body = await request.json()
        template_id = body.get("templateId")
        if template_id:
            await store.update_template(session_id, template_id)
    except Exception:
        pass  # No body or invalid JSON — use existing session template

    await store.update_status(session_id, "transcribing")
    background_tasks.add_task(run_whisper_transcription, session_id)
    return {"status": "transcribing"}


@app.post("/api/sessions/{session_id}/refine-summary")
async def refine_session_summary(session_id: str, body: dict, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.summary:
        return JSONResponse({"error": "No summary to refine"}, status_code=400)

    template_id = body.get("templateId")
    corrections = body.get("corrections", "").strip()

    if not template_id and not corrections:
        return JSONResponse({"error": "templateId or corrections required"}, status_code=400)

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        return JSONResponse({"error": "OPENAI_API_KEY not configured"}, status_code=500)

    # Load template prompt if provided
    template_context = ""
    if template_id:
        pool = get_pool()
        if not pool:
            return JSONResponse({"error": "Database not available"}, status_code=503)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT t.prompt_text FROM templates t
                       WHERE t.id = %s AND (t.user_id = %s OR t.user_id IS NULL)""",
                    (template_id, user.id),
                )
                row = await cur.fetchone()
                if not row:
                    return JSONResponse({"error": "Template not found"}, status_code=404)
        template_context = f"\n\nThe session note should follow this template format:\n{row[0]}"

    try:
        system_content = (
            "You are a clinical documentation assistant. You previously generated a "
            "session note. The therapist has provided corrections or "
            "additional instructions. Apply their feedback to produce an updated session "
            "note. Preserve the same structure and style, only modifying what the "
            "therapist has asked to change." + template_context
        )

        user_content = f"Here is the current session note:\n\n{session.summary}"
        if corrections:
            user_content += f"\n\nPlease apply the following corrections:\n\n{corrections}"
        if template_id and not corrections:
            user_content += "\n\nPlease regenerate this note using the template format specified above."

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
                        {"role": "system", "content": system_content},
                        {"role": "user", "content": user_content},
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
        new_summary = result["choices"][0]["message"]["content"]
        await store.set_summary(session_id, new_summary)
        return {"summary": new_summary}

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


async def run_whisper_transcription(session_id: str):
    """Send audio to OpenAI Whisper API, generate summary, and persist results.

    Reads the template_id from the session's DB row to determine which prompt to use.
    Called both automatically (when recording stops) and manually (via /transcribe endpoint).
    """
    session = await store.get(session_id)
    if not session:
        return

    openai_api_key = os.environ.get("OPENAI_API_KEY")
    if not openai_api_key:
        await store.update_status(session_id, "error", "OPENAI_API_KEY not configured")
        return

    if not session.audio_file_path or not os.path.exists(session.audio_file_path):
        await store.update_status(session_id, "error", "Audio file not found")
        return

    try:
        await store.update_status(session_id, "transcribing")
        print(f"[transcribe] Starting transcription for session {session_id}")

        # Resolve template prompt
        system_prompt = None
        if session.template_id:
            pool = get_pool()
            if pool:
                async with pool.acquire() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            "SELECT prompt_text FROM templates WHERE id = %s",
                            (session.template_id,),
                        )
                        row = await cur.fetchone()
                        if row:
                            system_prompt = row[0]
        if not system_prompt:
            system_prompt = DEFAULT_SYSTEM_PROMPT

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
            await store.update_status(session_id, "error", f"Whisper API error: {error_msg}")
            return

        result = response.json()
        segments = result.get("segments", [])

        # Convert to our TranscriptSegment format and persist
        transcript = [
            TranscriptSegment(
                text=seg.get("text", "").strip(),
                start_time=seg.get("start"),
                end_time=seg.get("end"),
            )
            for seg in segments
            if seg.get("text", "").strip()
        ]
        await store.set_transcript(session_id, transcript)

        print(f"[transcribe] Got {len(transcript)} segments, generating summary...")

        # Generate summary
        full_text = " ".join(seg.text for seg in transcript)
        if full_text.strip():
            summary = await generate_session_summary(full_text, openai_api_key, system_prompt)
        else:
            summary = "No speech detected in the recording."

        if summary:
            await store.set_summary(session_id, summary)

        await store.update_status(session_id, "stopped")
        print(f"[transcribe] Done — {len(transcript)} segments + summary for session {session_id}")

    except Exception as e:
        print(f"[transcribe] Error: {e}")
        await store.update_status(session_id, "error", f"Transcription failed: {str(e)}")


DEFAULT_SYSTEM_PROMPT = (
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
)


async def generate_session_summary(transcript_text: str, api_key: str, system_prompt: str | None = None) -> Optional[str]:
    """Generate a session note from a therapy session transcript using the given prompt."""
    if not system_prompt:
        return None
    prompt = system_prompt
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
                        {"role": "system", "content": prompt},
                        {
                            "role": "user",
                            "content": f"Please generate a session note from the following therapy session transcript:\n\n{transcript_text[:15000]}",
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
async def get_session_audio(session_id: str, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)
    if not session.audio_file_path or not os.path.exists(session.audio_file_path):
        return JSONResponse({"error": "Audio not available"}, status_code=404)
    return FileResponse(session.audio_file_path, media_type="audio/wav")


@app.post("/api/sessions/{session_id}/screenshots")
async def upload_screenshot(session_id: str, body: dict):
    session = await store.get(session_id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    name = body.get("name", "unknown")
    data = body.get("data", "")

    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    image_bytes = base64.b64decode(data)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO screenshots (session_id, name, image_data, content_type) VALUES (%s, %s, %s, %s)",
                (session_id, name, image_bytes, "image/png"),
            )

    return {"status": "ok", "name": name}


@app.get("/api/sessions/{session_id}/screenshots")
async def list_screenshots(
    session_id: str,
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    offset = (page - 1) * limit
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM screenshots WHERE session_id = %s",
                (session_id,),
            )
            (total,) = await cur.fetchone()

            await cur.execute(
                "SELECT id, name, content_type, created_at FROM screenshots WHERE session_id = %s ORDER BY created_at ASC LIMIT %s OFFSET %s",
                (session_id, limit, offset),
            )
            rows = await cur.fetchall()

    screenshots = [
        {
            "id": row[0],
            "name": row[1],
            "url": f"/api/sessions/{session_id}/screenshots/{row[0]}",
            "contentType": row[2],
            "createdAt": row[3].isoformat() if row[3] else None,
        }
        for row in rows
    ]

    return {
        "screenshots": screenshots,
        "total": total,
        "page": page,
        "limit": limit,
        "totalPages": math.ceil(total / limit) if total > 0 else 0,
    }


@app.get("/api/sessions/{session_id}/screenshots/{screenshot_id}")
async def get_screenshot(session_id: str, screenshot_id: int, user: User = Depends(get_current_user)):
    session = await store.get_owned(session_id, user.id)
    if not session:
        return JSONResponse({"error": "Session not found"}, status_code=404)

    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT image_data, content_type FROM screenshots WHERE id = %s AND session_id = %s",
                (screenshot_id, session_id),
            )
            row = await cur.fetchone()

    if not row:
        return JSONResponse({"error": "Screenshot not found"}, status_code=404)

    return Response(
        content=row[0],
        media_type=row[1],
        headers={"Cache-Control": "public, max-age=86400"},
    )


# --- Template Endpoints ---


@app.post("/api/templates")
async def create_template(body: dict, user: User = Depends(get_current_user)):
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    name = body.get("name", "").strip()
    prompt_text = body.get("promptText", "").strip()

    if not name or not prompt_text:
        return JSONResponse({"error": "name and promptText are required"}, status_code=400)

    template_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO templates (id, user_id, name, prompt_text, is_public) VALUES (%s, %s, %s, %s, FALSE)",
                (template_id, user.id, name, prompt_text),
            )

    return {"id": template_id, "name": name, "promptText": prompt_text, "isOwner": True}


@app.get("/api/templates")
async def list_templates(user: User = Depends(get_current_user)):
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT t.id, t.user_id, t.name, t.prompt_text, t.created_at, t.updated_at
                   FROM templates t
                   WHERE t.user_id = %s OR t.user_id IS NULL
                   ORDER BY t.user_id IS NOT NULL, t.created_at DESC""",
                (user.id,),
            )
            rows = await cur.fetchall()

    return [
        {
            "id": r[0],
            "userId": r[1],
            "name": r[2],
            "promptText": r[3],
            "createdAt": r[4].isoformat() if r[4] else None,
            "updatedAt": r[5].isoformat() if r[5] else None,
            "isOwner": r[1] == user.id,
            "isSystem": r[1] is None,
        }
        for r in rows
    ]




@app.get("/api/templates/system")
async def list_system_templates(search: str = Query(default="")):
    """List built-in system templates (no auth required to browse)."""
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            if search.strip():
                await cur.execute(
                    """SELECT id, name, prompt_text, created_at FROM templates
                       WHERE user_id IS NULL AND name LIKE %s
                       ORDER BY name""",
                    (f"%{search.strip()}%",),
                )
            else:
                await cur.execute(
                    "SELECT id, name, prompt_text, created_at FROM templates WHERE user_id IS NULL ORDER BY name"
                )
            rows = await cur.fetchall()

    return [
        {"id": r[0], "name": r[1], "promptText": r[2], "createdAt": r[3].isoformat() if r[3] else None, "isSystem": True}
        for r in rows
    ]


@app.get("/api/templates/{template_id}")
async def get_template(template_id: str, user: User = Depends(get_current_user)):
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT t.id, t.user_id, t.name, t.prompt_text, t.is_public, t.created_at, t.updated_at
                   FROM templates t
                   WHERE t.id = %s AND (t.user_id = %s OR t.user_id IS NULL)""",
                (template_id, user.id),
            )
            r = await cur.fetchone()

    if not r:
        return JSONResponse({"error": "Template not found"}, status_code=404)

    return {
        "id": r[0], "userId": r[1], "name": r[2], "promptText": r[3],
        "isPublic": bool(r[4]), "createdAt": r[5].isoformat() if r[5] else None,
        "updatedAt": r[6].isoformat() if r[6] else None, "isOwner": r[1] == user.id,
    }


@app.put("/api/templates/{template_id}")
async def update_template(template_id: str, body: dict, user: User = Depends(get_current_user)):
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT user_id FROM templates WHERE id = %s", (template_id,))
            row = await cur.fetchone()
            if not row or row[0] != user.id:
                return JSONResponse({"error": "Template not found"}, status_code=404)

            updates = []
            params = []
            if "name" in body:
                updates.append("name = %s")
                params.append(body["name"].strip())
            if "promptText" in body:
                updates.append("prompt_text = %s")
                params.append(body["promptText"].strip())

            if not updates:
                return JSONResponse({"error": "No fields to update"}, status_code=400)

            params.append(template_id)
            await cur.execute(f"UPDATE templates SET {', '.join(updates)} WHERE id = %s", params)

    return {"status": "ok"}


@app.delete("/api/templates/{template_id}")
async def delete_template(template_id: str, user: User = Depends(get_current_user)):
    pool = get_pool()
    if not pool:
        return JSONResponse({"error": "Database not available"}, status_code=503)

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT user_id FROM templates WHERE id = %s", (template_id,))
            row = await cur.fetchone()
            if not row or row[0] != user.id:
                return JSONResponse({"error": "Template not found"}, status_code=404)
            await cur.execute("DELETE FROM templates WHERE id = %s", (template_id,))

    return {"status": "ok"}




# --- WebSocket Endpoints ---


@app.websocket("/ws/audio/{session_id}")
async def audio_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_audio_ws(websocket, session_id)


@app.websocket("/ws/transcript/{session_id}")
async def transcript_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_transcript_ws(websocket, session_id)
