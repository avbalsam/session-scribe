import os
import logging
from urllib.parse import urlparse

import aiomysql

logger = logging.getLogger(__name__)

_pool: aiomysql.Pool | None = None

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


async def init_db():
    global _pool
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        logger.warning("DATABASE_URL not set -- screenshot persistence disabled")
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
            await cur.execute(SCREENSHOTS_TABLE)

    logger.info("Database initialized -- screenshots table ready")


async def close_db():
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None


def get_pool() -> aiomysql.Pool | None:
    return _pool
