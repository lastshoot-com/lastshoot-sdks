import type { JobStatusData } from "./generated.js";

/** Every status a job can report. `completed`, `failed` and `cancelled` are final. */
export type JobState = "queued" | "pending" | "processing" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** A snapshot from `GET <endpoint>/status/{job_id}`, in camelCase. */
export interface JobStatus extends Omit<JobStatusData, "jobId" | "status" | "endpoint"> {
  jobId: string;
  status: JobState | (string & {});
  endpoint: string;
  /** Alias for `resultUrl`. Temporary: expires within 24 hours, download it promptly. */
  url: string | null;
  /** Alias for `resultMimeType`. */
  mimeType: string | null;
  /** The response exactly as the API returned it (snake_case). */
  raw: Record<string, unknown>;
}

/** A completed job. `result.url` is the output file (expires within 24 hours). */
export interface JobResult extends JobStatus {
  status: "completed";
  url: string;
}

export type ProgressCallback = (status: JobStatus) => void | Promise<void>;

export interface WaitOptions {
  /** Milliseconds between status polls. Default: client `pollInterval` (2000). */
  pollInterval?: number;
  /** Max milliseconds to wait before throwing `JobTimeoutError`. Default: client `waitTimeout` (600000). */
  timeout?: number;
  /** Called with every polled status (progress 0-100). */
  onProgress?: ProgressCallback;
  /** Abort waiting (the job itself keeps running server-side). */
  signal?: AbortSignal;
}

export interface RunOptions extends WaitOptions {
  /** Block until the job finishes (default `true`). `false` returns a `Job` right after submit. */
  wait?: boolean;
}

/** What generated resources need from the client. */
export interface Runner {
  run(path: string, params: object, keys: Record<string, string>): Promise<JobResult | Job>;
  json(method: string, path: string, params?: object, keys?: Record<string, string>): Promise<unknown>;
  getJob(endpoint: string, jobId: string): Promise<JobStatus>;
  waitForJob(endpoint: string, jobId: string, options?: WaitOptions): Promise<JobResult>;
}

/** A submitted job. `await job.wait()` for the result, `await job.refresh()` for the latest status. */
export class Job {
  readonly jobId: string;
  readonly endpoint: string;
  status: string;
  readonly estimatedTimeSeconds: number | null;
  readonly estimatedCostUsd: number | null;
  readonly queuedAt: string | null;
  readonly raw: Record<string, unknown>;
  readonly #runner: Runner;

  constructor(runner: Runner, endpoint: string, raw: Record<string, unknown>) {
    this.#runner = runner;
    this.endpoint = endpoint;
    this.raw = raw;
    this.jobId = String(raw.job_id);
    this.status = typeof raw.status === "string" ? raw.status : "queued";
    this.estimatedTimeSeconds = (raw.estimated_time_seconds as number | undefined) ?? null;
    this.estimatedCostUsd = (raw.estimated_cost_usd as number | undefined) ?? null;
    this.queuedAt = (raw.queued_at as string | undefined) ?? null;
  }

  /** Fetch the latest status once. */
  async refresh(): Promise<JobStatus> {
    const st = await this.#runner.getJob(this.endpoint, this.jobId);
    this.status = st.status;
    return st;
  }

  /** Poll until completed. Throws `JobFailedError` (failed/cancelled) or `JobTimeoutError`. */
  async wait(options: WaitOptions = {}): Promise<JobResult> {
    const res = await this.#runner.waitForJob(this.endpoint, this.jobId, options);
    this.status = res.status;
    return res;
  }

  toJSON(): Record<string, unknown> {
    return {
      jobId: this.jobId,
      endpoint: this.endpoint,
      status: this.status,
      estimatedTimeSeconds: this.estimatedTimeSeconds,
      estimatedCostUsd: this.estimatedCostUsd,
      queuedAt: this.queuedAt,
    };
  }
}

const SKIP_DEEP = new Set(["extra_params", "input"]);

export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Convert response keys to camelCase (user-supplied maps like `extra_params` are left alone). */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[camelKey(k)] = SKIP_DEEP.has(k) ? v : camelize(v);
    return out;
  }
  return value;
}

const RUN_OPTION_KEYS = new Set(["wait", "pollInterval", "timeout", "onProgress", "signal"]);

/** Map camelCase params to the API's snake_case body. Unknown keys pass through; undefined/null are dropped. */
export function toBody(params: object, keys: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (RUN_OPTION_KEYS.has(k) || v === undefined || v === null) continue;
    body[keys[k] ?? k] = v;
  }
  return body;
}

export function toJobStatus(data: Record<string, unknown>, endpoint: string, jobId: string): JobStatus {
  const c = camelize(data) as Record<string, unknown>;
  return {
    ...c,
    jobId: (c.jobId as string | undefined) ?? jobId,
    status: (c.status as string | undefined) ?? "unknown",
    endpoint: (c.endpoint as string | undefined) ?? endpoint,
    url: (c.resultUrl as string | undefined) ?? null,
    mimeType: (c.resultMimeType as string | undefined) ?? null,
    raw: data,
  } as JobStatus;
}
