from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any, Dict, List

import httpx
import pytest
import respx

import lastshoot
from lastshoot import (
    APIConnectionError,
    AsyncJob,
    AsyncLastShoot,
    AuthenticationError,
    InsufficientCreditsError,
    InternalServerError,
    InvalidRequestError,
    Job,
    JobFailedError,
    JobStatus,
    JobTimeoutError,
    LastShoot,
    LastShootError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    Result,
)

BASE = "https://api.lastshoot.com"


def make_client(**kw: Any) -> LastShoot:
    c = LastShoot("test_key", poll_interval=0, **kw)
    c._sleep = lambda s: None  # no real sleeping in tests
    return c


def queued(job_id: str = "job_1") -> httpx.Response:
    return httpx.Response(200, json={"job_id": job_id, "status": "queued", "estimated_time_seconds": 4})


def status(state: str, **extra: Any) -> httpx.Response:
    return httpx.Response(200, json={"job_id": "job_1", "status": state, **extra})


DONE = dict(result_url="https://cdn.lastshoot.com/o/1.webp", result_mime_type="image/webp", progress=100, cost_usd=0.01)


# ---------------------------------------------------------------- construction


def test_api_key_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LASTSHOOT_API_KEY", "env_key")
    assert LastShoot().api_key == "env_key"


def test_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LASTSHOOT_API_KEY", raising=False)
    with pytest.raises(LastShootError, match="LASTSHOOT_API_KEY"):
        LastShoot()


def test_base_url_override_and_trailing_slash() -> None:
    c = LastShoot("k", base_url="https://staging.example.com/")
    assert c.base_url == "https://staging.example.com"


def test_version() -> None:
    assert lastshoot.__version__ == "0.1.1"


# ---------------------------------------------------------------- submit + wait


@respx.mock
def test_generate_blocks_and_returns_result() -> None:
    post = respx.post(f"{BASE}/generate/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/generate/image/v1/status/job_1").mock(
        side_effect=[status("queued", progress=0), status("processing", progress=40), status("completed", **DONE)]
    )
    seen: List[JobStatus] = []
    result = make_client().generate.image(prompt="fashion model", on_progress=seen.append)

    assert isinstance(result, Result)
    assert result.url == DONE["result_url"]
    assert result.mime_type == "image/webp"
    assert result.cost_usd == 0.01
    assert [s.status for s in seen] == ["queued", "processing", "completed"]
    assert [s.progress for s in seen] == [0, 40, 100]

    req = post.calls.last.request
    assert req.headers["X-API-Key"] == "test_key"
    assert req.headers["User-Agent"] == "lastshoot-python/0.1.1"
    assert json.loads(req.content) == {"prompt": "fashion model"}  # None values are not sent


@respx.mock
def test_wait_false_returns_job_then_wait() -> None:
    respx.post(f"{BASE}/edit/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/edit/image/v1/status/job_1").mock(
        side_effect=[status("processing", progress=50), status("completed", **DONE)]
    )
    c = make_client()
    job = c.edit.image(input_image="https://x/a.jpg", prompt="make it green", wait=False)
    assert isinstance(job, Job)
    assert job.job_id == "job_1" and job.status == "queued" and job.endpoint == "/edit/image/v1"
    assert job.estimated_time_seconds == 4
    progress: List[int] = []
    res = job.wait(poll_interval=0, timeout=60, on_progress=lambda s: progress.append(s.progress or 0))
    assert res.url == DONE["result_url"]
    assert progress == [50, 100]
    assert job.status == "completed"


@respx.mock
def test_job_refresh() -> None:
    respx.post(f"{BASE}/upscale/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/upscale/image/v1/status/job_1").mock(return_value=status("processing", progress=10))
    job = make_client().upscale.image(input_image="https://x/a.jpg", scale=2, wait=False)
    st = job.refresh()
    assert st.status == "processing" and st.progress == 10 and job.status == "processing"


@respx.mock
def test_edit_accepts_list_of_images() -> None:
    post = respx.post(f"{BASE}/edit/image/v1").mock(return_value=queued())
    make_client().edit.image(input_image=["https://x/a.jpg", "https://x/b.jpg"], prompt="combine", wait=False)
    assert json.loads(post.calls.last.request.content)["input_image"] == ["https://x/a.jpg", "https://x/b.jpg"]


@respx.mock
def test_failed_job_raises_job_failed_error() -> None:
    respx.post(f"{BASE}/background/remove/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/background/remove/image/v1/status/job_1").mock(
        return_value=status("failed", error="bad input", failure_reason_code="INPUT_INVALID", retryable=False)
    )
    with pytest.raises(JobFailedError) as ei:
        make_client().background.remove(input_image="https://x/a.jpg")
    err = ei.value
    assert err.job_id == "job_1"
    assert err.failure_reason_code == "INPUT_INVALID"
    assert err.retryable is False
    assert "bad input" in str(err)


@respx.mock
def test_cancelled_job_raises() -> None:
    respx.post(f"{BASE}/upscale/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/upscale/image/v1/status/job_1").mock(return_value=status("cancelled"))
    with pytest.raises(JobFailedError):
        make_client().upscale.image(input_image="https://x/a.jpg")


@respx.mock
def test_wait_timeout() -> None:
    respx.post(f"{BASE}/generate/video/v1").mock(return_value=queued())
    respx.get(f"{BASE}/generate/video/v1/status/job_1").mock(return_value=status("processing", progress=5))
    c = make_client()
    now = [0.0]

    def fake_sleep(s: float) -> None:
        now[0] += s

    c._sleep = fake_sleep
    c._clock = lambda: now[0]
    with pytest.raises(JobTimeoutError) as ei:
        c.generate.video(input_image="https://x/a.jpg", poll_interval=2, timeout=5)
    assert ei.value.job_id == "job_1"
    assert ei.value.last_status is not None and ei.value.last_status.progress == 5


@respx.mock
def test_missing_job_id_raises() -> None:
    respx.post(f"{BASE}/generate/image/v1").mock(return_value=httpx.Response(200, json={"status": "queued"}))
    with pytest.raises(LastShootError, match="no job_id"):
        make_client().generate.image(prompt="x")


# ---------------------------------------------------------------- every endpoint

ENDPOINT_CASES = [
    ("generate", "image", "/generate/image/v1", {"prompt": "p"}),
    ("generate", "video", "/generate/video/v1", {"input_image": "u"}),
    ("generate", "speech", "/generate/speech/v1", {"text": "hello"}),
    ("generate", "generate_3d", "/generate/3d/v1", {"image_path": "u"}),
    ("edit", "image", "/edit/image/v1", {"prompt": "p", "input_image": "u"}),
    ("background", "change", "/background/change/image/v1", {"input_image": "u", "prompt": "p", "subject_description": "s"}),
    ("background", "remove", "/background/remove/image/v1", {"input_image": "u", "recolor": "#FFFFFF"}),
    ("upscale", "image", "/upscale/image/v1", {"input_image": "u", "scale": 2}),
    ("branding", "logo", "/branding/logo/image/v1", {"input_image": "u", "logo_url": "l"}),
    ("branding", "template", "/branding/template/image/v1", {"input_image": "u", "palette_mode": "radical"}),
    ("identity", "tryon", "/creator/tryon/image/v1",
     {"person_image": "a", "clothing_image": "b", "gender": "woman", "clothing_type": "dress"}),
    ("identity", "faceswap", "/identity/faceswap/image/v1", {"target": "t", "source": "s"}),
    ("identity", "lock", "/identity/lock/image/v1", {"input_image": "u", "prompt": "p"}),
    ("identity", "replace", "/identity/replace/image/v1", {"input_image": "u", "prompt": "p"}),
    ("identity", "instamodel", "/creator/instamodel/image/v1", {"prompt": "p", "input_face": "f"}),
    ("identity", "voice_clone", "/identity/voice/clone/v1", {"text": "hi", "reference_voice_url": "v"}),
]


@pytest.mark.parametrize("ns,method,path,kwargs", ENDPOINT_CASES)
@respx.mock
def test_every_endpoint_posts_to_spec_path(ns: str, method: str, path: str, kwargs: Dict[str, Any]) -> None:
    route = respx.post(f"{BASE}{path}").mock(return_value=queued())
    job = getattr(getattr(make_client(), ns), method)(**kwargs, wait=False)
    assert isinstance(job, Job) and job.endpoint == path
    assert json.loads(route.calls.last.request.content) == kwargs


def test_endpoint_cases_cover_the_spec() -> None:
    spec_file = Path(__file__).resolve().parents[2] / "spec" / "openapi.json"
    if not spec_file.exists():
        pytest.skip("spec/openapi.json only exists in the repo checkout")
    spec = json.loads(spec_file.read_text(encoding="utf-8"))
    job_paths = {p.split("/status/")[0] for p in spec["paths"] if p.endswith("/status/{job_id}")}
    assert job_paths == {c[2] for c in ENDPOINT_CASES}


# ---------------------------------------------------------------- errors


@pytest.mark.parametrize(
    "code,exc",
    [
        (400, InvalidRequestError),
        (401, AuthenticationError),
        (402, InsufficientCreditsError),
        (403, PermissionDeniedError),
        (404, NotFoundError),
        (422, InvalidRequestError),
        (429, RateLimitError),
        (500, InternalServerError),
    ],
)
@respx.mock
def test_http_errors_map_to_exceptions(code: int, exc: type) -> None:
    route = respx.post(f"{BASE}/generate/image/v1").mock(
        return_value=httpx.Response(code, json={"detail": "nope"}, headers={"retry-after": "3"})
    )
    with pytest.raises(exc) as ei:
        make_client().generate.image(prompt="x")
    assert ei.value.status_code == code
    assert ei.value.message == "nope"
    assert route.call_count == 1  # POST is never retried
    if code == 429:
        assert ei.value.retry_after == 3.0


@respx.mock
def test_validation_error_message_and_code_parsing() -> None:
    respx.post(f"{BASE}/creator/tryon/image/v1").mock(
        return_value=httpx.Response(
            422, json={"detail": [{"loc": ["body", "clothing_type"], "msg": "Field required", "type": "missing"}]}
        )
    )
    with pytest.raises(InvalidRequestError, match="clothing_type: Field required"):
        make_client().identity.tryon(person_image="a", clothing_image="b", gender="man", clothing_type="")
    respx.post(f"{BASE}/upscale/image/v1").mock(
        return_value=httpx.Response(402, json={"detail": {"code": "INSUFFICIENT_CREDITS", "message": "Top up"}})
    )
    with pytest.raises(InsufficientCreditsError) as ei:
        make_client().upscale.image(input_image="u")
    assert ei.value.code == "INSUFFICIENT_CREDITS" and ei.value.message == "Top up"


@respx.mock
def test_get_retries_on_5xx_and_429_then_succeeds() -> None:
    respx.post(f"{BASE}/generate/image/v1").mock(return_value=queued())
    get = respx.get(f"{BASE}/generate/image/v1/status/job_1").mock(
        side_effect=[httpx.Response(503), httpx.Response(429, headers={"retry-after": "1"}), status("completed", **DONE)]
    )
    sleeps: List[float] = []
    c = make_client()
    c._sleep = sleeps.append
    res = c.generate.image(prompt="x")
    assert res.url == DONE["result_url"]
    assert get.call_count == 3
    assert sleeps[1] == 1.0  # honours Retry-After


@respx.mock
def test_get_retries_exhausted() -> None:
    get = respx.get(f"{BASE}/edit/image/v1/status/j").mock(return_value=httpx.Response(502, text="bad gateway"))
    with pytest.raises(InternalServerError) as ei:
        make_client(max_retries=2).jobs.get("/edit/image/v1", "j")
    assert get.call_count == 3
    assert ei.value.status_code == 502


@respx.mock
def test_connection_error_retried_then_raised() -> None:
    get = respx.get(f"{BASE}/edit/image/v1/status/j").mock(side_effect=httpx.ConnectError("boom"))
    with pytest.raises(APIConnectionError):
        make_client(max_retries=1).jobs.get("edit/image/v1", "j")
    assert get.call_count == 2


# ---------------------------------------------------------------- jobs, upload, profiles


@respx.mock
def test_jobs_get_normalises_endpoint() -> None:
    respx.get(f"{BASE}/edit/image/v1/status/abc").mock(
        return_value=httpx.Response(200, json={"job_id": "abc", "status": "processing", "progress": 70, "queue_position": 2})
    )
    st = make_client().jobs.get("edit/image/v1/", "abc")
    assert st.progress == 70 and st.endpoint == "/edit/image/v1" and st.raw["queue_position"] == 2
    assert not st.is_terminal


@respx.mock
def test_upload_path_bytes_and_fileobj(tmp_path: Path) -> None:
    route = respx.post(f"{BASE}/upload/image/v1").mock(
        return_value=httpx.Response(
            200, json={"url": "https://cdn/u.png", "filename": "p.png", "content_type": "image/png", "size_bytes": 3}
        )
    )
    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PN")
    c = make_client()

    r = c.upload.image(img)
    assert r.url == "https://cdn/u.png" and r.size_bytes == 3
    body = route.calls.last.request.content
    assert b'name="file"; filename="p.png"' in body and b"Content-Type: image/png" in body

    c.upload(b"abc", filename="x.jpg")  # callable shorthand
    assert b'filename="x.jpg"' in route.calls.last.request.content
    assert b"Content-Type: image/jpeg" in route.calls.last.request.content

    c.upload.image(io.BytesIO(b"abc"), filename="y.webp")
    assert b'filename="y.webp"' in route.calls.last.request.content
    assert route.call_count == 3


def test_upload_missing_file_raises() -> None:
    with pytest.raises(LastShootError, match="no such file"):
        make_client().upload.image("does-not-exist.png")


@respx.mock
def test_profiles_crud() -> None:
    prof = {"profile_id": "p 1", "name": "Anna", "adapter_snapshot": {}, "created_at": "t", "updated_at": "t"}
    create = respx.post(f"{BASE}/profiles/v1").mock(return_value=httpx.Response(200, json=prof))
    respx.get(f"{BASE}/profiles/v1").mock(return_value=httpx.Response(200, json={"profiles": [prof], "total": 1}))
    respx.get(f"{BASE}/profiles/v1/p%201").mock(return_value=httpx.Response(200, json=prof))
    patch = respx.patch(f"{BASE}/profiles/v1/p%201").mock(return_value=httpx.Response(200, json={**prof, "name": "B"}))
    delete = respx.delete(f"{BASE}/profiles/v1/p%201").mock(return_value=httpx.Response(204))
    c = make_client()
    assert c.identity.create_profile(name="Anna", tags=["x"])["profile_id"] == "p 1"
    assert json.loads(create.calls.last.request.content) == {"name": "Anna", "tags": ["x"]}
    assert c.identity.list_profiles()["total"] == 1
    assert c.identity.get_profile("p 1")["name"] == "Anna"
    assert c.identity.update_profile("p 1", name="B")["name"] == "B"
    assert json.loads(patch.calls.last.request.content) == {"name": "B"}
    assert c.identity.delete_profile("p 1") is None
    assert delete.called


# ---------------------------------------------------------------- async


@respx.mock
async def test_async_generate_wait_and_progress() -> None:
    respx.post(f"{BASE}/generate/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/generate/image/v1/status/job_1").mock(
        side_effect=[status("processing", progress=30), status("completed", **DONE)]
    )
    seen: List[int] = []

    async def on_progress(s: JobStatus) -> None:
        seen.append(s.progress or 0)

    async with AsyncLastShoot("k", poll_interval=0) as c:
        res = await c.generate.image(prompt="x", on_progress=on_progress)
    assert res.url == DONE["result_url"]
    assert seen == [30, 100]


@respx.mock
async def test_async_wait_false_upload_and_failure() -> None:
    respx.post(f"{BASE}/upload/image/v1").mock(return_value=httpx.Response(200, json={"url": "https://cdn/u"}))
    respx.post(f"{BASE}/background/change/image/v1").mock(return_value=queued())
    respx.get(f"{BASE}/background/change/image/v1/status/job_1").mock(
        return_value=status("failed", error="model down", failure_reason_code="MODEL_UNAVAILABLE", retryable=True)
    )
    async with AsyncLastShoot("k", poll_interval=0) as c:
        up = await c.upload(b"img", filename="a.png")
        job = await c.background.change(input_image=up.url, prompt="beach", subject_description="bottle", wait=False)
        assert isinstance(job, AsyncJob)
        with pytest.raises(JobFailedError) as ei:
            await job.wait()
    assert ei.value.retryable is True


@respx.mock
async def test_async_401() -> None:
    respx.post(f"{BASE}/upscale/image/v1").mock(return_value=httpx.Response(401, json={"detail": "Invalid API key"}))
    async with AsyncLastShoot("bad") as c:
        with pytest.raises(AuthenticationError, match="Invalid API key"):
            await c.upscale.image(input_image="u")
