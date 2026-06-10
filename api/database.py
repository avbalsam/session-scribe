import os
import logging
from urllib.parse import urlparse

import aiomysql

logger = logging.getLogger(__name__)

_pool: aiomysql.Pool | None = None

TEMPLATES_TABLE = """
CREATE TABLE IF NOT EXISTS templates (
  id CHAR(36) PRIMARY KEY,
  user_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  prompt_text TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_is_public (is_public)
)
"""


SCREENSHOTS_TABLE = """
CREATE TABLE IF NOT EXISTS screenshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  image_data LONGBLOB NOT NULL,
  content_type VARCHAR(50) NOT NULL DEFAULT 'image/png',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_id (session_id),
  INDEX idx_session_created (session_id, created_at)
)
"""


RECORDING_SESSIONS_TABLE = """
CREATE TABLE IF NOT EXISTS recording_sessions (
  id CHAR(36) PRIMARY KEY,
  owner_id VARCHAR(255) NOT NULL,
  meeting_id VARCHAR(255) NOT NULL,
  passcode VARCHAR(255),
  bot_name VARCHAR(255) NOT NULL DEFAULT 'Session Scribe Bot',
  template_id CHAR(36),
  status VARCHAR(50) NOT NULL DEFAULT 'starting',
  error_message TEXT,
  audio_file_path VARCHAR(512),
  summary TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  max_end_time DATETIME NOT NULL,
  ended_at DATETIME,
  INDEX idx_owner_id (owner_id),
  INDEX idx_status (status)
)
"""

TRANSCRIPT_SEGMENTS_TABLE = """
CREATE TABLE IF NOT EXISTS transcript_segments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  text TEXT NOT NULL,
  speaker VARCHAR(255),
  start_time FLOAT,
  end_time FLOAT,
  confidence FLOAT,
  segment_order INT NOT NULL,
  INDEX idx_session_id (session_id),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE
)
"""

SYSTEM_TEMPLATE_ID_DIR_FLOORTIME = "00000000-0000-0000-0000-000000000001"


async def init_db():
    global _pool
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        logger.warning("DATABASE_URL not set -- database features disabled")
        return

    parsed = urlparse(database_url)
    _pool = await aiomysql.create_pool(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=parsed.username,
        password=parsed.password,
        db=parsed.path.lstrip("/"),
        minsize=1,
        maxsize=5,
        autocommit=True,
    )

    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(TEMPLATES_TABLE)
            await cur.execute(RECORDING_SESSIONS_TABLE)
            await cur.execute(TRANSCRIPT_SEGMENTS_TABLE)
            await cur.execute(SCREENSHOTS_TABLE)
            # Ensure user_id is nullable (needed for system templates)
            await cur.execute("ALTER TABLE templates MODIFY COLUMN user_id VARCHAR(255) NULL")

    await _seed_system_templates()
    logger.info("Database initialized -- tables ready")


async def _seed_system_templates():
    """Insert built-in system templates if they don't already exist."""
    from api.main import DEFAULT_SYSTEM_PROMPT

    async with _pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id FROM templates WHERE id = %s", (SYSTEM_TEMPLATE_ID_DIR_FLOORTIME,))
            if not await cur.fetchone():
                await cur.execute(
                    "INSERT INTO templates (id, user_id, name, prompt_text, is_public) VALUES (%s, NULL, %s, %s, TRUE)",
                    (SYSTEM_TEMPLATE_ID_DIR_FLOORTIME, "DIR/Floortime Session Note", DEFAULT_SYSTEM_PROMPT),
                )
                logger.info("Seeded system template: DIR/Floortime Session Note")


async def close_db():
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None


def get_pool() -> aiomysql.Pool | None:
    return _pool
