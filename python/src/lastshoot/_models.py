from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional, Union

if TYPE_CHECKING:
    from ._client import AsyncLastShoot, LastShoot

__all__ = ["JobStatus", "Result", "Job", "AsyncJob", "UploadResult", "ProgressCallback", "TERMINAL_STATUSES"]

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})


@dataclass
class JobStatus:
    """A snapshot from `GET <endpoint>/status/{job_id}`. Unlisted fields stay in `raw`."""

    job_id: str
    status: str
    endpoint: Optional[str] = None
    progress: Optional[int] = None
    result_url: Optional[str] = None
    result_mime_type: Optional[str] = None
    error: Optional[Any] = None
    failure_reason_code: Optional[str] = None
    retryable: Optional[bool] = None
    warnings: Optional[List[str]] = None
    queue_position: Optional[int] = None
    queued_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    processing_time_seconds: Optional[float] = None
    cost_usd: Optional[float] = None
    balance_remaining_usd: Optional[float] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any], *, job_id: str = "", endpoint: Optional[str] = None) -> "JobStatus":
        known = {f for f in cls.__dataclass_fields__ if f != "raw"}
        kwargs = {k: v for k, v in data.items() if k in known}
        kwargs.setdefault("job_id", job_id)
        if kwargs.get("job_id") is None:
            kwargs["job_id"] = job_id
        if kwargs.get("status") is None:
            kwargs["status"] = "unknown"
        if kwargs.get("endpoint") is None:
            kwargs["endpoint"] = endpoint
        return cls(raw=dict(data), **kwargs)

    @property
    def url(self) -> Optional[str]:
        """Alias for `result_url`. Temporary: expires within 24 hours, download it promptly."""
        return self.result_url

    @property
    def mime_type(self) -> Optional[str]:
        return self.result_mime_type

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES


@dataclass
class Result(JobStatus):
    """A completed job. `result.url` is the output file (expires within 24 hours)."""


ProgressCallback = Callable[[JobStatus], Union[None, Awaitable[None]]]


@dataclass
class UploadResult:
    """Response of `POST /upload/image/v1`. Feed `url` into any other method."""

    url: str
    filename: Optional[str] = None
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UploadResult":
        return cls(
            url=data["url"],
            filename=data.get("filename"),
            content_type=data.get("content_type"),
            size_bytes=data.get("size_bytes"),
            raw=dict(data),
        )


@dataclass
class _JobBase:
    job_id: str
    endpoint: str
    status: str = "queued"
    estimated_time_seconds: Optional[int] = None
    estimated_cost_usd: Optional[float] = None
    queued_at: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass
class Job(_JobBase):
    """A submitted job. Call `wait()` for the result or `refresh()` for the latest status."""

    _client: Optional["LastShoot"] = field(default=None, repr=False, compare=False)

    def refresh(self) -> JobStatus:
        assert self._client is not None
        st = self._client.jobs.get(self.endpoint, self.job_id)
        self.status = st.status
        return st

    def wait(
        self,
        poll_interval: Optional[float] = None,
        timeout: Optional[float] = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> Result:
        """Poll until the job completes. Raises JobFailedError or JobTimeoutError."""
        assert self._client is not None
        res = self._client.jobs.wait(
            self.endpoint, self.job_id, poll_interval=poll_interval, timeout=timeout, on_progress=on_progress
        )
        self.status = res.status
        return res


@dataclass
class AsyncJob(_JobBase):
    """Async variant of `Job`."""

    _client: Optional["AsyncLastShoot"] = field(default=None, repr=False, compare=False)

    async def refresh(self) -> JobStatus:
        assert self._client is not None
        st = await self._client.jobs.get(self.endpoint, self.job_id)
        self.status = st.status
        return st

    async def wait(
        self,
        poll_interval: Optional[float] = None,
        timeout: Optional[float] = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> Result:
        assert self._client is not None
        res = await self._client.jobs.wait(
            self.endpoint, self.job_id, poll_interval=poll_interval, timeout=timeout, on_progress=on_progress
        )
        self.status = res.status
        return res
