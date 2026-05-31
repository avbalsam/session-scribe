import os

import httpx
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sessions import store
from audio_handler import AudioHandler

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


# --- WebSocket Endpoints ---


@app.websocket("/ws/audio/{session_id}")
async def audio_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_audio_ws(websocket, session_id)


@app.websocket("/ws/transcript/{session_id}")
async def transcript_websocket(websocket: WebSocket, session_id: str):
    await audio_handler.handle_transcript_ws(websocket, session_id)
