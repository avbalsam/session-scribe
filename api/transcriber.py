from abc import ABC, abstractmethod
from typing import Optional
from api.sessions import TranscriptSegment


class Transcriber(ABC):
    """Base class for transcription engines."""

    @abstractmethod
    async def transcribe_chunk(
        self, audio_data: bytes, sample_rate: int = 16000
    ) -> Optional[TranscriptSegment]:
        """
        Transcribe a chunk of PCM audio data.

        Args:
            audio_data: Raw PCM Int16 audio bytes
            sample_rate: Sample rate in Hz (default 16000)

        Returns:
            A TranscriptSegment if speech was detected, None otherwise
        """
        pass

    async def start(self):
        """Initialize any connections (e.g., WebSocket to transcription service)."""
        pass

    async def stop(self):
        """Clean up resources."""
        pass


class NoOpTranscriber(Transcriber):
    """Placeholder transcriber that does nothing. Replace with Deepgram/Whisper later."""

    async def transcribe_chunk(
        self, audio_data: bytes, sample_rate: int = 16000
    ) -> Optional[TranscriptSegment]:
        return None
