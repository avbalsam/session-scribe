import asyncio
import json
import math
import os
import struct
import wave
from datetime import datetime
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from api.sessions import SessionStore, TranscriptSegment
from api.transcriber import Transcriber, NoOpTranscriber
from api.auth import get_user_from_cookie

AUDIO_DIR = os.environ.get("AUDIO_SAVE_DIR", "./audio")
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # Int16 = 2 bytes per sample


class AudioHandler:
    """Handles incoming audio WebSocket connections from the bot service."""

    def __init__(self, store: SessionStore, transcriber: Optional[Transcriber] = None):
        self.store = store
        self.transcriber = transcriber or NoOpTranscriber()
        # Map of session_id -> set of frontend WebSocket clients
        self.transcript_clients: dict[str, set[WebSocket]] = {}

    async def handle_audio_ws(self, websocket: WebSocket, session_id: str):
        """Receive audio chunks from the bot and process them."""
        await websocket.accept()

        session = self.store.get(session_id)
        if not session:
            await websocket.close(code=4004, reason="Session not found")
            return

        # Update session status
        self.store.update_status(session_id, "recording")

        # Prepare audio file
        os.makedirs(AUDIO_DIR, exist_ok=True)
        audio_path = os.path.join(
            AUDIO_DIR, f"{session_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.wav"
        )
        session.audio_file_path = audio_path

        # Open WAV file for writing
        wav_file = wave.open(audio_path, "wb")
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH)
        wav_file.setframerate(SAMPLE_RATE)

        chunk_count = 0
        total_bytes = 0

        try:
            await self.transcriber.start()

            while True:
                data = await websocket.receive()

                # Handle text messages (control signals)
                if "text" in data:
                    import json

                    msg = json.loads(data["text"])
                    if msg.get("type") == "end":
                        print(f"[audio] Session {session_id} ended by bot")
                        break
                    continue

                # Handle binary audio data
                if "bytes" in data:
                    audio_bytes = data["bytes"]
                    chunk_count += 1
                    total_bytes += len(audio_bytes)

                    # Write to WAV file
                    wav_file.writeframes(audio_bytes)

                    # Compute audio level (RMS) and broadcast to frontend
                    level = self._compute_rms(audio_bytes)
                    duration_s = total_bytes / (SAMPLE_RATE * SAMPLE_WIDTH)
                    await self._broadcast_level(session_id, level, duration_s)

                    # Pass to transcriber
                    segment = await self.transcriber.transcribe_chunk(audio_bytes)
                    if segment:
                        session.transcript.append(segment)
                        await self._broadcast_segment(session_id, segment)

                    # Log progress periodically
                    if chunk_count % 100 == 0:
                        mb = total_bytes / 1024 / 1024
                        print(
                            f"[audio] Session {session_id}: {chunk_count} chunks, "
                            f"{mb:.2f} MB, ~{duration_s:.1f}s of audio"
                        )

        except WebSocketDisconnect:
            print(f"[audio] Bot disconnected for session {session_id}")
        except Exception as e:
            print(f"[audio] Error in session {session_id}: {e}")
            self.store.update_status(session_id, "error", str(e))
        finally:
            wav_file.close()
            await self.transcriber.stop()
            self.store.update_status(session_id, "stopped")
            duration = total_bytes / (SAMPLE_RATE * SAMPLE_WIDTH)
            print(
                f"[audio] Session {session_id} complete: "
                f"{chunk_count} chunks, {total_bytes / 1024 / 1024:.2f} MB, "
                f"~{duration:.1f}s of audio saved to {audio_path}"
            )

    async def handle_transcript_ws(self, websocket: WebSocket, session_id: str):
        """Frontend clients connect here to receive live transcript updates."""
        await websocket.accept()

        # Authenticate after accepting (cookies available from headers)
        user = get_user_from_cookie(websocket.cookies)
        if not user:
            await websocket.close(code=4001, reason="Not authenticated")
            return

        session = self.store.get(session_id)
        if not session:
            await websocket.close(code=4004, reason="Session not found")
            return

        if session.owner_id != user.id:
            await websocket.close(code=4003, reason="Forbidden")
            return

        # Register this client
        if session_id not in self.transcript_clients:
            self.transcript_clients[session_id] = set()
        self.transcript_clients[session_id].add(websocket)

        # Send existing transcript segments
        for seg in session.transcript:
            await websocket.send_json(
                {
                    "text": seg.text,
                    "speaker": seg.speaker,
                    "startTime": seg.start_time,
                    "endTime": seg.end_time,
                }
            )

        try:
            # Keep connection alive, wait for client disconnect
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            self.transcript_clients.get(session_id, set()).discard(websocket)

    def _compute_rms(self, audio_bytes: bytes) -> float:
        """Compute RMS level from Int16 PCM audio, normalized to 0.0-1.0."""
        if len(audio_bytes) < 2:
            return 0.0
        num_samples = len(audio_bytes) // 2
        samples = struct.unpack(f"<{num_samples}h", audio_bytes[:num_samples * 2])
        sum_sq = sum(s * s for s in samples)
        rms = math.sqrt(sum_sq / num_samples) / 32768.0
        return min(rms, 1.0)

    async def _broadcast_level(
        self, session_id: str, level: float, duration: float
    ):
        """Send audio level to all connected frontend clients."""
        await self._broadcast(session_id, {
            "type": "level",
            "level": round(level, 4),
            "duration": round(duration, 1),
        })

    async def _broadcast_segment(
        self, session_id: str, segment: TranscriptSegment
    ):
        """Send a transcript segment to all connected frontend clients."""
        await self._broadcast(session_id, {
            "type": "transcript",
            "text": segment.text,
            "speaker": segment.speaker,
            "startTime": segment.start_time,
            "endTime": segment.end_time,
        })

    async def _broadcast(self, session_id: str, message: dict):
        """Send a JSON message to all connected frontend clients."""
        clients = self.transcript_clients.get(session_id, set())
        disconnected = set()

        for ws in clients:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.add(ws)

        for ws in disconnected:
            clients.discard(ws)
