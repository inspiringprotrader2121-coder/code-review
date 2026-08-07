import { Readable, Transform, type Duplex } from 'node:stream';
import { createGunzip } from 'node:zlib';

/**
 * Convert Octokit's binary response body into a Node stream and enforce the
 * compressed archive cap while bytes are arriving. Octokit returns a Web
 * ReadableStream when response parsing is disabled, while tests and older
 * callers may provide an ArrayBuffer or Node stream.
 *
 * Two bounds are enforced here, both against a hostile/pathological repo:
 *  - `maxBytes`: total compressed bytes (a zip-bomb trickle can't exceed it).
 *  - `idleTimeoutMs`: no-chunk wall-clock. A source that drips bytes under the
 *    cap would otherwise stall a review job forever; there is no sandbox or
 *    Codex hard-cap on the archive FETCH itself, only on what runs after.
 *
 * Callers that gunzip the result MUST also enforce an uncompressed budget
 * ({@link createCappedGunzip}) — the compressed cap alone is not enough
 * against a zip bomb.
 */
export function createCappedArchiveStream(
  data: unknown,
  maxBytes: number,
  opts: { idleTimeoutMs?: number } = {},
): Readable {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`invalid archive byte cap: ${String(maxBytes)}`);
  }
  const idleTimeoutMs =
    opts.idleTimeoutMs !== undefined && Number.isFinite(opts.idleTimeoutMs) && opts.idleTimeoutMs > 0
      ? Math.floor(opts.idleTimeoutMs)
      : 120_000;

  let source: Readable;
  if (data instanceof ArrayBuffer) {
    source = Readable.from([Buffer.from(data)]);
  } else if (ArrayBuffer.isView(data)) {
    source = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
  } else if (data && typeof (data as { getReader?: unknown }).getReader === 'function') {
    source = Readable.fromWeb(data as ReadableStream<Uint8Array>);
  } else if (data && typeof (data as { pipe?: unknown }).pipe === 'function') {
    source = data as Readable;
  } else if (data && typeof (data as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    source = Readable.from(data as AsyncIterable<Uint8Array>);
  } else {
    throw new Error('GitHub archive response was not a readable body');
  }

  let received = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let tearingDown = false;
  const abortSource = (err?: Error) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (tearingDown) return;
    tearingDown = true;
    if (!source.destroyed) {
      source.destroy(err);
    }
  };
  const resetIdleTimer = (limiter: Transform) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const err = new Error(`repository archive stalled for ${idleTimeoutMs}ms`);
      limiter.destroy(err);
      abortSource(err);
    }, idleTimeoutMs);
  };

  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > maxBytes) {
        const err = new Error(`repository archive exceeds the ${maxBytes}-byte cap`);
        if (idleTimer) clearTimeout(idleTimer);
        abortSource(err);
        callback(err);
        return;
      }
      resetIdleTimer(limiter);
      callback(null, bytes);
    },
  });
  limiter.on('error', (err) => abortSource(err instanceof Error ? err : new Error(String(err))));
  limiter.on('close', () => abortSource());
  source.on('error', (err) => limiter.destroy(err));
  source.pipe(limiter);
  // If the consumer stops reading (limiter's writable buffer full), pause the
  // source so an unconsumed stream can't buffer up to the cap in memory.
  limiter.on('drain', () => source.resume());
  if (limiter.writableNeedDrain) source.pause();
  resetIdleTimer(limiter);
  return limiter;
}

/**
 * Gunzip with a hard uncompressed-output budget. Node's streaming
 * `maxOutputLength` is not reliably enforced (sync gunzipSync is), so this
 * wraps inflate with an explicit byte counter that aborts on overrun — the
 * real zip-bomb defense alongside the compressed cap.
 */
export function createCappedGunzip(maxUncompressedBytes: number): Duplex {
  if (!Number.isFinite(maxUncompressedBytes) || maxUncompressedBytes <= 0) {
    throw new Error(`invalid uncompressed archive byte cap: ${String(maxUncompressedBytes)}`);
  }
  const max = Math.floor(maxUncompressedBytes);
  const gunzip = createGunzip({ maxOutputLength: max });
  let produced = 0;
  let gunzipEnded = false;

  const out = new Transform({
    transform(chunk: Buffer | Uint8Array, encoding, callback) {
      if (!gunzip.write(chunk, encoding)) {
        gunzip.once('drain', () => callback());
      } else {
        callback();
      }
    },
    flush(callback) {
      gunzip.end();
      if (gunzipEnded) {
        callback();
        return;
      }
      const onEnd = () => {
        cleanup();
        callback();
      };
      const onError = (err: Error) => {
        cleanup();
        callback(err);
      };
      const cleanup = () => {
        gunzip.off('end', onEnd);
        gunzip.off('error', onError);
      };
      gunzip.once('end', onEnd);
      gunzip.once('error', onError);
    },
  }) as Duplex;

  gunzip.on('data', (chunk: Buffer) => {
    produced += chunk.length;
    if (produced > max) {
      const err = new Error(`repository archive expands past the ${max}-byte uncompressed cap`);
      gunzip.destroy(err);
      out.destroy(err);
      return;
    }
    if (!out.push(chunk)) {
      gunzip.pause();
      out.once('drain', () => gunzip.resume());
    }
  });
  gunzip.on('error', (err) => {
    if (!out.destroyed) out.destroy(err);
  });
  gunzip.on('end', () => {
    gunzipEnded = true;
    out.push(null);
  });

  return out;
}
