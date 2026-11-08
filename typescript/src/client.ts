import {
  Job,
  type JobResult,
  type JobStatus,
  type Runner,
  type RunOptions,
  type WaitOptions,
  camelize,
  toBody,
  toJobStatus,
} from "./core.js";
import {
  APIConnectionError,
  APITimeoutError,
  JobFailedError,
  JobTimeoutError,
  LastShootError,
  makeAPIError,
} from "./errors.js";
import {
  BackgroundResource,
  BrandingResource,
  EditResource,
  GenerateResource,
  IdentityResource,
  UpscaleResource,
} from "./generated.js";
import { type UploadResource, createUploadResource } from "./upload.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.lastshoot.com";

export interface ClientOptions {
  /** API key. Default: `process.env.LASTSHOOT_API_KEY`. */
  apiKey?: string;
  /** Default: `https://api.lastshoot.com` (or `LASTSHOOT_BASE_URL`). */
  baseUrl?: string;
  /** Per-request HTTP timeout in milliseconds. Default 60000. */
  timeout?: number;
  /** Retries for GET requests on 429, 5xx and network errors. Default 2. POSTs are never retried. */
  maxRetries?: number;
  /** Default milliseconds between status polls while waiting. Default 2000. */
  pollInterval?: number;
  /** Default max milliseconds to wait for a job. Default 600000 (10 min). */
  waitTimeout?: number;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch implementation (tests, proxies). Default: global `fetch`. */
  fetch?: typeof fetch;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name];
}

function backoff(attempt: number, retryAfterSec: number | null): number {
  if (retryAfterSec !== null && retryAfterSec >= 0) return Math.min(retryAfterSec, 30) * 1000;
  return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new LastShootError("Aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new LastShootError("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function decode(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * LastShoot API client.
 *
 * ```ts
 * import { LastShoot } from "@lastshoot/sdk";
 * const client = new LastShoot("ls_live_...");            // or new LastShoot() with LASTSHOOT_API_KEY
 * const result = await client.generate.image({ prompt: "fashion model, white studio" });
 * console.log(result.url);
 * ```
 */
export class LastShoot implements Runner {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly pollInterval: number;
  readonly waitTimeout: number;

  readonly generate: GenerateResource;
  readonly edit: EditResource;
  readonly background: BackgroundResource;
  readonly upscale: UpscaleResource;
  readonly branding: BrandingResource;
  readonly identity: IdentityResource;
  readonly upload: UploadResource;
  readonly jobs: {
    /** Fetch a job's status. `endpoint` is the submit path, e.g. `/edit/image/v1`. */
    get(endpoint: string, jobId: string): Promise<JobStatus>;
    /** Poll a job until it completes. */
    wait(endpoint: string, jobId: string, options?: WaitOptions): Promise<JobResult>;
  };

  /** @internal Overridable in tests. */
  _sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep;
  /** @internal Overridable in tests. */
  _now: () => number = () => Date.now();

  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(apiKeyOrOptions?: string | ClientOptions, maybeOptions: ClientOptions = {}) {
    const opts: ClientOptions =
      typeof apiKeyOrOptions === "string"
        ? { ...maybeOptions, apiKey: apiKeyOrOptions }
        : { ...(apiKeyOrOptions ?? {}) };
    const apiKey = opts.apiKey || env("LASTSHOOT_API_KEY");
    if (!apiKey) {
      throw new LastShootError(
        "No API key. Pass new LastShoot({ apiKey }) or set LASTSHOOT_API_KEY. Get one at https://www.lastshoot.com/dashboard",
      );
    }
    const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new LastShootError("No global fetch found. Use Node.js 18+ or pass { fetch }.");
    this.#apiKey = apiKey;
    this.#fetch = f;
    this.baseUrl = (opts.baseUrl || env("LASTSHOOT_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.pollInterval = opts.pollInterval ?? 2_000;
    this.waitTimeout = opts.waitTimeout ?? 600_000;
    this.#headers = {
      "X-API-Key": apiKey,
      Accept: "application/json",
      "User-Agent": `lastshoot-typescript/${VERSION}`,
      ...(opts.defaultHeaders ?? {}),
    };

    this.generate = new GenerateResource(this);
    this.edit = new EditResource(this);
    this.background = new BackgroundResource(this);
    this.upscale = new UpscaleResource(this);
    this.branding = new BrandingResource(this);
    this.identity = new IdentityResource(this);
    this.upload = createUploadResource((form) => this.request("POST", "/upload/image/v1", { form }));
    this.jobs = {
      get: (endpoint, jobId) => this.getJob(endpoint, jobId),
      wait: (endpoint, jobId, options) => this.waitForJob(endpoint, jobId, options),
    };
  }

  /** The API key in use, masked. */
  get apiKeyHint(): string {
    return this.#apiKey.length > 8 ? `${this.#apiKey.slice(0, 8)}...` : "***";
  }

  /** @internal Low-level request. Returns the decoded JSON body. */
  async request(
    method: string,
    path: string,
    init: { json?: Record<string, unknown>; form?: FormData; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const retries = method === "GET" ? this.maxRetries : 0;
    const headers: Record<string, string> = { ...this.#headers };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form; // fetch sets the multipart boundary
    }

    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new APITimeoutError(`${method} ${path} timed out`)), this.timeout);
      const onOuterAbort = () => ctrl.abort(init.signal?.reason);
      init.signal?.addEventListener("abort", onOuterAbort, { once: true });
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, signal: ctrl.signal });
      } catch (err) {
        if (init.signal?.aborted) throw init.signal.reason ?? err;
        if (attempt < retries) {
          await this._sleep(backoff(attempt, null));
          continue;
        }
        if (ctrl.signal.aborted && ctrl.signal.reason instanceof APITimeoutError) throw ctrl.signal.reason;
        throw new APIConnectionError(`${method} ${path} failed: ${(err as Error)?.message ?? err}`, { cause: err });
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onOuterAbort);
      }
      if (RETRY_STATUSES.has(res.status) && attempt < retries) {
        const ra = res.headers.get("retry-after");
        await res.arrayBuffer().catch(() => undefined); // drain so the connection can be reused
        await this._sleep(backoff(attempt, ra && !Number.isNaN(Number(ra)) ? Number(ra) : null));
        continue;
      }
      const data = await decode(res);
      if (!res.ok) throw makeAPIError(res.status, data, res.headers);
      return data;
    }
  }

  /** @internal JSON call with camelCase params -> snake_case body and camelCase response. */
  async json(method: string, path: string, params?: object, keys: Record<string, string> = {}): Promise<unknown> {
    const data = await this.request(method, path, params ? { json: toBody(params, keys) } : {});
    return camelize(data);
  }

  /** @internal Submit a job and (by default) wait for it. */
  async run(path: string, params: object, keys: Record<string, string>): Promise<JobResult | Job> {
    const data = (await this.request("POST", path, { json: toBody(params, keys) })) as Record<string, unknown> | null;
    if (!data || !data.job_id) {
      throw new LastShootError(`POST ${path} returned no job_id: ${JSON.stringify(data)}`);
    }
    const job = new Job(this, path, data);
    const opts = params as RunOptions;
    if (opts.wait === false) return job;
    return job.wait({
      pollInterval: opts.pollInterval,
      timeout: opts.timeout,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
  }

  /** @internal */
  async getJob(endpoint: string, jobId: string, signal?: AbortSignal): Promise<JobStatus> {
    const ep = "/" + endpoint.replace(/^\/+|\/+$/g, "");
    const data = (await this.request("GET", `${ep}/status/${encodeURIComponent(jobId)}`, { signal })) as Record<
      string,
      unknown
    > | null;
    return toJobStatus(data ?? {}, ep, jobId);
  }

  /** @internal */
  async waitForJob(endpoint: string, jobId: string, options: WaitOptions = {}): Promise<JobResult> {
    const interval = options.pollInterval ?? this.pollInterval;
    const limit = options.timeout ?? this.waitTimeout;
    const deadline = this._now() + limit;
    for (;;) {
      const st = await this.getJob(endpoint, jobId, options.signal);
      if (options.onProgress) await options.onProgress(st);
      if (st.status === "completed") return st as JobResult;
      if (st.status === "failed" || st.status === "cancelled") throw new JobFailedError(st);
      if (this._now() + interval > deadline) throw new JobTimeoutError(jobId, limit, st);
      await this._sleep(interval, options.signal);
    }
  }
}
