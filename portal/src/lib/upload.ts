/**
 * Sends one file to the submissions bucket in parts, straight from the
 * browser. A part that fails is retried with a fresh link. If the connection
 * stays down the upload stops, and starting it again skips the parts that
 * already arrived, even after a reload, because the server keeps the list.
 */
import { SUBMISSION_PART_BYTES, type SubmissionFile, submissionParts } from "@niltv/types";
import { api } from "../api";
import { rateLimitWaitMs } from "./ratelimit";

const WORKERS = 3;
const ATTEMPTS = 5;

/** Part numbers still to send, lowest first. */
export function partsToSend(size: number, done: readonly number[]): number[] {
  const have = new Set(done);
  return Array.from({ length: submissionParts(size) }, (_, i) => i + 1).filter((n) => !have.has(n));
}

/** The byte range of a part. The last one is whatever is left. */
export function partRange(size: number, partNumber: number): { start: number; end: number } {
  const start = (partNumber - 1) * SUBMISSION_PART_BYTES;
  return { start, end: Math.min(start + SUBMISSION_PART_BYTES, size) };
}

/** Seconds to wait before the next attempt. */
export const retryDelay = (attempt: number): number => 2 ** attempt;

function putPart(url: string, body: Blob, onBytes: (sent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const stop = () => xhr.abort();
    signal.addEventListener("abort", stop, { once: true });
    const finish = (fn: () => void) => {
      signal.removeEventListener("abort", stop);
      fn();
    };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () =>
      finish(() => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`))));
    xhr.onerror = () => finish(() => reject(new Error("Connection lost")));
    xhr.onabort = () => finish(() => reject(new DOMException("Stopped", "AbortError")));
    xhr.send(body);
  });
}

const wait = (seconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export async function uploadFile(
  askId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<SubmissionFile> {
  const start = async () => {
    // A 429 is refused before anything is stored, so waiting it out and starting again is safe.
    for (let attempt = 0; ; attempt++) {
      try {
        return await api.startUpload(askId, { name: file.name, size: file.size, type: file.type });
      } catch (err) {
        const waitMs = rateLimitWaitMs(err);
        if (waitMs === undefined || attempt >= 2 || signal.aborted) throw err;
        await wait(waitMs / 1000, signal);
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      }
    }
  };
  const { fileId, doneParts } = await start();
  const sent = new Map<number, number>();
  for (const n of doneParts) {
    const { start, end } = partRange(file.size, n);
    sent.set(n, end - start);
  }
  const report = () => onProgress([...sent.values()].reduce((sum, n) => sum + n, 0) / file.size);
  report();

  const queue = partsToSend(file.size, doneParts);
  const sendPart = async (n: number): Promise<void> => {
    const { start, end } = partRange(file.size, n);
    for (let attempt = 0; ; attempt++) {
      try {
        const { url } = await api.uploadPart(askId, fileId, n);
        await putPart(
          url,
          file.slice(start, end),
          (bytes) => {
            sent.set(n, bytes);
            report();
          },
          signal,
        );
        sent.set(n, end - start);
        report();
        return;
      } catch (err) {
        sent.delete(n);
        report();
        if (signal.aborted || attempt + 1 >= ATTEMPTS) throw err;
        await wait(retryDelay(attempt), signal);
      }
    }
  };
  const worker = async (): Promise<void> => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n);
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, worker));
  return api.completeUpload(askId, fileId);
}
