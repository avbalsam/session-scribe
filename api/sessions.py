from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional
import uuid

from api.database import get_pool

MAX_SESSION_DURATION = 3 * 60 * 60  # 3 hours in seconds


@dataclass
class TranscriptSegment:
    text: str
    speaker: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    confidence: Optional[float] = None


@dataclass
class Session:
    id: str
    meeting_id: str
    passcode: Optional[str]
    bot_name: str
    status: str  # "starting" | "recording" | "stopped" | "transcribing" | "error"
    created_at: datetime
    owner_id: Optional[str] = None
    template_id: Optional[str] = None
    ended_at: Optional[datetime] = None
    max_end_time: Optional[datetime] = None
    audio_file_path: Optional[str] = None
    transcript: list[TranscriptSegment] = field(default_factory=list)
    summary: Optional[str] = None
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "meetingId": self.meeting_id,
            "botName": self.bot_name,
            "status": self.status,
            "createdAt": self.created_at.isoformat(),
            "endedAt": self.ended_at.isoformat() if self.ended_at else None,
            "audioFilePath": self.audio_file_path,
            "transcript": [
                {
                    "text": seg.text,
                    "speaker": seg.speaker,
                    "startTime": seg.start_time,
                    "endTime": seg.end_time,
                    "confidence": seg.confidence,
                }
                for seg in self.transcript
            ],
            "summary": self.summary,
            "errorMessage": self.error_message,
        }


def _row_to_session(row: tuple) -> Session:
    """Convert a DB row to a Session object (without transcript — load separately)."""
    return Session(
        id=row[0],
        owner_id=row[1],
        meeting_id=row[2],
        passcode=row[3],
        bot_name=row[4],
        template_id=row[5],
        status=row[6],
        error_message=row[7],
        audio_file_path=row[8],
        summary=row[9],
        created_at=row[10],
        max_end_time=row[11],
        ended_at=row[12],
    )


SESSION_COLUMNS = (
    "id, owner_id, meeting_id, passcode, bot_name, template_id, "
    "status, error_message, audio_file_path, summary, created_at, max_end_time, ended_at"
)


class SessionStore:
    """MySQL-backed session store. Falls back to in-memory if no DB is available."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def _use_db(self) -> bool:
        return get_pool() is not None

    async def create(
        self,
        meeting_id: str,
        passcode: Optional[str] = None,
        bot_name: str = "Session Scribe Bot",
        owner_id: Optional[str] = None,
        template_id: Optional[str] = None,
    ) -> Session:
        session_id = str(uuid.uuid4())
        now = datetime.now()
        max_end = now + timedelta(seconds=MAX_SESSION_DURATION)

        session = Session(
            id=session_id,
            meeting_id=meeting_id,
            passcode=passcode,
            bot_name=bot_name,
            status="starting",
            created_at=now,
            owner_id=owner_id,
            template_id=template_id,
            max_end_time=max_end,
        )

        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "INSERT INTO recording_sessions (id, owner_id, meeting_id, passcode, bot_name, template_id, status, max_end_time) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                        (session_id, owner_id, meeting_id, passcode, bot_name, template_id, "starting", max_end),
                    )
        else:
            self._sessions[session_id] = session

        return session

    async def get(self, session_id: str) -> Optional[Session]:
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        f"SELECT {SESSION_COLUMNS} FROM recording_sessions WHERE id = %s",
                        (session_id,),
                    )
                    row = await cur.fetchone()
                    if not row:
                        return None
                    session = _row_to_session(row)
                    # Load transcript
                    await cur.execute(
                        "SELECT text, speaker, start_time, end_time, confidence "
                        "FROM transcript_segments WHERE session_id = %s ORDER BY segment_order",
                        (session_id,),
                    )
                    for seg_row in await cur.fetchall():
                        session.transcript.append(TranscriptSegment(
                            text=seg_row[0], speaker=seg_row[1],
                            start_time=seg_row[2], end_time=seg_row[3], confidence=seg_row[4],
                        ))
                    return session
        return self._sessions.get(session_id)

    async def get_owned(self, session_id: str, owner_id: str) -> Optional[Session]:
        session = await self.get(session_id)
        if session and session.owner_id == owner_id:
            return session
        return None

    async def list_by_owner(self, owner_id: str) -> list[Session]:
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        f"SELECT {SESSION_COLUMNS} FROM recording_sessions WHERE owner_id = %s ORDER BY created_at DESC",
                        (owner_id,),
                    )
                    rows = await cur.fetchall()
                    return [_row_to_session(row) for row in rows]
        return sorted(
            [s for s in self._sessions.values() if s.owner_id == owner_id],
            key=lambda s: s.created_at, reverse=True,
        )

    async def update_status(
        self, session_id: str, status: str, error: Optional[str] = None
    ):
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    if status == "stopped":
                        await cur.execute(
                            "UPDATE recording_sessions SET status = %s, error_message = %s, ended_at = NOW() WHERE id = %s",
                            (status, error, session_id),
                        )
                    else:
                        await cur.execute(
                            "UPDATE recording_sessions SET status = %s, error_message = %s WHERE id = %s",
                            (status, error, session_id),
                        )
        else:
            session = self._sessions.get(session_id)
            if session:
                session.status = status
                if error:
                    session.error_message = error
                if status == "stopped":
                    session.ended_at = datetime.now()

    async def set_audio_path(self, session_id: str, path: str):
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE recording_sessions SET audio_file_path = %s WHERE id = %s",
                        (path, session_id),
                    )
        else:
            session = self._sessions.get(session_id)
            if session:
                session.audio_file_path = path

    async def set_summary(self, session_id: str, summary: str):
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE recording_sessions SET summary = %s WHERE id = %s",
                        (summary, session_id),
                    )
        else:
            session = self._sessions.get(session_id)
            if session:
                session.summary = summary

    async def set_transcript(self, session_id: str, segments: list[TranscriptSegment]):
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    # Clear existing segments
                    await cur.execute("DELETE FROM transcript_segments WHERE session_id = %s", (session_id,))
                    # Insert new segments
                    for i, seg in enumerate(segments):
                        await cur.execute(
                            "INSERT INTO transcript_segments (session_id, text, speaker, start_time, end_time, confidence, segment_order) "
                            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                            (session_id, seg.text, seg.speaker, seg.start_time, seg.end_time, seg.confidence, i),
                        )
        else:
            session = self._sessions.get(session_id)
            if session:
                session.transcript = segments

    async def update_template(self, session_id: str, template_id: str):
        if self._use_db():
            pool = get_pool()
            async with pool.acquire() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "UPDATE recording_sessions SET template_id = %s WHERE id = %s",
                        (template_id, session_id),
                    )


# Global store instance
store = SessionStore()
