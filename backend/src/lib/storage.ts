import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { env } from "../config/env.js";

/**
 * Object storage, pointed at the same bucket Delta Finance uses.
 *
 * A payment receipt taken when a lead is closed has to end up attached to the
 * invoice an approver is looking at, in another application. Sharing the bucket
 * means one object rather than two: this writes the file, the handover carries
 * the key, and finance records an attachment pointing at the same bytes. The
 * alternative — a bucket here and a copy sent over — gives two files that can
 * disagree and twice the storage for one receipt.
 *
 * Mirrors finance's own lib deliberately, down to the variable names, so the
 * two cannot drift apart in how they name or address a stored file.
 */
function makeClient(): S3Client | null {
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: "auto",
    endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: !!env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

const client = makeClient();

export const storageConfigured = (): boolean => client !== null;

export interface UploadedFile {
  key: string;
  url: string;
  size: number;
  mimeType: string;
  originalName: string;
}

/**
 * Make a client-supplied filename safe to put in a header.
 *
 * It reaches us as whatever the browser sent and goes into
 * `Content-Disposition`. A quote closes the field early and a line break ends
 * the header outright, so anything the uploader chose to call the file could
 * otherwise decide what other headers the response carries.
 */
export function headerSafeName(name: string): string {
  const cleaned = (name || "file")
    .replace(/["\\]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim();
  return (cleaned || "file").slice(0, 120);
}

/** Upload a buffer. Returns the public URL and key. */
export async function uploadFile(opts: {
  key: string;
  buffer: Buffer;
  mimeType: string;
  originalName: string;
}): Promise<UploadedFile> {
  if (!client) throw new Error("Storage not configured — add the R2 env vars");

  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: opts.key,
      Body: opts.buffer,
      ContentType: opts.mimeType,
      ContentDisposition: `inline; filename="${headerSafeName(opts.originalName)}"`,
      Metadata: { originalName: headerSafeName(opts.originalName) },
    }),
  );

  const url = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${opts.key}`
    : `https://${env.R2_BUCKET_NAME}.${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${opts.key}`;

  return {
    key: opts.key,
    url,
    size: opts.buffer.byteLength,
    mimeType: opts.mimeType,
    originalName: opts.originalName,
  };
}

/**
 * A stored file read back, a byte range of it where asked — a training call's recording kept here (2026-11-03),
 * played through this server since the bucket's files are not for anyone with the link. Null when it isn't there.
 */
export async function readFile(key: string, range?: string): Promise<{
  status: number; body: Readable; contentType: string; contentLength?: number; contentRange?: string;
} | null> {
  if (!client || !key) return null;
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key, ...(range ? { Range: range } : {}) }));
    if (!r.Body) return null;
    const raw = r.Body as unknown as Readable | { transformToWebStream: () => ReadableStream };
    const body = raw instanceof Readable ? raw : Readable.fromWeb(raw.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0]);
    return {
      status: r.ContentRange ? 206 : 200,
      body,
      contentType: r.ContentType ?? "application/octet-stream",
      contentLength: r.ContentLength,
      contentRange: r.ContentRange,
    };
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey" || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Delete a previously uploaded key. Silently ignores missing keys. */
export async function deleteFile(key: string): Promise<void> {
  if (!client || !key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  } catch {
    // ignore missing
  }
}
