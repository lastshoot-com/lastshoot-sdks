import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APIConnectionError,
  AuthenticationError,
  InsufficientCreditsError,
  InternalServerError,
  InvalidRequestError,
  Job,
  JobFailedError,
  JobTimeoutError,
  LastShoot,
  LastShootError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  type JobStatus,
} from "../src/index.js";

const BASE = "https://api.lastshoot.com";

type Handler = Response | Error | (() => Response);
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  raw: RequestInit["body"];
}

/** Route table: "METHOD path" -> queue of responses (the last one repeats). */
function mockFetch(routes: Record<string, Handler[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    let body: unknown = init.body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    calls.push({ method, url, headers, body, raw: init.body });
    const key = `${method} ${url.replace(BASE, "")}`;
    const queue = routes[key];
    if (!queue || queue.length === 0) throw new Error(`unmocked ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const queued = (id = "job_1") => json({ job_id: id, status: "queued", estimated_time_seconds: 4 });
const st = (status: string, extra: Record<string, unknown> = {}) => json({ job_id: "job_1", status, ...extra });
const DONE = {
  result_url: "https://cdn.lastshoot.com/o/1.webp",
  result_mime_type: "image/webp",
  progress: 100,
  cost_usd: 0.01,
};

function makeClient(fetchImpl: typeof fetch, opts: Record<string, unknown> = {}) {
  const c = new LastShoot("test_key", { fetch: fetchImpl, pollInterval: 0, ...opts });
  c._sleep = async () => {};
  return c;
}

describe("construction", () => {
  it("accepts a positional key or options, reads env, and requires a key", () => {
    expect(new LastShoot("k", { fetch: fetch }).baseUrl).toBe(BASE);
    expect(new LastShoot({ apiKey: "k", baseUrl: "https://x.test/" }).baseUrl).toBe("https://x.test");
    const prev = process.env.LASTSHOOT_API_KEY;
    process.env.LASTSHOOT_API_KEY = "env_key_123456";
    expect(new LastShoot().apiKeyHint).toBe("env_key_...");
    delete process.env.LASTSHOOT_API_KEY;
    expect(() => new LastShoot()).toThrow(/LASTSHOOT_API_KEY/);
    if (prev !== undefined) process.env.LASTSHOOT_API_KEY = prev;
  });
});

describe("submit + wait", () => {
  it("blocks by default, reports progress, maps camelCase to snake_case", async () => {
    const { fetchImpl, calls } = mockFetch({
      "POST /generate/image/v1": [queued()],
      "GET /generate/image/v1/status/job_1": [st("queued", { progress: 0 }), st("processing", { progress: 40 }), st("completed", DONE)],
    });
    const seen: JobStatus[] = [];
    const result = await makeClient(fetchImpl).generate.image({
      prompt: "fashion model",
      numInferenceSteps: 8,
      outputFormat: "png",
      onProgress: (s) => {
        seen.push(s);
      },
    });
    expect(result.url).toBe(DONE.result_url);
    expect(result.mimeType).toBe("image/webp");
    expect(result.costUsd).toBe(0.01);
    expect(result.raw.result_url).toBe(DONE.result_url);
    expect(seen.map((s) => s.status)).toEqual(["queued", "processing", "completed"]);
    expect(seen.map((s) => s.progress)).toEqual([0, 40, 100]);
    expect(calls[0]!.headers["X-API-Key"]).toBe("test_key");
    expect(calls[0]!.headers["User-Agent"]).toBe("lastshoot-typescript/0.1.1");
    expect(calls[0]!.body).toEqual({ prompt: "fashion model", num_inference_steps: 8, output_format: "png" });
  });

  it("wait: false returns a Job; job.wait and job.refresh work", async () => {
    const { fetchImpl } = mockFetch({
      "POST /creator/tryon/image/v1": [queued()],
      "GET /creator/tryon/image/v1/status/job_1": [st("processing", { progress: 10 }), st("processing", { progress: 60 }), st("completed", DONE)],
    });
    const client = makeClient(fetchImpl);
    const job = await client.identity.tryon({
      personImage: "https://cdn.example.com/model.jpg",
      clothingImage: "https://cdn.example.com/shirt.jpg",
      gender: "woman",
      clothingType: "shirt",
      wait: false,
    });
    expect(job).toBeInstanceOf(Job);
    expect(job.jobId).toBe("job_1");
    expect(job.endpoint).toBe("/creator/tryon/image/v1");
    expect(job.estimatedTimeSeconds).toBe(4);
    expect((await job.refresh()).progress).toBe(10);
    const progress: number[] = [];
    const res = await job.wait({ onProgress: (s) => void progress.push(s.progress ?? 0) });
    expect(res.url).toBe(DONE.result_url);
    expect(progress).toEqual([60, 100]);
    expect(job.status).toBe("completed");
  });

  it("throws JobFailedError with reason code", async () => {
    const { fetchImpl } = mockFetch({
      "POST /background/remove/image/v1": [queued()],
      "GET /background/remove/image/v1/status/job_1": [
        st("failed", { error: "bad input", failure_reason_code: "INPUT_INVALID", retryable: false }),
      ],
    });
    const err = await makeClient(fetchImpl)
      .background.remove({ inputImage: "https://x/a.jpg" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailedError);
    const e = err as JobFailedError;
    expect(e.failureReasonCode).toBe("INPUT_INVALID");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("bad input");
  });

  it("treats cancelled as failure", async () => {
    const { fetchImpl } = mockFetch({
      "POST /upscale/image/v1": [queued()],
      "GET /upscale/image/v1/status/job_1": [st("cancelled")],
    });
    await expect(makeClient(fetchImpl).upscale.image({ inputImage: "u" })).rejects.toBeInstanceOf(JobFailedError);
  });

  it("throws JobTimeoutError when the deadline passes", async () => {
    const { fetchImpl } = mockFetch({
      "POST /generate/video/v1": [queued()],
      "GET /generate/video/v1/status/job_1": [st("processing", { progress: 5 })],
    });
    const client = makeClient(fetchImpl);
    let now = 0;
    client._now = () => now;
    client._sleep = async (ms) => {
      now += ms;
    };
    const err = (await client.generate
      .video({ inputImage: "u", pollInterval: 2000, timeout: 5000 })
      .catch((e: unknown) => e)) as JobTimeoutError;
    expect(err).toBeInstanceOf(JobTimeoutError);
    expect(err.lastStatus?.progress).toBe(5);
  });

  it("supports aborting a wait", async () => {
    const { fetchImpl } = mockFetch({
      "POST /edit/image/v1": [queued()],
      "GET /edit/image/v1/status/job_1": [st("processing")],
    });
    const client = new LastShoot("k", { fetch: fetchImpl, pollInterval: 50 });
    const ctrl = new AbortController();
    const p = client.edit.image({ prompt: "x", inputImage: "u", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error("stop")), 10);
    await expect(p).rejects.toThrow("stop");
  });

  it("rejects a submit response without job_id", async () => {
    const { fetchImpl } = mockFetch({ "POST /generate/image/v1": [json({ status: "queued" })] });
    await expect(makeClient(fetchImpl).generate.image({ prompt: "x" })).rejects.toThrow(/no job_id/);
  });
});

const CASES: Array<[string, string, string, Record<string, unknown>, Record<string, unknown>]> = [
  ["generate", "image", "/generate/image/v1", { prompt: "p" }, { prompt: "p" }],
  ["generate", "video", "/generate/video/v1", { inputImage: "u", durationSeconds: 3 }, { input_image: "u", duration_seconds: 3 }],
  ["generate", "speech", "/generate/speech/v1", { text: "hi", languageId: "en" }, { text: "hi", language_id: "en" }],
  ["generate", "generate3d", "/generate/3d/v1", { imagePath: "u" }, { image_path: "u" }],
  ["edit", "image", "/edit/image/v1", { prompt: "p", inputImage: ["a", "b"] }, { prompt: "p", input_image: ["a", "b"] }],
  [
    "background",
    "change",
    "/background/change/image/v1",
    { inputImage: "u", prompt: "p", subjectDescription: "s", trueCfgScale: 4 },
    { input_image: "u", prompt: "p", subject_description: "s", true_cfg_scale: 4 },
  ],
  ["background", "remove", "/background/remove/image/v1", { inputImage: "u", dropShadow: true }, { input_image: "u", drop_shadow: true }],
  ["upscale", "image", "/upscale/image/v1", { inputImage: "u", scale: 2 }, { input_image: "u", scale: 2 }],
  ["branding", "logo", "/branding/logo/image/v1", { inputImage: "u", logoUrl: "l" }, { input_image: "u", logo_url: "l" }],
  ["branding", "template", "/branding/template/image/v1", { inputImage: "u", paletteMode: "radical" }, { input_image: "u", palette_mode: "radical" }],
  [
    "identity",
    "tryon",
    "/creator/tryon/image/v1",
    { personImage: "a", clothingImage: "b", gender: "man", clothingType: "jacket", garmentRegion: "upper" },
    { person_image: "a", clothing_image: "b", gender: "man", clothing_type: "jacket", garment_region: "upper" },
  ],
  ["identity", "faceswap", "/identity/faceswap/image/v1", { target: "t", source: "s", restoreWeight: 0.5 }, { target: "t", source: "s", restore_weight: 0.5 }],
  ["identity", "lock", "/identity/lock/image/v1", { inputImage: "u", prompt: "p" }, { input_image: "u", prompt: "p" }],
  ["identity", "replace", "/identity/replace/image/v1", { inputImage: "u", prompt: "p" }, { input_image: "u", prompt: "p" }],
  ["identity", "instamodel", "/creator/instamodel/image/v1", { prompt: "p", inputFace: "f" }, { prompt: "p", input_face: "f" }],
  ["identity", "voiceClone", "/identity/voice/clone/v1", { text: "hi", referenceVoiceUrl: "v" }, { text: "hi", reference_voice_url: "v" }],
];

describe("every endpoint", () => {
  it.each(CASES)("%s.%s posts to %s", async (ns, method, path, params, body) => {
    const { fetchImpl, calls } = mockFetch({ [`POST ${path}`]: [queued()] });
    const client = makeClient(fetchImpl) as unknown as Record<string, Record<string, (p: object) => Promise<Job>>>;
    const job = await client[ns]![method]!({ ...params, wait: false });
    expect(job.endpoint).toBe(path);
    expect(calls[0]!.body).toEqual(body);
  });

  it("covers every job endpoint in the spec", () => {
    const spec = JSON.parse(readFileSync(join(__dirname, "../../spec/openapi.json"), "utf8")) as { paths: Record<string, unknown> };
    const jobPaths = Object.keys(spec.paths)
      .filter((p) => p.endsWith("/status/{job_id}"))
      .map((p) => p.split("/status/")[0]);
    expect(new Set(jobPaths)).toEqual(new Set(CASES.map((c) => c[2])));
  });
});

describe("errors and retries", () => {
  it.each([
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [402, InsufficientCreditsError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [422, InvalidRequestError],
    [429, RateLimitError],
    [500, InternalServerError],
  ] as const)("HTTP %i -> %o and POST is not retried", async (status, cls) => {
    const { fetchImpl, calls } = mockFetch({
      "POST /generate/image/v1": [json({ detail: "nope" }, status, { "retry-after": "3" })],
    });
    const err = await makeClient(fetchImpl).generate.image({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect((err as InvalidRequestError).status).toBe(status);
    expect((err as Error).message).toContain("nope");
    expect(calls).toHaveLength(1);
    if (status === 429) expect((err as RateLimitError).retryAfter).toBe(3);
  });

  it("parses FastAPI validation errors and coded details", async () => {
    const { fetchImpl } = mockFetch({
      "POST /creator/tryon/image/v1": [
        json({ detail: [{ loc: ["body", "clothing_type"], msg: "Field required", type: "missing" }] }, 422),
      ],
      "POST /upscale/image/v1": [json({ detail: { code: "INSUFFICIENT_CREDITS", message: "Top up" } }, 402)],
    });
    const client = makeClient(fetchImpl);
    await expect(
      client.identity.tryon({ personImage: "a", clothingImage: "b", gender: "man", clothingType: "" }),
    ).rejects.toThrow("clothing_type: Field required");
    const e = (await client.upscale.image({ inputImage: "u" }).catch((x: unknown) => x)) as InsufficientCreditsError;
    expect(e.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("retries GET on 503/429 honouring Retry-After", async () => {
    const { fetchImpl, calls } = mockFetch({
      "POST /generate/image/v1": [queued()],
      "GET /generate/image/v1/status/job_1": [
        new Response("", { status: 503 }),
        json({ detail: "slow down" }, 429, { "retry-after": "1" }),
        st("completed", DONE),
      ],
    });
    const client = makeClient(fetchImpl);
    const sleeps: number[] = [];
    client._sleep = async (ms) => void sleeps.push(ms);
    expect((await client.generate.image({ prompt: "x" })).url).toBe(DONE.result_url);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
    expect(sleeps[1]).toBe(1000);
  });

  it("gives up after maxRetries", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /edit/image/v1/status/j": [new Response("bad gateway", { status: 502 })] });
    const err = (await makeClient(fetchImpl).jobs.get("/edit/image/v1", "j").catch((e: unknown) => e)) as InternalServerError;
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err.status).toBe(502);
    expect(calls).toHaveLength(3);
  });

  it("retries network errors on GET then throws APIConnectionError", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /edit/image/v1/status/j": [new TypeError("fetch failed")] });
    await expect(makeClient(fetchImpl, { maxRetries: 1 }).jobs.get("edit/image/v1/", "j")).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(2);
  });

  it("all errors extend LastShootError", () => {
    expect(new RateLimitError("x", { status: 429 })).toBeInstanceOf(LastShootError);
    expect(new RateLimitError("x", { status: 429 }).name).toBe("RateLimitError");
  });
});

describe("jobs, upload, profiles", () => {
  it("jobs.get normalises the endpoint and camelCases the status", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /edit/image/v1/status/a%2Fb": [json({ job_id: "a/b", status: "processing", progress: 70, queue_position: 2 })],
    });
    const s = await makeClient(fetchImpl).jobs.get("edit/image/v1/", "a/b");
    expect(s.progress).toBe(70);
    expect(s.queuePosition).toBe(2);
    expect(s.endpoint).toBe("/edit/image/v1");
    expect(calls[0]!.url).toBe(`${BASE}/edit/image/v1/status/a%2Fb`);
  });

  it("uploads paths, Buffers, Blobs and { file } params as multipart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-"));
    const path = join(dir, "p.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e]));
    const { fetchImpl, calls } = mockFetch({
      "POST /upload/image/v1": [json({ url: "https://cdn/u.png", filename: "p.png", content_type: "image/png", size_bytes: 3 })],
    });
    const client = makeClient(fetchImpl);

    const r = await client.upload.image(path);
    expect(r.url).toBe("https://cdn/u.png");
    expect(r.sizeBytes).toBe(3);
    expect(r.contentType).toBe("image/png");
    let f = (calls.at(-1)!.raw as FormData).get("file") as File;
    expect(f.name).toBe("p.png");
    expect(f.type).toBe("image/png");
    expect(f.size).toBe(3);
    expect(calls.at(-1)!.headers["Content-Type"]).toBeUndefined();

    await client.upload(Buffer.from("abc"), { filename: "x.jpg" });
    f = (calls.at(-1)!.raw as FormData).get("file") as File;
    expect([f.name, f.type]).toEqual(["x.jpg", "image/jpeg"]);

    await client.upload.image({ file: new Blob(["abc"], { type: "image/webp" }), filename: "y.webp" });
    f = (calls.at(-1)!.raw as FormData).get("file") as File;
    expect([f.name, f.type]).toEqual(["y.webp", "image/webp"]);

    await client.upload.image(new Uint8Array([1, 2]).buffer);
    expect(calls).toHaveLength(4);
  });

  it("upload of a missing path throws a clear error", async () => {
    const { fetchImpl } = mockFetch({});
    await expect(makeClient(fetchImpl).upload.image("does-not-exist.png")).rejects.toThrow(/cannot read file/);
  });

  it("profiles CRUD", async () => {
    const prof = {
      profile_id: "p 1",
      name: "Anna",
      adapter_snapshot: { seed_strategy: "random", extra_params: { keep_case: 1 } },
      created_at: "t",
      updated_at: "t",
    };
    const { fetchImpl, calls } = mockFetch({
      "POST /profiles/v1": [json(prof)],
      "GET /profiles/v1": [json({ profiles: [prof], total: 1 })],
      "GET /profiles/v1/p%201": [json(prof)],
      "PATCH /profiles/v1/p%201": [json({ ...prof, name: "B" })],
      "DELETE /profiles/v1/p%201": [new Response(null, { status: 204 })],
    });
    const client = makeClient(fetchImpl);
    const created = await client.identity.createProfile({ name: "Anna", promptTemplateMode: "prefix" });
    expect(created.profileId).toBe("p 1");
    expect(created.adapterSnapshot.seedStrategy).toBe("random");
    expect(created.adapterSnapshot.extraParams).toEqual({ keep_case: 1 });
    expect(calls[0]!.body).toEqual({ name: "Anna", prompt_template_mode: "prefix" });
    expect((await client.identity.listProfiles()).profiles[0]!.name).toBe("Anna");
    expect((await client.identity.getProfile("p 1")).name).toBe("Anna");
    expect((await client.identity.updateProfile("p 1", { name: "B" })).name).toBe("B");
    await expect(client.identity.deleteProfile("p 1")).resolves.toBeUndefined();
  });
});
