import { JobFailedError, JobTimeoutError, type JobResult, type JobStatus, type WaitOptions } from "@lastshoot/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PRODUCT_TO_MODEL_PROMPT, createServer, createTools, makeContext, type Client } from "../src/server.js";

const URL_OUT = "https://cdn.lastshoot.com/o/1.webp";

function status(s: Partial<JobStatus>): JobStatus {
  return { jobId: "job_1", status: "processing", endpoint: "/edit/image/v1", url: null, mimeType: null, raw: {}, ...s } as JobStatus;
}
function done(endpoint: string): JobResult {
  return status({ status: "completed", endpoint, url: URL_OUT, mimeType: "image/webp", progress: 100, costUsd: 0.012 }) as JobResult;
}

/** A fake job whose wait() replays progress through onProgress, like the SDK does. */
function fakeJob(endpoint: string, progress: number[] = [20, 60, 100]) {
  return {
    jobId: "job_1",
    endpoint,
    status: "queued",
    estimatedTimeSeconds: 4,
    wait: vi.fn(async (opts: WaitOptions = {}) => {
      for (const p of progress) {
        await opts.onProgress?.(status({ endpoint, progress: p, status: p === 100 ? "completed" : "processing" }));
      }
      return done(endpoint);
    }),
  };
}

function fakeClient() {
  const submit = (endpoint: string) => vi.fn(async (_params: Record<string, unknown>) => fakeJob(endpoint));
  const upload = Object.assign(vi.fn(), {
    image: vi.fn(async (_file: unknown, _opts?: unknown) => ({ url: "https://cdn.lastshoot.com/u/uploaded.png", raw: {} })),
  });
  const client = {
    upload,
    edit: { image: submit("/edit/image/v1") },
    identity: { tryon: submit("/creator/tryon/image/v1") },
    background: { change: submit("/background/change/image/v1"), remove: submit("/background/remove/image/v1") },
    upscale: { image: submit("/upscale/image/v1") },
    generate: { image: submit("/generate/image/v1") },
    jobs: {
      get: vi.fn(async (endpoint: string, jobId: string) => status({ endpoint, jobId, progress: 55, queuePosition: 2 })),
      wait: vi.fn(async (endpoint: string, _jobId: string, opts: WaitOptions = {}) => {
        await opts.onProgress?.(status({ endpoint, progress: 90 }));
        return done(endpoint);
      }),
    },
  };
  return client;
}

const noCtx = { progress: async () => {} };

function tool(client: ReturnType<typeof fakeClient>, name: string) {
  const t = createTools(client as unknown as Client).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool schemas", () => {
  const tools = createTools(fakeClient() as unknown as Client);

  it("exposes exactly the documented tools", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "upload_image",
      "product_to_model",
      "try_on",
      "change_background",
      "remove_background",
      "edit_image",
      "upscale_image",
      "generate_image",
      "get_job",
      "wait_for_job",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.title).toBeTruthy();
      for (const [k, v] of Object.entries(t.inputSchema)) {
        expect(v.description, `${t.name}.${k} needs a description`).toBeTruthy();
      }
    }
  });

  it.each([
    ["try_on", { person_image: "a", clothing_image: "b", gender: "woman", clothing_type: "dress" }, true],
    ["try_on", { person_image: "a", clothing_image: "b", gender: "female", clothing_type: "dress" }, false],
    ["try_on", { person_image: "a", clothing_image: "b", gender: "man" }, false],
    ["change_background", { input_image: "a", prompt: "beach" }, false],
    ["change_background", { input_image: "a", prompt: "beach", subject_description: "bottle" }, true],
    ["upscale_image", { input_image: "a", scale: 5 }, false],
    ["edit_image", { input_image: ["a", "b"], prompt: "p" }, true],
    ["generate_image", { prompt: "p", width: 2048 }, false],
    ["product_to_model", { product_image: "a" }, true],
    ["wait_for_job", { endpoint: "/edit/image/v1", job_id: "j", timeout_seconds: 30 }, true],
    ["get_job", { job_id: "j" }, false],
  ])("%s validates %j -> %s", (name, input, ok) => {
    const t = tools.find((x) => x.name === name)!;
    expect(z.object(t.inputSchema).safeParse(input).success).toBe(ok);
  });
});

describe("handlers", () => {
  it("product_to_model uploads a local path, uses the default prompt, waits with progress", async () => {
    const c = fakeClient();
    const progress: Array<[number, string | undefined]> = [];
    const res = await tool(c, "product_to_model").handler(
      { product_image: "C:/photos/earrings.jpg" },
      { progress: async (p, m) => void progress.push([p, m]) },
    );
    expect(c.upload.image).toHaveBeenCalledWith("C:/photos/earrings.jpg");
    expect(c.edit.image).toHaveBeenCalledWith(
      expect.objectContaining({ inputImage: "https://cdn.lastshoot.com/u/uploaded.png", prompt: PRODUCT_TO_MODEL_PROMPT, wait: false }),
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toContain(`result_url: ${URL_OUT}`);
    expect(res.structuredContent).toMatchObject({ result_url: URL_OUT, job_id: "job_1", endpoint: "/edit/image/v1" });
    expect(progress.map((p) => p[0])).toEqual([0, 20, 60, 100]);
  });

  it("try_on passes URLs through untouched and maps args", async () => {
    const c = fakeClient();
    await tool(c, "try_on").handler(
      { person_image: "https://x/p.jpg", clothing_image: "https://x/c.jpg", gender: "man", clothing_type: "blazer", garment_region: "upper" },
      noCtx,
    );
    expect(c.upload.image).not.toHaveBeenCalled();
    expect(c.identity.tryon).toHaveBeenCalledWith(
      expect.objectContaining({ personImage: "https://x/p.jpg", clothingImage: "https://x/c.jpg", gender: "man", clothingType: "blazer", garmentRegion: "upper" }),
    );
  });

  it.each([
    ["change_background", { input_image: "https://x/a.jpg", prompt: "beach", subject_description: "bottle" }, "background", "change"],
    ["remove_background", { input_image: "https://x/a.jpg", recolor: "#FFFFFF", drop_shadow: true }, "background", "remove"],
    ["upscale_image", { input_image: "https://x/a.jpg", scale: 2 }, "upscale", "image"],
    ["generate_image", { prompt: "red sneaker", width: 768 }, "generate", "image"],
    ["edit_image", { input_image: ["https://x/a.jpg", "local.png"], prompt: "combine" }, "edit", "image"],
  ] as const)("%s submits and returns result_url", async (name, args, ns, method) => {
    const c = fakeClient();
    const res = await tool(c, name).handler({ ...args }, noCtx);
    const fn = (c as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[ns]![method]!;
    expect(fn).toHaveBeenCalledOnce();
    expect(res.structuredContent).toMatchObject({ result_url: URL_OUT });
    if (name === "edit_image") {
      expect(fn.mock.calls[0]![0]).toMatchObject({ inputImage: ["https://x/a.jpg", "https://cdn.lastshoot.com/u/uploaded.png"] });
    }
    if (name === "remove_background") expect(fn.mock.calls[0]![0]).toMatchObject({ recolor: "#FFFFFF", dropShadow: true });
  });

  it("wait=false returns the job id without waiting", async () => {
    const c = fakeClient();
    const res = await tool(c, "generate_image").handler({ prompt: "x", wait: false }, noCtx);
    expect(res.structuredContent).toMatchObject({ job_id: "job_1", endpoint: "/generate/image/v1", status: "queued" });
    expect(res.content[0]!.text).toContain("wait_for_job");
  });

  it("reports job failures as tool errors", async () => {
    const c = fakeClient();
    c.upscale.image.mockResolvedValueOnce({
      ...fakeJob("/upscale/image/v1"),
      wait: vi.fn(async () => {
        throw new JobFailedError(status({ status: "failed", error: "bad input", failureReasonCode: "INPUT_INVALID" }));
      }),
    });
    const res = await tool(c, "upscale_image").handler({ input_image: "https://x/a.jpg" }, noCtx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("INPUT_INVALID");
  });

  it("on timeout tells the model how to resume", async () => {
    const c = fakeClient();
    c.generate.image.mockResolvedValueOnce({
      ...fakeJob("/generate/image/v1"),
      wait: vi.fn(async () => {
        throw new JobTimeoutError("job_1", 5000, status({ endpoint: "/generate/image/v1", progress: 40 }));
      }),
    });
    const res = await tool(c, "generate_image").handler({ prompt: "x", timeout_seconds: 5 }, noCtx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/wait_for_job/);
    expect(res.structuredContent).toMatchObject({ job_id: "job_1", endpoint: "/generate/image/v1", progress: 40 });
  });

  it("get_job and wait_for_job", async () => {
    const c = fakeClient();
    const g = await tool(c, "get_job").handler({ endpoint: "/edit/image/v1", job_id: "abc" }, noCtx);
    expect(c.jobs.get).toHaveBeenCalledWith("/edit/image/v1", "abc");
    expect(g.content[0]!.text).toContain("processing 55% (queue position 2)");
    const seen: number[] = [];
    const w = await tool(c, "wait_for_job").handler(
      { endpoint: "/edit/image/v1", job_id: "abc", timeout_seconds: 10 },
      { progress: async (p) => void seen.push(p) },
    );
    expect(c.jobs.wait.mock.calls[0]![2]).toMatchObject({ timeout: 10_000 });
    expect(w.structuredContent).toMatchObject({ result_url: URL_OUT });
    expect(seen).toEqual([90]);
  });

  it("upload_image copies a URL and uploads a local path", async () => {
    const c = fakeClient();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const r1 = await tool(c, "upload_image").handler({ source: "https://example.com/img/shoe%201.png" }, noCtx);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [bytes, opts] = c.upload.image.mock.calls[0]!;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(opts).toEqual({ filename: "shoe 1.png", contentType: "image/png" });
    expect(r1.structuredContent).toEqual({ url: "https://cdn.lastshoot.com/u/uploaded.png" });

    await tool(c, "upload_image").handler({ source: "./shoe.png" }, noCtx);
    expect(c.upload.image.mock.calls[1]![0]).toBe("./shoe.png");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const r3 = await tool(c, "upload_image").handler({ source: "https://example.com/missing.png" }, noCtx);
    expect(r3.isError).toBe(true);
    expect(r3.content[0]!.text).toContain("HTTP 404");
  });
});

describe("makeContext", () => {
  it("sends monotonic progress only when a progressToken is present", async () => {
    const sent: unknown[] = [];
    const ctx = makeContext({ _meta: { progressToken: "t1" }, sendNotification: async (n) => void sent.push(n) });
    await ctx.progress(0, "queued");
    await ctx.progress(0, "queued");
    await ctx.progress(50.4);
    await ctx.progress(30);
    await ctx.progress(100, "completed");
    expect(sent).toEqual([
      { method: "notifications/progress", params: { progressToken: "t1", progress: 0, total: 100, message: "queued" } },
      { method: "notifications/progress", params: { progressToken: "t1", progress: 50, total: 100 } },
      { method: "notifications/progress", params: { progressToken: "t1", progress: 100, total: 100, message: "completed" } },
    ]);
    const silent = makeContext({ sendNotification: async (n) => void sent.push(n) });
    await silent.progress(10);
    expect(sent).toHaveLength(3);
  });
});

describe("MCP protocol (in-memory transport)", () => {
  async function connect(client: ReturnType<typeof fakeClient>) {
    const server = createServer(client as unknown as Client);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new McpClient({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return mcp;
  }

  it("lists tools with JSON schemas", async () => {
    const mcp = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(10);
    const tryOn = tools.find((t) => t.name === "try_on")!;
    expect(tryOn.inputSchema.required).toEqual(["person_image", "clothing_image", "gender", "clothing_type"]);
    expect((tryOn.inputSchema.properties as Record<string, { enum?: string[] }>).gender!.enum).toEqual(["man", "woman"]);
    expect(tools.find((t) => t.name === "get_job")!.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool end to end and streams progress notifications", async () => {
    const mcp = await connect(fakeClient());
    const progress: number[] = [];
    const res = await mcp.callTool(
      { name: "change_background", arguments: { input_image: "https://x/a.jpg", prompt: "beach", subject_description: "bottle" } },
      undefined,
      { onprogress: (p) => void progress.push(p.progress) },
    );
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain(URL_OUT);
    expect(res.structuredContent).toMatchObject({ result_url: URL_OUT });
    expect(progress).toEqual([0, 20, 60, 100]);
  });

  it("rejects invalid arguments", async () => {
    const mcp = await connect(fakeClient());
    const res = await mcp.callTool({ name: "try_on", arguments: { person_image: "a" } });
    expect(res.isError).toBe(true);
  });
});
