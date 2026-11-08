"""Official Python client for the LastShoot API (https://www.lastshoot.com)."""

from ._client import DEFAULT_BASE_URL, AsyncLastShoot, FileInput, LastShoot
from ._endpoints import (
    AdapterConfigSnapshot,
    JobQueuedData,
    JobStatusData,
    Profile,
    ProfileList,
    UploadData,
    WebhookEvent,
)
from ._exceptions import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AuthenticationError,
    InsufficientCreditsError,
    InternalServerError,
    InvalidRequestError,
    JobFailedError,
    JobTimeoutError,
    LastShootError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
)
from ._models import AsyncJob, Job, JobStatus, ProgressCallback, Result, UploadResult
from ._version import __version__

__all__ = [
    "__version__",
    "DEFAULT_BASE_URL",
    "LastShoot",
    "AsyncLastShoot",
    "FileInput",
    "Job",
    "AsyncJob",
    "JobStatus",
    "Result",
    "UploadResult",
    "ProgressCallback",
    "AdapterConfigSnapshot",
    "JobQueuedData",
    "JobStatusData",
    "Profile",
    "ProfileList",
    "UploadData",
    "WebhookEvent",
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
