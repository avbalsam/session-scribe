import os
from dataclasses import dataclass
from typing import Optional

import httpx
from fastapi import Request, HTTPException

AUTH_SERVICE_URL = os.environ.get("AUTH_SERVICE_URL", "http://localhost:3002")


@dataclass
class User:
    id: str
    email: str
    name: str
    image: Optional[str] = None


def get_current_user(request: Request) -> User:
    """FastAPI dependency — validates the session via the auth service."""
    # Forward cookies to the auth service for validation
    cookie_header = request.headers.get("cookie", "")
    if not cookie_header:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        resp = httpx.get(
            f"{AUTH_SERVICE_URL}/internal/validate",
            headers={"cookie": cookie_header},
            timeout=5.0,
        )
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Auth service unavailable")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = resp.json()
    user_data = data.get("user")
    if not user_data:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return User(
        id=user_data["id"],
        email=user_data["email"],
        name=user_data["name"],
        image=user_data.get("image"),
    )


def get_user_from_cookie(cookies: dict) -> Optional[User]:
    """Validate session cookies and return User or None.

    Used for WebSocket auth where we can't raise HTTPException.
    """
    # Reconstruct cookie header from dict
    cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if not cookie_header:
        return None

    try:
        resp = httpx.get(
            f"{AUTH_SERVICE_URL}/internal/validate",
            headers={"cookie": cookie_header},
            timeout=5.0,
        )
    except httpx.ConnectError:
        return None

    if resp.status_code != 200:
        return None

    data = resp.json()
    user_data = data.get("user")
    if not user_data:
        return None

    return User(
        id=user_data["id"],
        email=user_data["email"],
        name=user_data["name"],
        image=user_data.get("image"),
    )
