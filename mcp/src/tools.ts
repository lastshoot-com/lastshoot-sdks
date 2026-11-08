import { JobTimeoutError, LastShootError, type Job, type JobResult, type JobStatus, type LastShoot } from "@lastshoot/sdk";
import { z } from "zod";

/** The slice of the LastShoot client the tools use (lets tests pass a fake). */
export type Client = Pick<LastShoot, "upload" | "edit" | "identity" | "background" | "upscale" | "generate" | "jobs">;

export interface ToolContext {
  /** Report progress (0-100). No-op when the caller did not ask for progress. */
  progress(progress: number, message?: string): Promise<void>;
  signal?: AbortSignal;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Same default as the LastShoot dashboard's "Product to model" mode. */
export const PRODUCT_TO_MODEL_PROMPT =
  "a professional fashion model wearing this product, clean studio portrait, soft light";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 300;

// ------------------------------------------------------------------ shared schema bits

const imageInput = (what: string) =>
  z
    .string()
    .min(1)
    .describe(`${what}. A public http(s) URL, or a local file path (uploaded to LastShoot automatically).`);
const outputFormat = z.enum(["webp", "jpeg", "png"]).optional().describe("Output format. Server default if omitted.");
const seed = z.number().int().optional().describe("Seed for reproducibility. -1 or omitted = random.");
const waitArgs = {
  wait: z
    .boolean()
    .optional()
    .describe("Wait for the result (default true). false returns a job_id to check with get_job / wait_for_job."),
  timeout_seconds: z
    .number()
    .positive()
    .max(3600)
    .optional()
    .describe(`Max seconds to wait (default ${DEFAULT_WAIT_SECONDS}). On timeout the job keeps running; use wait_for_job.`),
};

// ------------------------------------------------------------------ helpers

const isUrl = (s: string) => /^https?:\/\//i.test(s);

function text(t: string, structured?: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError } : {}) };
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof JobTimeoutError) {
    return text(
      `Still running after ${Math.round(err.timeout / 1000)}s. job_id=${err.jobId}` +
        (err.lastStatus ? ` endpoint=${err.lastStatus.endpoint} progress=${err.lastStatus.progress ?? 0}%` : "") +
        ". Call wait_for_job with this job_id and endpoint to keep waiting.",
      {
        job_id: err.jobId,
        endpoint: err.lastStatus?.endpoint ?? null,
        status: err.lastStatus?.status ?? "processing",
        progress: err.lastStatus?.progress ?? null,
      },
      true,
    );
  }
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text(msg, undefined, true);
}

async function uploadFromUrl(client: Client, url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new LastShootError(`Could not download ${url}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_UPLOAD_BYTES) throw new LastShootError(`${url} is larger than 20 MB`);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "image");
  const type = res.headers.get("content-type")?.split(";")[0]?.trim();
  const up = await client.upload.image(buf, {
    filename: name,
    ...(type && type.startsWith("image/") ? { contentType: type } : {}),
  });
  return up.url;
}

/** URLs pass through; local paths are uploaded and replaced by the hosted URL. */
async function resolveImage(client: Client, src: string): Promise<string> {
  if (isUrl(src)) return src;
  const up = await client.upload.image(src.replace(/^file:\/\//i, ""));
  return up.url;
}

function statusLine(s: JobStatus): string {
  const p = s.progress ?? null;
  return `${s.status}${p !== null ? ` ${p}%` : ""}${s.queuePosition ? ` (queue position ${s.queuePosition})` : ""}`;
}

function summarizeResult(label: string, r: JobResult): ToolResult {
  const bits = [
    `${label} done.`,
    `result_url: ${r.url}`,
    r.mimeType ? `type: ${r.mimeType}` : null,
    typeof r.costUsd === "number" ? `cost: $${r.costUsd.toFixed(4)}` : null,
    `job_id: ${r.jobId}`,
    "The URL expires within 24 hours; download it if you need to keep it.",
  ].filter(Boolean);
  if (r.warnings?.length) bits.push(`warnings: ${r.warnings.join("; ")}`);
  return text(bits.join("\n"), {
    job_id: r.jobId,
    endpoint: r.endpoint,
    status: r.status,
    result_url: r.url,
    mime_type: r.mimeType,
    cost_usd: r.costUsd ?? null,
    warnings: r.warnings ?? [],
  });
}

/** Wait for a job, forwarding progress as MCP progress notifications. */
async function waitWithProgress(job: Job, args: Record<string, unknown>, ctx: ToolContext): Promise<JobResult> {
  const timeoutSec = (args.timeout_seconds as number | undefined) ?? DEFAULT_WAIT_SECONDS;
  return job.wait({
    timeout: timeoutSec * 1000,
    signal: ctx.signal,
    onProgress: (s) => ctx.progress(s.progress ?? 0, statusLine(s)),
  });
}

/** Submit -> (optionally) wait -> summarise. */
async function runJob(
  label: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  submit: () => Promise<Job>,
): Promise<ToolResult> {
  try {
    const job = await submit();
    if (args.wait === false) {
      return text(
        `${label} submitted. job_id: ${job.jobId}, endpoint: ${job.endpoint}, status: ${job.status}` +
          (job.estimatedTimeSeconds ? `, estimated ${job.estimatedTimeSeconds}s` : "") +
          ". Use wait_for_job or get_job with this job_id and endpoint.",
        { job_id: job.jobId, endpoint: job.endpoint, status: job.status, estimated_time_seconds: job.estimatedTimeSeconds },
      );
    }
    await ctx.progress(0, `${label}: ${job.status}`);
    const result = await waitWithProgress(job, args, ctx);
    return summarizeResult(label, result);
  } catch (err) {
    return errorResult(err);
  }
}

const endpointArg = z
  .string()
  .min(1)
  .describe("The submit endpoint the job came from, e.g. /edit/image/v1 (returned by every tool).");

// ------------------------------------------------------------------ tools

export function createTools(client: Client): ToolDef[] {
  return [
    {
      name: "upload_image",
      title: "Upload image",
      description:
        "Upload a local image file or copy an image from a URL to LastShoot hosting. Returns a public URL to pass to the other tools. PNG, JPEG, WebP or GIF, max 20 MB.",
      inputSchema: {
        source: z.string().min(1).describe("Local file path, or an http(s) URL to copy."),
      },
      annotations: { openWorldHint: true },
      async handler(args, ctx) {
        try {
          const src = String(args.source);
          const url = isUrl(src) ? await uploadFromUrl(client, src, ctx.signal) : await resolveImage(client, src);
          return text(`Uploaded. url: ${url}`, { url });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "product_to_model",
      title: "Product to model",
      description:
        "Turn a product photo (jewellery, clothing, bags, eyewear...) into an on-model photo: an AI model wearing or holding the product. Uses POST /edit/image/v1.",
      inputSchema: {
        product_image: imageInput("Product photo"),
        prompt: z
          .string()
          .optional()
          .describe(`Describe the model and scene. Default: "${PRODUCT_TO_MODEL_PROMPT}".`),
        output_format: outputFormat,
        seed,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Product to model", args, ctx, async () =>
          client.edit.image({
            inputImage: await resolveImage(client, String(args.product_image)),
            prompt: (args.prompt as string | undefined) || PRODUCT_TO_MODEL_PROMPT,
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            seed: args.seed as number | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "try_on",
      title: "Virtual try-on",
      description: "Dress a person/model photo in a garment from another photo. Uses POST /creator/tryon/image/v1.",
      inputSchema: {
        person_image: imageInput("Photo of the person/model to dress"),
        clothing_image: imageInput("Photo of the garment"),
        gender: z.enum(["man", "woman"]).describe("Gender of the person."),
        clothing_type: z.string().min(1).describe("Garment type, e.g. jacket, dress, blazer, jeans, shirt, skirt."),
        garment_region: z
          .enum(["upper", "lower", "full"])
          .optional()
          .describe("upper (default): tops/jackets; lower: pants/skirts; full: dresses/jumpsuits/suits."),
        output_format: outputFormat,
        seed,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Try-on", args, ctx, async () =>
          client.identity.tryon({
            personImage: await resolveImage(client, String(args.person_image)),
            clothingImage: await resolveImage(client, String(args.clothing_image)),
            gender: args.gender as "man" | "woman",
            clothingType: String(args.clothing_type),
            garmentRegion: args.garment_region as "upper" | "lower" | "full" | undefined,
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            seed: args.seed as number | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "change_background",
      title: "Change background",
      description:
        "Replace the background behind a product or person while keeping the subject intact. Uses POST /background/change/image/v1.",
      inputSchema: {
        input_image: imageInput("Image whose background to replace"),
        prompt: z.string().min(1).describe("The new background, e.g. 'white marble table, soft daylight'."),
        subject_description: z
          .string()
          .min(1)
          .describe("Short description of the subject to preserve, e.g. 'glass perfume bottle', 'sneakers'."),
        output_format: outputFormat,
        seed,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Background change", args, ctx, async () =>
          client.background.change({
            inputImage: await resolveImage(client, String(args.input_image)),
            prompt: String(args.prompt),
            subjectDescription: String(args.subject_description),
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            seed: args.seed as number | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "remove_background",
      title: "Remove background",
      description:
        "Cut out the subject (transparent PNG by default), optionally on a solid colour with a drop shadow. Uses POST /background/remove/image/v1.",
      inputSchema: {
        input_image: imageInput("Image to cut out"),
        recolor: z.string().optional().describe("Hex background colour, e.g. #FFFFFF. Omit for transparency."),
        drop_shadow: z.boolean().optional().describe("Add a soft drop shadow under the subject."),
        output_format: outputFormat,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Background removal", args, ctx, async () =>
          client.background.remove({
            inputImage: await resolveImage(client, String(args.input_image)),
            recolor: args.recolor as string | undefined,
            dropShadow: args.drop_shadow as boolean | undefined,
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "edit_image",
      title: "Edit image",
      description:
        "Edit an image with a text instruction (recolour, restyle, fix details, combine references). Uses POST /edit/image/v1.",
      inputSchema: {
        input_image: z
          .union([imageInput("Image to edit"), z.array(imageInput("Reference image")).min(1).max(4)])
          .describe("One image, or a list of reference images (URLs or local paths)."),
        prompt: z.string().min(1).describe("The edit instruction, e.g. 'make the dress emerald green, keep everything else'."),
        output_format: outputFormat,
        seed,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Edit", args, ctx, async () => {
          const input = args.input_image;
          const inputImage = Array.isArray(input)
            ? await Promise.all(input.map((s) => resolveImage(client, String(s))))
            : await resolveImage(client, String(input));
          return client.edit.image({
            inputImage,
            prompt: String(args.prompt),
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            seed: args.seed as number | undefined,
            wait: false,
          });
        }),
    },
    {
      name: "upscale_image",
      title: "Upscale image",
      description: "Upscale and enhance an image (1x enhance only, 2x, 3x or 4x). Uses POST /upscale/image/v1.",
      inputSchema: {
        input_image: imageInput("Image to upscale"),
        scale: z.number().int().min(1).max(4).optional().describe("1 (enhance only), 2, 3 or 4. Default 4."),
        output_format: outputFormat,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Upscale", args, ctx, async () =>
          client.upscale.image({
            inputImage: await resolveImage(client, String(args.input_image)),
            scale: args.scale as number | undefined,
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "generate_image",
      title: "Generate image",
      description: "Generate an image from a text prompt (max 1024x1024). Uses POST /generate/image/v1.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to generate."),
        width: z.number().int().min(64).max(1024).optional().describe("Width in px (max 1024, default 1024)."),
        height: z.number().int().min(64).max(1024).optional().describe("Height in px (max 1024, default 1024)."),
        enhance_prompt: z.boolean().optional().describe("Expand a short prompt with an AI enhancer first."),
        output_format: outputFormat,
        seed,
        ...waitArgs,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        runJob("Image generation", args, ctx, () =>
          client.generate.image({
            prompt: String(args.prompt),
            width: args.width as number | undefined,
            height: args.height as number | undefined,
            enhancePrompt: args.enhance_prompt as boolean | undefined,
            outputFormat: args.output_format as "webp" | "jpeg" | "png" | undefined,
            seed: args.seed as number | undefined,
            wait: false,
          }),
        ),
    },
    {
      name: "get_job",
      title: "Get job status",
      description: "Check a LastShoot job once: status, progress (0-100) and result_url when completed.",
      inputSchema: { endpoint: endpointArg, job_id: z.string().min(1).describe("The job_id to check.") },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args) {
        try {
          const s = await client.jobs.get(String(args.endpoint), String(args.job_id));
          const lines = [`job_id: ${s.jobId}`, `status: ${statusLine(s)}`];
          if (s.url) lines.push(`result_url: ${s.url}`);
          if (s.error) lines.push(`error: ${typeof s.error === "string" ? s.error : JSON.stringify(s.error)}`);
          if (s.failureReasonCode) lines.push(`failure_reason_code: ${s.failureReasonCode}`);
          return text(lines.join("\n"), {
            job_id: s.jobId,
            endpoint: s.endpoint,
            status: s.status,
            progress: s.progress ?? null,
            result_url: s.url,
            mime_type: s.mimeType,
            error: s.error ?? null,
            failure_reason_code: s.failureReasonCode ?? null,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "wait_for_job",
      title: "Wait for job",
      description: "Wait for a LastShoot job to finish (with progress updates) and return its result_url.",
      inputSchema: {
        endpoint: endpointArg,
        job_id: z.string().min(1).describe("The job_id to wait for."),
        timeout_seconds: waitArgs.timeout_seconds,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        try {
          const timeoutSec = (args.timeout_seconds as number | undefined) ?? DEFAULT_WAIT_SECONDS;
          const r = await client.jobs.wait(String(args.endpoint), String(args.job_id), {
            timeout: timeoutSec * 1000,
            signal: ctx.signal,
            onProgress: (s) => ctx.progress(s.progress ?? 0, statusLine(s)),
          });
          return summarizeResult("Job", r);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];
}
