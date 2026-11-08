# @lastshoot/sdk

**[Website](https://www.lastshoot.com)** · **[Docs](https://www.lastshoot.com/docs/sdks/typescript)** · [API reference](https://api.lastshoot.com/docs) · [Get an API key](https://www.lastshoot.com/dashboard) · [GitHub](https://github.com/lastshoot-com/lastshoot-sdks)

Official TypeScript / JavaScript client for the [LastShoot](https://www.lastshoot.com) AI
product-photography API: product-to-model, virtual try-on, background change and removal,
edits, upscaling, branding, identity, video, speech and 3D. Fully typed, zero runtime
dependencies, ESM and CommonJS.

```bash
npm install @lastshoot/sdk
# or
pnpm add @lastshoot/sdk
# or
yarn add @lastshoot/sdk
```

Requires Node.js 18+ (uses native `fetch`). Also runs on Bun, Deno and edge runtimes; file-path
uploads need Node.

## Quickstart

Get an API key from the [dashboard](https://www.lastshoot.com/dashboard).

```ts
import { LastShoot } from "@lastshoot/sdk";

const client = new LastShoot("ls_live_xxxxxxxxxxxx"); // or new LastShoot() with LASTSHOOT_API_KEY set

// Generate
const result = await client.generate.image({
  prompt: "fashion model, white studio background, editorial lighting",
});
console.log(result.url);

// Virtual try-on
const tryon = await client.identity.tryon({
  personImage: "https://cdn.example.com/model.jpg",
  clothingImage: "https://cdn.example.com/shirt.jpg",
  gender: "woman",
  clothingType: "shirt",
});
console.log(tryon.url);
```

`result.url` is a temporary link (expires within 24 hours). Download and store the file.

## Local files

Every image parameter takes a public URL. Upload a local file first:

```ts
const uploaded = await client.upload.image("./product.jpg"); // path (Node), Blob/File, Buffer, Uint8Array, ArrayBuffer
const result = await client.background.change({
  inputImage: uploaded.url,
  prompt: "white marble table, soft daylight",
  subjectDescription: "glass perfume bottle",
});
```

`client.upload(file)` is shorthand for `client.upload.image(file)`, and `client.upload.image({ file, filename })`
also works.

## Jobs, progress and webhooks

Every compute method submits a job and resolves when it finishes. Pass `wait: false` to get a
`Job` back right after submission:

```ts
const job = await client.edit.image({ inputImage: url, prompt: "make the dress emerald green", wait: false });
console.log(job.jobId, job.status); // e.g. "queued"

const result = await job.wait({
  pollInterval: 2000, // ms between polls
  timeout: 600_000, // ms, then JobTimeoutError
  onProgress: (s) => console.log(s.status, s.progress),
  signal: AbortSignal.timeout(900_000), // optional
});
console.log(result.url, result.mimeType, result.costUsd);
```

The same `pollInterval`, `timeout`, `onProgress` and `signal` options can be passed straight to
any compute method. Look up any job later with `client.jobs.get("/edit/image/v1", jobId)` or
`client.jobs.wait("/edit/image/v1", jobId)`.

Pass `callbackUrl` to any compute method to have a webhook POSTed when the job finishes. The
`WebhookEvent` type describes that payload.

## Methods

| Method | Endpoint |
| --- | --- |
| `client.generate.image({ prompt })` | `POST /generate/image/v1` |
| `client.generate.video({ inputImage })` | `POST /generate/video/v1` |
| `client.generate.speech({ text })` | `POST /generate/speech/v1` |
| `client.generate.generate3d({ imagePath })` | `POST /generate/3d/v1` |
| `client.edit.image({ prompt, inputImage })` | `POST /edit/image/v1` |
| `client.background.change({ inputImage, prompt, subjectDescription })` | `POST /background/change/image/v1` |
| `client.background.remove({ inputImage })` | `POST /background/remove/image/v1` |
| `client.upscale.image({ inputImage })` | `POST /upscale/image/v1` |
| `client.branding.logo({ inputImage, logoUrl })` | `POST /branding/logo/image/v1` |
| `client.branding.template({ inputImage })` | `POST /branding/template/image/v1` |
| `client.identity.tryon({ personImage, clothingImage, gender, clothingType })` | `POST /creator/tryon/image/v1` |
| `client.identity.faceswap({ target, source })` | `POST /identity/faceswap/image/v1` |
| `client.identity.lock({ inputImage, prompt })` | `POST /identity/lock/image/v1` |
| `client.identity.replace({ inputImage, prompt })` | `POST /identity/replace/image/v1` |
| `client.identity.instamodel({ prompt, inputFace })` | `POST /creator/instamodel/image/v1` |
| `client.identity.voiceClone({ text, referenceVoiceUrl })` | `POST /identity/voice/clone/v1` |
| `client.identity.createProfile / listProfiles / getProfile / updateProfile / deleteProfile` | `/profiles/v1` |
| `client.upload.image(file)` | `POST /upload/image/v1` |
| `client.jobs.get(endpoint, jobId)` / `client.jobs.wait(endpoint, jobId)` | `GET <endpoint>/status/{job_id}` |

Options are camelCase and typed from the live [OpenAPI spec](https://api.lastshoot.com/docs);
the SDK converts them to the API's snake_case. Responses come back camelCase too, with the
untouched response on `.raw`. Full parameter reference:
[lastshoot.com/docs/sdks/typescript](https://www.lastshoot.com/docs/sdks/typescript).

## Errors

```ts
import {
  LastShootError, // base class
  APIError, // any non-2xx: .status .code .body .requestId
  AuthenticationError, // 401
  InsufficientCreditsError, // 402
  PermissionDeniedError, // 403
  NotFoundError, // 404
  InvalidRequestError, // 400 / 422
  RateLimitError, // 429 (.retryAfter)
  InternalServerError, // 5xx
  APIConnectionError,
  APITimeoutError,
  JobFailedError, // job failed/cancelled: .failureReasonCode .retryable .error
  JobTimeoutError, // wait() gave up; the job keeps running server-side
} from "@lastshoot/sdk";
```

Status polls (GET) retry automatically on 429, 5xx and network errors with exponential backoff
(`maxRetries: 2` by default). Job submissions (POST) are never retried, so a job is never billed
twice.

## Configuration

```ts
new LastShoot({
  apiKey: "...", // default: process.env.LASTSHOOT_API_KEY
  baseUrl: "https://api.lastshoot.com",
  timeout: 60_000, // ms per HTTP request
  maxRetries: 2, // GET retries
  pollInterval: 2_000, // default for wait()
  waitTimeout: 600_000, // default for wait()
  fetch: customFetch, // optional
});
```

Keep your API key on the server. Do not ship it in browser bundles.

## License

MIT
