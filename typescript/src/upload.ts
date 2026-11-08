import { camelize } from "./core.js";
import { LastShootError } from "./errors.js";
import type { UploadData } from "./generated.js";

/** A local file path (Node), a Blob/File, or raw bytes (Buffer, Uint8Array, ArrayBuffer). */
export type FileInput = string | Blob | ArrayBuffer | ArrayBufferView;

export interface UploadOptions {
  /** Filename sent to the API. Default: the path's basename, `File.name`, or `image`. */
  filename?: string;
  /** MIME type. Default: guessed from the filename. */
  contentType?: string;
}

export interface UploadParams extends UploadOptions {
  file: FileInput;
}

export interface UploadResult extends UploadData {
  raw: Record<string, unknown>;
}

/** `client.upload.image(file)`; `client.upload(file)` is the same call. */
export type UploadResource = ((input: FileInput | UploadParams, options?: UploadOptions) => Promise<UploadResult>) & {
  /** Upload an image (PNG, JPEG, WebP, GIF; max 20 MB). Returns a hosted `url`. `POST /upload/image/v1` */
  image(input: FileInput | UploadParams, options?: UploadOptions): Promise<UploadResult>;
};

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
};

export function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function isUploadParams(x: unknown): x is UploadParams {
  return !!x && typeof x === "object" && "file" in x && !(x instanceof Blob) && !ArrayBuffer.isView(x);
}

/** Turn any FileInput into a Blob + filename. Paths are read with node:fs (Node only). */
export async function toBlob(input: FileInput, opts: UploadOptions = {}): Promise<{ blob: Blob; filename: string }> {
  if (typeof input === "string") {
    let bytes: Uint8Array;
    try {
      const fs = await import("node:fs/promises");
      bytes = await fs.readFile(input);
    } catch (err) {
      throw new LastShootError(`upload: cannot read file ${input}: ${(err as Error).message}`, { cause: err });
    }
    const filename = opts.filename ?? input.split(/[\\/]/).pop() ?? "image";
    const type = opts.contentType ?? guessMime(filename);
    return { blob: new Blob([bytes as BlobPart], { type }), filename };
  }
  if (input instanceof Blob) {
    const named = (input as Blob & { name?: string }).name;
    const filename = opts.filename ?? (named || "image");
    const type = opts.contentType ?? (input.type || guessMime(filename));
    const blob = input.type === type ? input : new Blob([input], { type });
    return { blob, filename };
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const view =
      input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const filename = opts.filename ?? "image";
    const type = opts.contentType ?? guessMime(filename);
    return { blob: new Blob([view as BlobPart], { type }), filename };
  }
  throw new LastShootError(`upload: unsupported file input (${typeof input})`);
}

export function createUploadResource(post: (form: FormData) => Promise<unknown>): UploadResource {
  const image = async (input: FileInput | UploadParams, options: UploadOptions = {}): Promise<UploadResult> => {
    const { file, ...rest } = isUploadParams(input) ? input : { file: input };
    const { blob, filename } = await toBlob(file, { ...rest, ...options });
    const form = new FormData();
    form.append("file", blob, filename);
    const data = (await post(form)) as Record<string, unknown>;
    if (!data || typeof data.url !== "string") {
      throw new LastShootError(`upload: response had no url: ${JSON.stringify(data)}`);
    }
    return { ...(camelize(data) as UploadData), raw: data };
  };
  return Object.assign((input: FileInput | UploadParams, options?: UploadOptions) => image(input, options), { image });
}
