from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from ._models import JobStatus

__all__ = [
    "LastShootError",
    "APIError",
    "InvalidRequestError",
    "AuthenticationError",
    "InsufficientCreditsError",
    "PermissionDeniedError",
    "NotFoundError",
    "RateLimitError",
    "InternalServerError",
    "APIConnectionError",
    "APITimeoutError",
    "JobFailedError",
    "JobTimeoutError",
]


class LastShootError(Exception):
    """Base class for every error raised by the LastShoot SDK."""


class APIError(LastShootError):
    """The API answered with a non-2xx status."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        body: Any = None,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.body = body
        self.code = code
        self.request_id = request_id

    def __str__(self) -> str:
        code = f" [{self.code}]" if self.code else ""
        return f"{self.status_code}{code}: {self.message}"


class InvalidRequestError(APIError):
    """400 or 422: the request body failed validation."""


class AuthenticationError(APIError):
    """401: missing or invalid API key."""


class InsufficientCreditsError(APIError):
    """402: not enough balance to run this job. Top up at lastshoot.com/dashboard."""


class PermissionDeniedError(APIError):
    """403: the key is valid but not allowed to do this."""


class NotFoundError(APIError):
    """404: the job, profile or path does not exist."""


class RateLimitError(APIError):
    """429: too many requests or too many concurrent jobs."""

    def __init__(self, message: str, *, retry_after: Optional[float] = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retry_after = retry_after


class InternalServerError(APIError):
    """5xx from the API."""


class APIConnectionError(LastShootError):
    """The request never got an HTTP response (DNS, TLS, connection reset...)."""


class APITimeoutError(APIConnectionError):
    """The HTTP request timed out."""


class JobFailedError(LastShootError):
    """The job finished with status `failed` or `cancelled`."""

    def __init__(self, status: "JobStatus") -> None:
        self.status = status
        self.job_id = status.job_id
        self.error = status.error
        self.failure_reason_code = status.failure_reason_code
        self.retryable = status.retryable
        reason = f" [{status.failure_reason_code}]" if status.failure_reason_code else ""
        detail = status.error or status.status
        super().__init__(f"Job {status.job_id} {status.status}{reason}: {detail}")


class JobTimeoutError(LastShootError):
    """`wait()` gave up before the job reached a final status. The job keeps running server-side."""

    def __init__(self, job_id: str, timeout: float, last_status: Optional["JobStatus"] = None) -> None:
        self.job_id = job_id
        self.timeout = timeout
        self.last_status = last_status
        super().__init__(f"Job {job_id} did not finish within {timeout:g}s")


_STATUS_MAP = {
    400: InvalidRequestError,
    401: AuthenticationError,
    402: InsufficientCreditsError,
    403: PermissionDeniedError,
    404: NotFoundError,
    422: InvalidRequestError,
    429: RateLimitError,
}


def _parse_error_body(body: Any, fallback: str) -> "tuple[str, Optional[str]]":
    """Pull a readable message and an error code out of FastAPI-style error bodies."""
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, str) and detail:
        return detail, None
    if isinstance(detail, list):  # FastAPI validation errors
        parts = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(x) for x in item.get("loc", []) if x != "body")
                parts.append(f"{loc}: {item.get('msg')}" if loc else str(item.get("msg")))
            else:
                parts.append(str(item))
        return "; ".join(parts) or fallback, None
    if isinstance(detail, dict):
        code = detail.get("code") or detail.get("error_code") or detail.get("failure_reason_code")
        msg = detail.get("message") or detail.get("detail") or detail.get("error") or fallback
        return str(msg), (str(code) if code else None)
    return fallback, None


def make_api_error(status_code: int, body: Any, headers: Any = None) -> APIError:
    fallback = f"HTTP {status_code}"
    message, code = _parse_error_body(body, fallback)
    request_id = None
    retry_after: Optional[float] = None
    if headers is not None:
        request_id = headers.get("x-request-id")
        raw = headers.get("retry-after")
        if raw:
            try:
                retry_after = float(raw)
            except ValueError:
                retry_after = None
    cls = _STATUS_MAP.get(status_code)
    if cls is None:
        cls = InternalServerError if status_code >= 500 else APIError
    kwargs: Any = dict(status_code=status_code, body=body, code=code, request_id=request_id)
    if cls is RateLimitError:
        return RateLimitError(message, retry_after=retry_after, **kwargs)
    return cls(message, **kwargs)
