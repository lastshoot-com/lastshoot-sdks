import type { JobStatus } from "./core.js";

/** Base class for every error thrown by the LastShoot SDK. */
export class LastShootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface APIErrorInit {
  status: number;
  body?: unknown;
  code?: string | null;
  requestId?: string | null;
}

/** The API answered with a non-2xx status. */
export class APIError extends LastShootError {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(message: string, init: APIErrorInit) {
    super(`${init.status}${init.code ? ` [${init.code}]` : ""}: ${message}`);
    this.status = init.status;
    this.body = init.body;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
  }
}

/** 400 or 422: the request failed validation. */
export class InvalidRequestError extends APIError {}
/** 401: missing or invalid API key. */
export class AuthenticationError extends APIError {}
/** 402: not enough balance to run this job. */
export class InsufficientCreditsError extends APIError {}
/** 403: the key is valid but not allowed to do this. */
export class PermissionDeniedError extends APIError {}
/** 404: the job, profile or path does not exist. */
export class NotFoundError extends APIError {}
/** 5xx from the API. */
export class InternalServerError extends APIError {}

/** 429: too many requests or too many concurrent jobs. */
export class RateLimitError extends APIError {
  readonly retryAfter: number | null;
  constructor(message: string, init: APIErrorInit & { retryAfter?: number | null }) {
    super(message, init);
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** The request never got an HTTP response (DNS, TLS, connection reset...). */
export class APIConnectionError extends LastShootError {}
/** The HTTP request timed out. */
export class APITimeoutError extends APIConnectionError {}

/** The job finished with status `failed` or `cancelled`. */
export class JobFailedError extends LastShootError {
  readonly jobId: string;
  readonly jobStatus: JobStatus;
  readonly failureReasonCode: string | null;
  readonly retryable: boolean | null;
  readonly error: unknown;

  constructor(status: JobStatus) {
    const reason = status.failureReasonCode ? ` [${status.failureReasonCode}]` : "";
    const detail = typeof status.error === "string" && status.error ? status.error : status.status;
    super(`Job ${status.jobId} ${status.status}${reason}: ${detail}`);
    this.jobId = status.jobId;
    this.jobStatus = status;
    this.failureReasonCode = status.failureReasonCode ?? null;
    this.retryable = status.retryable ?? null;
    this.error = status.error ?? null;
  }
}

/** `wait()` gave up before the job reached a final status. The job keeps running server-side. */
export class JobTimeoutError extends LastShootError {
  readonly jobId: string;
  readonly timeout: number;
  readonly lastStatus: JobStatus | null;

  constructor(jobId: string, timeout: number, lastStatus: JobStatus | null) {
    super(`Job ${jobId} did not finish within ${timeout}ms`);
    this.jobId = jobId;
    this.timeout = timeout;
    this.lastStatus = lastStatus;
  }
}

function parseBody(body: unknown, fallback: string): { message: string; code: string | null } {
  const detail =
    body && typeof body === "object" && !Array.isArray(body) && "detail" in body
      ? (body as { detail: unknown }).detail
      : body;
  if (typeof detail === "string" && detail) return { message: detail, code: null };
  if (Array.isArray(detail)) {
    const parts = detail.map((item) => {
      if (item && typeof item === "object") {
        const it = item as { loc?: unknown[]; msg?: unknown };
        const loc = (it.loc ?? []).filter((x) => x !== "body").join(".");
        return loc ? `${loc}: ${String(it.msg)}` : String(it.msg);
      }
      return String(item);
    });
    return { message: parts.join("; ") || fallback, code: null };
  }
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    const code = d.code ?? d.error_code ?? d.failure_reason_code;
    const msg = d.message ?? d.detail ?? d.error ?? fallback;
    return { message: String(msg), code: code ? String(code) : null };
  }
  return { message: fallback, code: null };
}

export function makeAPIError(status: number, body: unknown, headers?: Headers): APIError {
  const { message, code } = parseBody(body, `HTTP ${status}`);
  const requestId = headers?.get("x-request-id") ?? null;
  const ra = headers?.get("retry-after");
  const retryAfter = ra && !Number.isNaN(Number(ra)) ? Number(ra) : null;
  const init: APIErrorInit = { status, body, code, requestId };
  switch (status) {
    case 400:
    case 422:
      return new InvalidRequestError(message, init);
    case 401:
      return new AuthenticationError(message, init);
    case 402:
      return new InsufficientCreditsError(message, init);
    case 403:
      return new PermissionDeniedError(message, init);
    case 404:
      return new NotFoundError(message, init);
    case 429:
      return new RateLimitError(message, { ...init, retryAfter });
    default:
      return status >= 500 ? new InternalServerError(message, init) : new APIError(message, init);
  }
}
