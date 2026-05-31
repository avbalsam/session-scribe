from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
import uuid


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
    status: str  # "starting" | "recording" | "stopped" | "error"
    created_at: datetime
    ended_at: Optional[datetime] = None
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


class SessionStore:
    """In-memory session store. Replace with a database for production."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def create(
        self,
        meeting_id: str,
        passcode: Optional[str] = None,
        bot_name: str = "Session Scribe Bot",
    ) -> Session:
        session = Session(
            id=str(uuid.uuid4()),
            meeting_id=meeting_id,
            passcode=passcode,
            bot_name=bot_name,
            status="starting",
            created_at=datetime.now(),
        )
        self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def list_all(self) -> list[Session]:
        return sorted(
            self._sessions.values(), key=lambda s: s.created_at, reverse=True
        )

    def update_status(
        self, session_id: str, status: str, error: Optional[str] = None
    ):
        session = self._sessions.get(session_id)
        if session:
            session.status = status
            if error:
                session.error_message = error
            if status == "stopped":
                session.ended_at = datetime.now()


# Global store instance
store = SessionStore()
