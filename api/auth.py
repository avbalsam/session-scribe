import os
import secrets
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import Request, HTTPException, Response
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

GOOGLE_CLIENT_ID = os.environ.get("VITE_GOOGLE_CLIENT_ID", "")
SESSION_COOKIE_NAME = "session_token"
SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days


@dataclass
class User:
    google_id: str
    email: str
    name: str
    picture: Optional[str] = None


# In-memory stores
_users: dict[str, User] = {}  # google_id -> User
_auth_sessions: dict[str, dict] = {}  # token -> {google_id, expires_at}


def create_auth_session(user: User, response: Response) -> str:
    """Create a session and set the cookie on the response."""
    token = secrets.token_urlsafe(32)
    _auth_sessions[token] = {
        "google_id": user.google_id,
        "expires_at": time.time() + SESSION_MAX_AGE,
    }
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="none",
        max_age=SESSION_MAX_AGE,
        path="/",
    )
    return token


def get_current_user(request: Request) -> User:
    """FastAPI dependency — extracts and validates the session cookie."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    session_data = _auth_sessions.get(token)
    if not session_data or session_data["expires_at"] < time.time():
        if token in _auth_sessions:
            del _auth_sessions[token]
        raise HTTPException(status_code=401, detail="Session expired")

    user = _users.get(session_data["google_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


def get_user_from_cookie(cookies: dict) -> Optional[User]:
    """Validate a session cookie dict and return the User or None.

    Used for WebSocket auth where we can't raise HTTPException.
    """
    token = cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None

    session_data = _auth_sessions.get(token)
    if not session_data or session_data["expires_at"] < time.time():
        if token and token in _auth_sessions:
            del _auth_sessions[token]
        return None

    return _users.get(session_data["google_id"])


def verify_google_token(credential: str) -> User:
    """Verify a Google ID token and return/create the user."""
    idinfo = id_token.verify_oauth2_token(
        credential,
        google_requests.Request(),
        GOOGLE_CLIENT_ID,
    )
    google_id = idinfo["sub"]
    email = idinfo["email"]
    name = idinfo.get("name", email)
    picture = idinfo.get("picture")

    user = User(google_id=google_id, email=email, name=name, picture=picture)
    _users[google_id] = user
    return user


def clear_auth_session(request: Request, response: Response) -> None:
    """Remove the session and clear the cookie."""
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        _auth_sessions.pop(token, None)
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
