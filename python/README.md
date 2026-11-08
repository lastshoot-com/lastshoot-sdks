# LastShoot Python SDK

**[Website](https://www.lastshoot.com)** · **[Docs](https://www.lastshoot.com/docs/sdks/python)** · [API reference](https://api.lastshoot.com/docs) · [Get an API key](https://www.lastshoot.com/dashboard) · [GitHub](https://github.com/lastshoot-com/lastshoot-sdks)

Official Python client for the [LastShoot](https://www.lastshoot.com) AI product-photography API:
product-to-model, virtual try-on, background change and removal, edits, upscaling, branding,
identity, video, speech and 3D.

```bash
pip install lastshoot
```

Requires Python 3.9+. One runtime dependency: `httpx`.

## Quickstart

Get an API key from the [dashboard](https://www.lastshoot.com/dashboard).

```python
from lastshoot import LastShoot

client = LastShoot("ls_live_xxxxxxxxxxxx")   # or LastShoot() with LASTSHOOT_API_KEY set

# Generate
result = client.generate.image(prompt="fashion model, white studio background, editorial lighting")
print(result.url)

# Virtual try-on
result = client.identity.tryon(
    person_image="https://cdn.example.com/model.jpg",
    clothing_image="https://cdn.example.com/shirt.jpg",
    gender="woman",
    clothing_type="shirt",
)
print(result.url)
```

`result.url` is a temporary link (expires within 24 hours). Download and store the file.

## Local files

Every image parameter takes a public URL. Upload a local file first:

```python
uploaded = client.upload.image("product.jpg")        # path, bytes, or a file opened with "rb"
result = client.background.change(
    input_image=uploaded.url,
    prompt="white marble table, soft daylight",
    subject_description="glass perfume bottle",
)
```

`client.upload("product.jpg")` is shorthand for `client.upload.image(...)`.

## Jobs, progress and webhooks

Every compute method submits a job and blocks until it finishes. Pass `wait=False` to get a
`Job` back immediately, then wait when you are ready:

```python
job = client.edit.image(input_image=url, prompt="make the dress emerald green", wait=False)
print(job.job_id, job.status)          # e.g. "queued"

result = job.wait(
    poll_interval=2,                   # seconds between polls
    timeout=600,                       # raise JobTimeoutError after this
    on_progress=lambda s: print(s.status, s.progress),
)
print(result.url, result.mime_type, result.cost_usd)
```

Look up any job later with `client.jobs.get("/edit/image/v1", job_id)` (returns a `JobStatus`) or
`client.jobs.wait("/edit/image/v1", job_id)`.

Pass `callback_url=` to any compute method to have a `WebhookEvent` POSTed when the job
finishes. `lastshoot.WebhookEvent` is a `TypedDict` of that payload.

## Methods

| Method | Endpoint |
| --- | --- |
| `client.generate.image(prompt=...)` | `POST /generate/image/v1` |
| `client.generate.video(input_image=...)` | `POST /generate/video/v1` |
| `client.generate.speech(text=...)` | `POST /generate/speech/v1` |
| `client.generate.generate_3d(image_path=...)` | `POST /generate/3d/v1` |
| `client.edit.image(prompt=..., input_image=...)` | `POST /edit/image/v1` |
| `client.background.change(input_image=..., prompt=..., subject_description=...)` | `POST /background/change/image/v1` |
| `client.background.remove(input_image=...)` | `POST /background/remove/image/v1` |
| `client.upscale.image(input_image=...)` | `POST /upscale/image/v1` |
| `client.branding.logo(input_image=..., logo_url=...)` | `POST /branding/logo/image/v1` |
| `client.branding.template(input_image=...)` | `POST /branding/template/image/v1` |
| `client.identity.tryon(person_image=..., clothing_image=..., gender=..., clothing_type=...)` | `POST /creator/tryon/image/v1` |
| `client.identity.faceswap(target=..., source=...)` | `POST /identity/faceswap/image/v1` |
| `client.identity.lock(input_image=..., prompt=...)` | `POST /identity/lock/image/v1` |
| `client.identity.replace(input_image=..., prompt=...)` | `POST /identity/replace/image/v1` |
| `client.identity.instamodel(prompt=..., input_face=...)` | `POST /creator/instamodel/image/v1` |
| `client.identity.voice_clone(text=..., reference_voice_url=...)` | `POST /identity/voice/clone/v1` |
| `client.identity.create_profile / list_profiles / get_profile / update_profile / delete_profile` | `/profiles/v1` |
| `client.upload.image(file)` | `POST /upload/image/v1` |
| `client.jobs.get(endpoint, job_id)` / `client.jobs.wait(endpoint, job_id)` | `GET <endpoint>/status/{job_id}` |

All parameters are keyword arguments in snake_case, typed from the live
[OpenAPI spec](https://api.lastshoot.com/docs). Options you leave out use the server default.
Full parameter reference: [lastshoot.com/docs/sdks/python](https://www.lastshoot.com/docs/sdks/python).

## Async

```python
import asyncio
from lastshoot import AsyncLastShoot

async def main():
    async with AsyncLastShoot() as client:
        result = await client.upscale.image(input_image="https://cdn.example.com/shoe.jpg", scale=2)
        print(result.url)

asyncio.run(main())
```

## Errors

```python
from lastshoot import (
    LastShootError,            # base class
    APIError,                  # any non-2xx response: .status_code .message .code .body
    AuthenticationError,       # 401
    InsufficientCreditsError,  # 402
    PermissionDeniedError,     # 403
    NotFoundError,             # 404
    InvalidRequestError,       # 400 / 422
    RateLimitError,            # 429 (.retry_after)
    InternalServerError,       # 5xx
    APIConnectionError, APITimeoutError,
    JobFailedError,            # job ended failed/cancelled: .failure_reason_code .retryable .error
    JobTimeoutError,           # wait() gave up; the job keeps running server-side
)
```

Status polls (GET) retry automatically on 429, 5xx and network errors with exponential
backoff (`max_retries=2` by default). Job submissions (POST) are never retried automatically,
so a job is never billed twice.

## Configuration

```python
LastShoot(
    api_key=None,                      # default: LASTSHOOT_API_KEY env var
    base_url="https://api.lastshoot.com",
    timeout=60.0,                      # per HTTP request
    max_retries=2,                     # GET retries
    poll_interval=2.0,                 # default for wait()
    wait_timeout=600.0,                # default for wait()
)
```

## License

MIT
