"""
Production security helpers for CueAI Python API.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict, deque
from typing import Callable, Deque, Dict, Optional, Tuple

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

log = logging.getLogger("cueai.security")


def extract_api_key(
    *,
    header_key: Optional[str] = None,
    authorization: Optional[str] = None,
    query_key: Optional[str] = None,
) -> Optional[str]:
    if header_key and header_key.strip():
        return header_key.strip()
    if authorization:
        parts = authorization.strip().split(" ", 1)
        if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
            return parts[1].strip()
        if authorization.strip():
            return authorization.strip()
    if query_key and query_key.strip():
        return query_key.strip()
    return None


class RateLimiter:
    """Simple sliding-window rate limiter (per key)."""

    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max(1, max_requests)
        self.window_seconds = max(1, window_seconds)
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> Tuple[bool, int]:
        now = time.monotonic()
        window_start = now - self.window_seconds
        q = self._hits[key]
        while q and q[0] < window_start:
            q.popleft()
        if len(q) >= self.max_requests:
            retry = int(max(1, self.window_seconds - (now - q[0])))
            return False, retry
        q.append(now)
        return True, 0


class ApiKeyAndRateLimitMiddleware(BaseHTTPMiddleware):
    """
    - Enforce API key on protected paths
    - Rate-limit by client IP (+ optional API key)
    - Never logs request bodies
    """

    PUBLIC_PATHS = {"/health", "/docs", "/openapi.json", "/redoc"}

    def __init__(
        self,
        app: ASGIApp,
        *,
        api_secret: str,
        require_api_key: bool,
        rate_limiter: RateLimiter,
        trusted_proxy: bool = True,
    ) -> None:
        super().__init__(app)
        self.api_secret = api_secret
        self.require_api_key = require_api_key
        self.rate_limiter = rate_limiter
        self.trusted_proxy = trusted_proxy

    def _client_ip(self, request: Request) -> str:
        if self.trusted_proxy:
            forwarded = request.headers.get("x-forwarded-for")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next: Callable):
        path = request.url.path
        method = request.method
        ip = self._client_ip(request)

        # CORS preflight must pass without API key
        if method == "OPTIONS":
            return await call_next(request)

        ok, retry = self.rate_limiter.allow(f"ip:{ip}")
        if not ok:
            log.warning("rate_limited ip=%s path=%s", ip, path)
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded"},
                headers={"Retry-After": str(retry)},
            )

        # API key for protected routes
        if path not in self.PUBLIC_PATHS and not path.startswith("/docs"):
            if self.require_api_key or self.api_secret:
                key = extract_api_key(
                    header_key=request.headers.get("x-api-key"),
                    authorization=request.headers.get("authorization"),
                    query_key=request.query_params.get("api_key"),
                )
                if not self.api_secret:
                    log.error("API_SECRET_KEY missing while require_api_key is enabled")
                    return JSONResponse(status_code=503, content={"detail": "API auth not configured"})
                if key != self.api_secret:
                    log.warning("unauthorized ip=%s path=%s", ip, path)
                    return JSONResponse(status_code=401, content={"detail": "Invalid API key"})

        response = await call_next(request)
        # Safe access-style log: no query, no body, no headers
        log.info("%s %s -> %s", method, path, response.status_code)
        return response


async def authorize_websocket(ws: WebSocket, api_secret: str, require_api_key: bool) -> bool:
    if not require_api_key and not api_secret:
        return True
    if not api_secret:
        await ws.close(code=4403)
        return False
    key = extract_api_key(
        header_key=ws.headers.get("x-api-key"),
        authorization=ws.headers.get("authorization"),
        query_key=ws.query_params.get("api_key"),
    )
    if key != api_secret:
        await ws.close(code=4401)
        return False
    return True


class RedactUvicornAccessFilter(logging.Filter):
    """Strip query strings from uvicorn access logs (may contain api_key)."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "?" in msg and "api_key=" in msg.lower():
            record.msg = msg.split("?", 1)[0] + "?[redacted]"
            record.args = ()
        return True
