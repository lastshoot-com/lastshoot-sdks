from __future__ import annotations

import asyncio
import inspect
import mimetypes
import os
import random
import time
from pathlib import Path
from typing import IO, Any, Callable, Dict, Optional, Tuple, Union

import httpx

from ._endpoints import (
    AsyncBackgroundResource,
    AsyncBrandingResource,
    AsyncEditResource,
    AsyncGenerateResource,
    AsyncIdentityResource,
    AsyncUpscaleResource,
    BackgroundResource,
    BrandingResource,
    EditResource,
    GenerateResource,
    IdentityResource,
    UpscaleResource,
    _seg,
)
from ._exceptions import (
    APIConnectionError,
    APITimeoutError,
    JobFailedError,
    JobTimeoutError,
    LastShootError,
    make_api_error,
)
from ._models import AsyncJob, Job, JobStatus, ProgressCallback, Result, UploadResult
from ._version import __version__

__all__ = ["LastShoot", "AsyncLastShoot", "DEFAULT_BASE_URL", "FileInput"]

DEFAULT_BASE_URL = "https://api.lastshoot.com"
DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2
DEFAULT_POLL_INTERVAL = 2.0
DEFAULT_WAIT_TIMEOUT = 600.0
UPLOAD_PATH = "/upload/image/v1"

FileInput = Union[str, "os.PathLike[str]", bytes, bytearray, IO[bytes]]

_RETRY_STATUSES = {429, 500, 502, 503, 504}


def _compact(body: Dict[str, Any]) -> Dict[str, Any]:
    """Drop None values so server-side defaults apply."""
    return {k: v for k, v in body.items() if v is not None}


def _backoff(attempt: int, retry_after: Optional[float]) -> float:
    if retry_after is not None and retry_after >= 0:
        return min(retry_after, 30.0)
    return min(0.5 * float(2**attempt), 8.0) + random.uniform(0, 0.25)


def _retry_after(resp: httpx.Response) -> Optional[float]:
    raw = resp.headers.get("retry-after")
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def _decode(resp: httpx.Response) -> Any:
    if not resp.content:
        return None
    try:
        return resp.json()
    except ValueError:
        return resp.text


def _file_part(
    file: FileInput, filename: Optional[str], content_type: Optional[str]
) -> Tuple[str, bytes, str]:
    if isinstance(file, (str, os.PathLike)):
        path = Path(file)
        if not path.is_file():
            raise LastShootError(f"upload: no such file: {path}")
        data = path.read_bytes()
        name = filename or path.name
    elif isinstance(file, (bytes, bytearray)):
        data = bytes(file)
        name = filename or "image"
    elif hasattr(file, "read"):
        data = file.read()
        if isinstance(data, str):
            raise LastShootError("upload: open the file in binary mode ('rb')")
        name = filename or Path(getattr(file, "name", "image") or "image").name
    else:
        raise LastShootError(f"upload: unsupported file input {type(file).__name__}")
    ctype = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return name, data, ctype


class _Base:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        wait_timeout: float = DEFAULT_WAIT_TIMEOUT,
        default_headers: Optional[Dict[str, str]] = None,
    ) -> None:
        api_key = api_key or os.environ.get("LASTSHOOT_API_KEY")
        if not api_key:
            raise LastShootError(
                "No API key. Pass LastShoot(api_key=...) or set LASTSHOOT_API_KEY. "
                "Get one at https://www.lastshoot.com/dashboard"
            )
        self.api_key = api_key
        self.base_url = (base_url or os.environ.get("LASTSHOOT_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.poll_interval = poll_interval
        self.wait_timeout = wait_timeout
        self._headers = {
            "X-API-Key": api_key,
            "Accept": "application/json",
            "User-Agent": f"lastshoot-python/{__version__}",
            **(default_headers or {}),
        }

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self.base_url!r})"


class _UploadResource:
    """`client.upload.image(file)`; `client.upload(file)` is the same call."""

    def __init__(self, client: "LastShoot") -> None:
        self._client = client

    def image(
        self, file: FileInput, *, filename: Optional[str] = None, content_type: Optional[str] = None
    ) -> UploadResult:
        """Upload a local image (path, bytes or binary file object). Returns a hosted `url`.

        PNG, JPEG, WebP or GIF, max 20 MB. `POST /upload/image/v1`
        """
        part = _file_part(file, filename, content_type)
        data = self._client._request_json("POST", UPLOAD_PATH, files={"file": part})
        return UploadResult.from_dict(data)

    __call__ = image


class _AsyncUploadResource:
    def __init__(self, client: "AsyncLastShoot") -> None:
        self._client = client

    async def image(
        self, file: FileInput, *, filename: Optional[str] = None, content_type: Optional[str] = None
    ) -> UploadResult:
        """Upload a local image (path, bytes or binary file object). Returns a hosted `url`."""
        part = _file_part(file, filename, content_type)
        data = await self._client._request_json("POST", UPLOAD_PATH, files={"file": part})
        return UploadResult.from_dict(data)

    __call__ = image


class _JobsResource:
    def __init__(self, client: "LastShoot") -> None:
        self._client = client

    def get(self, endpoint: str, job_id: str) -> JobStatus:
        """Fetch a job's status. `endpoint` is the submit path, e.g. `/edit/image/v1`."""
        endpoint = "/" + endpoint.strip("/")
        data = self._client._request_json("GET", f"{endpoint}/status/{_seg(job_id)}")
        return JobStatus.from_dict(data or {}, job_id=job_id, endpoint=endpoint)

    def wait(
        self,
        endpoint: str,
        job_id: str,
        *,
        poll_interval: Optional[float] = None,
        timeout: Optional[float] = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> Result:
        """Poll until the job is completed (returns Result) or failed/cancelled (raises JobFailedError)."""
        c = self._client
        interval = c.poll_interval if poll_interval is None else poll_interval
        limit = c.wait_timeout if timeout is None else timeout
        deadline = c._clock() + limit
        last: Optional[JobStatus] = None
        while True:
            last = self.get(endpoint, job_id)
            if on_progress is not None:
                on_progress(last)
            if last.status == "completed":
                return Result(**{k: getattr(last, k) for k in last.__dataclass_fields__})
            if last.is_terminal:
                raise JobFailedError(last)
            if c._clock() + interval > deadline:
                raise JobTimeoutError(job_id, limit, last)
            c._sleep(interval)


class _AsyncJobsResource:
    def __init__(self, client: "AsyncLastShoot") -> None:
        self._client = client

    async def get(self, endpoint: str, job_id: str) -> JobStatus:
        endpoint = "/" + endpoint.strip("/")
        data = await self._client._request_json("GET", f"{endpoint}/status/{_seg(job_id)}")
        return JobStatus.from_dict(data or {}, job_id=job_id, endpoint=endpoint)

    async def wait(
        self,
        endpoint: str,
        job_id: str,
        *,
        poll_interval: Optional[float] = None,
        timeout: Optional[float] = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> Result:
        c = self._client
        interval = c.poll_interval if poll_interval is None else poll_interval
        limit = c.wait_timeout if timeout is None else timeout
        deadline = c._clock() + limit
        while True:
            last = await self.get(endpoint, job_id)
            if on_progress is not None:
                maybe = on_progress(last)
                if inspect.isawaitable(maybe):
                    await maybe
            if last.status == "completed":
                return Result(**{k: getattr(last, k) for k in last.__dataclass_fields__})
            if last.is_terminal:
                raise JobFailedError(last)
            if c._clock() + interval > deadline:
                raise JobTimeoutError(job_id, limit, last)
            await c._sleep(interval)


class LastShoot(_Base):
    """Synchronous LastShoot client.

    >>> from lastshoot import LastShoot
    >>> client = LastShoot("ls_live_...")          # or set LASTSHOOT_API_KEY
    >>> result = client.generate.image(prompt="fashion model, white studio background")
    >>> result.url
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        wait_timeout: float = DEFAULT_WAIT_TIMEOUT,
        default_headers: Optional[Dict[str, str]] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            poll_interval=poll_interval,
            wait_timeout=wait_timeout,
            default_headers=default_headers,
        )
        self._http = http_client or httpx.Client(timeout=timeout)
        self._owns_http = http_client is None
        self._sleep: Callable[[float], None] = time.sleep
        self._clock: Callable[[], float] = time.monotonic
        self.generate = GenerateResource(self)
        self.edit = EditResource(self)
        self.background = BackgroundResource(self)
        self.upscale = UpscaleResource(self)
        self.branding = BrandingResource(self)
        self.identity = IdentityResource(self)
        self.upload = _UploadResource(self)
        self.jobs = _JobsResource(self)

    # -- lifecycle
    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "LastShoot":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- transport
    def _request_json(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        files: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = self.base_url + path
        body = _compact(json) if json is not None else None
        # Only GET is retried: a retried POST could run (and bill) a job twice.
        retries = self.max_retries if method == "GET" else 0
        attempt = 0
        while True:
            try:
                resp = self._http.request(method, url, json=body, files=files, headers=self._headers)
            except httpx.TimeoutException as e:
                if attempt < retries:
                    self._sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise APITimeoutError(f"{method} {path} timed out") from e
            except httpx.HTTPError as e:
                if attempt < retries:
                    self._sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise APIConnectionError(f"{method} {path} failed: {e}") from e
            if resp.status_code in _RETRY_STATUSES and attempt < retries:
                self._sleep(_backoff(attempt, _retry_after(resp)))
                attempt += 1
                continue
            if resp.status_code >= 400:
                raise make_api_error(resp.status_code, _decode(resp), resp.headers)
            return _decode(resp)

    def _submit(self, path: str, body: Dict[str, Any]) -> Job:
        data = self._request_json("POST", path, json=body) or {}
        if not data.get("job_id"):
            raise LastShootError(f"POST {path} returned no job_id: {data!r}")
        return Job(
            job_id=data["job_id"],
            endpoint=path,
            status=data.get("status") or "queued",
            estimated_time_seconds=data.get("estimated_time_seconds"),
            estimated_cost_usd=data.get("estimated_cost_usd"),
            queued_at=data.get("queued_at"),
            raw=data,
            _client=self,
        )

    def _run(
        self,
        path: str,
        body: Dict[str, Any],
        *,
        wait: bool,
        poll_interval: Optional[float],
        timeout: Optional[float],
        on_progress: Optional[ProgressCallback],
    ) -> Union[Result, Job]:
        job = self._submit(path, body)
        if not wait:
            return job
        return job.wait(poll_interval=poll_interval, timeout=timeout, on_progress=on_progress)


async def _async_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


class AsyncLastShoot(_Base):
    """Asyncio LastShoot client. Same surface as `LastShoot`, every call is awaitable.

    >>> async with AsyncLastShoot() as client:
    ...     result = await client.edit.image(input_image=url, prompt="make the dress emerald")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        wait_timeout: float = DEFAULT_WAIT_TIMEOUT,
        default_headers: Optional[Dict[str, str]] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            poll_interval=poll_interval,
            wait_timeout=wait_timeout,
            default_headers=default_headers,
        )
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self._owns_http = http_client is None
        self._sleep: Callable[[float], Any] = _async_sleep
        self._clock: Callable[[], float] = time.monotonic
        self.generate = AsyncGenerateResource(self)
        self.edit = AsyncEditResource(self)
        self.background = AsyncBackgroundResource(self)
        self.upscale = AsyncUpscaleResource(self)
        self.branding = AsyncBrandingResource(self)
        self.identity = AsyncIdentityResource(self)
        self.upload = _AsyncUploadResource(self)
        self.jobs = _AsyncJobsResource(self)

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncLastShoot":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        files: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = self.base_url + path
        body = _compact(json) if json is not None else None
        retries = self.max_retries if method == "GET" else 0
        attempt = 0
        while True:
            try:
                resp = await self._http.request(method, url, json=body, files=files, headers=self._headers)
            except httpx.TimeoutException as e:
                if attempt < retries:
                    await self._sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise APITimeoutError(f"{method} {path} timed out") from e
            except httpx.HTTPError as e:
                if attempt < retries:
                    await self._sleep(_backoff(attempt, None))
                    attempt += 1
                    continue
                raise APIConnectionError(f"{method} {path} failed: {e}") from e
            if resp.status_code in _RETRY_STATUSES and attempt < retries:
                await self._sleep(_backoff(attempt, _retry_after(resp)))
                attempt += 1
                continue
            if resp.status_code >= 400:
                raise make_api_error(resp.status_code, _decode(resp), resp.headers)
            return _decode(resp)

    async def _submit(self, path: str, body: Dict[str, Any]) -> AsyncJob:
        data = await self._request_json("POST", path, json=body) or {}
        if not data.get("job_id"):
            raise LastShootError(f"POST {path} returned no job_id: {data!r}")
        return AsyncJob(
            job_id=data["job_id"],
            endpoint=path,
            status=data.get("status") or "queued",
            estimated_time_seconds=data.get("estimated_time_seconds"),
            estimated_cost_usd=data.get("estimated_cost_usd"),
            queued_at=data.get("queued_at"),
            raw=data,
            _client=self,
        )

    async def _run(
        self,
        path: str,
        body: Dict[str, Any],
        *,
        wait: bool,
        poll_interval: Optional[float],
        timeout: Optional[float],
        on_progress: Optional[ProgressCallback],
    ) -> Union[Result, AsyncJob]:
        job = await self._submit(path, body)
        if not wait:
            return job
        return await job.wait(poll_interval=poll_interval, timeout=timeout, on_progress=on_progress)
