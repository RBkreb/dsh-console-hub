/**
 * Pure console-wire layer: telnet IAC handling, character transcoding, the
 * scrollback ring buffer, and prompt/pager matching.
 *
 * Everything here is a pure function or a small state holder over bytes, so the
 * session layer above it deals only in sockets and timing. The IAC walk follows
 * the behaviour verified against the lab serial servers in
 * `tmp_console/fw1_console.py`: a console server answers a connect with a storm
 * of option negotiations, and refusing every option makes it stop.
 *
 * @module dsh-console-hub/session-codec
 */
import iconv from 'iconv-lite'
import { isConsoleEncoding } from './config-shared.ts'

// ── Telnet control vocabulary ───────────────────────────────────────────────

/** Interpret-As-Command: the escape byte every other command follows. */
export const IAC = 255
/** End of subnegotiation. */
export const SE = 240
/** Subnegotiation start. */
export const SB = 250
/** Will perform / won't perform / do / don't (RFC 854). */
export const WILL = 251
export const WONT = 252
export const DO = 253
export const DONT = 254

/** The four option-negotiation commands, which carry one option byte. */
const OPTION_COMMANDS = new Set([WILL, WONT, DO, DONT])

// ── Byte helpers ────────────────────────────────────────────────────────────

/**
 * Remove every telnet IAC command sequence from a byte stream.
 *
 * - `IAC IAC` is an escaped literal `0xFF` and is kept,
 * - `IAC SB … IAC SE` subnegotiation payloads are dropped,
 * - `IAC <WILL|WONT|DO|DONT> <opt>` (three bytes) is dropped,
 * - any other `IAC <cmd>` (two bytes) is dropped.
 *
 * A sequence that runs off the end of the chunk is dropped rather than
 * throwing: the caller hands us whatever one socket read returned, and a
 * command split across two reads must not corrupt the stream.
 *
 * @param data - the raw bytes from one socket read.
 * @returns the bytes with all telnet control sequences removed.
 */
export function stripIac(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const byte = data[i] as number
    if (byte !== IAC) {
      out.push(byte)
      i += 1
      continue
    }
    if (i + 1 >= data.length) break
    const command = data[i + 1] as number
    if (command === IAC) {
      out.push(IAC)
      i += 2
    } else if (command === SB) {
      // Hunt for the closing IAC SE; an unterminated payload swallows the rest
      // of the chunk, exactly as the reference implementation does.
      let end = -1
      for (let j = i + 2; j + 1 < data.length; j += 1) {
        if (data[j] === IAC && data[j + 1] === SE) {
          end = j
          break
        }
      }
      i = end === -1 ? data.length : end + 2
    } else if (OPTION_COMMANDS.has(command)) {
      i += 3
    } else {
      i += 2
    }
  }
  return Uint8Array.from(out)
}

/**
 * Build the refusal reply for every option negotiation in one chunk: `DO`/`DONT`
 * are answered `WONT`, `WILL`/`WONT` are answered `DONT`. Refusing everything is
 * what stops the console server's negotiation storm.
 *
 * @param data - the raw bytes from one socket read.
 * @returns the bytes to write back; empty when the chunk asked nothing.
 */
export function negotiationReply(data: Uint8Array): Uint8Array {
  const reply: number[] = []
  let i = 0
  while (i + 2 < data.length) {
    if (data[i] !== IAC) {
      i += 1
      continue
    }
    const command = data[i + 1] as number
    const option = data[i + 2] as number
    if (command === DO || command === DONT) reply.push(IAC, WONT, option)
    else if (command === WILL || command === WONT) reply.push(IAC, DONT, option)
    i += 3
  }
  return Uint8Array.from(reply)
}

// ── Character transcoding ───────────────────────────────────────────────────

/**
 * Resolve an encoding label to the canonical name the decoder understands.
 * @param encoding - the requested label (any case); omitted means UTF-8.
 * @returns the canonical label.
 * @throws {TypeError} when the label names no supported encoding.
 */
function resolveEncoding(encoding: string | undefined): string {
  const label = (encoding ?? 'utf-8').trim().toLowerCase()
  if (label === 'utf8' || label === 'utf-8') return 'utf-8'
  if (!isConsoleEncoding(label)) {
    throw new TypeError(`console-hub: unsupported encoding "${encoding ?? ''}"`)
  }
  return label
}

/**
 * Encode console input for the wire.
 * @param text - the text to send.
 * @param encoding - target encoding; omitted means UTF-8.
 * @returns the encoded bytes.
 * @throws {TypeError} when the encoding is unsupported.
 */
export function encodeText(text: string, encoding?: string): Uint8Array {
  const label = resolveEncoding(encoding)
  // UTF-8 goes through Node's own encoder so the plugin still works if the
  // optional decoder package is unavailable.
  if (label === 'utf-8') return new Uint8Array(Buffer.from(text, 'utf8'))
  return Uint8Array.from(iconv.encode(text, label))
}

/**
 * Decode console output. Decoding never throws: a stray byte that is invalid in
 * the declared encoding becomes the replacement character, because killing a
 * live console over one bad byte would be worse than showing `�`.
 * @param data - the raw bytes.
 * @param encoding - source encoding; omitted means UTF-8.
 * @returns the decoded text.
 * @throws {TypeError} when the encoding is unsupported.
 */
export function decodeBytes(data: Uint8Array, encoding?: string): string {
  const label = resolveEncoding(encoding)
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (label === 'utf-8') return buffer.toString('utf8')
  return iconv.decode(buffer, label)
}

// ── Scrollback ring buffer ──────────────────────────────────────────────────

/**
 * A byte window over everything a session has received. Readers address it by
 * an absolute cursor, so a slow reader either gets exactly the bytes it missed
 * or learns that they aged out — it can never silently read the wrong window.
 */
export interface RingBuffer {
  /** Bytes currently retained. */
  readonly length: number
  /** Total bytes ever appended (the cursor just past the newest byte). */
  readonly written: number
  /** Cursor of the oldest retained byte. */
  readonly oldestCursor: number
  /** Bytes dropped so far because the limit was exceeded. */
  readonly droppedBytes: number
  /**
   * Append one chunk.
   * @param chunk - bytes from the socket.
   */
  append(chunk: Uint8Array): void
  /**
   * Read from an absolute cursor to the end of the window.
   * @param cursor - absolute byte offset (clamped into the window).
   * @returns the retained bytes at or after `cursor`.
   */
  slice(cursor: number): Uint8Array
}

/**
 * Create a byte ring buffer.
 * @param limitBytes - the maximum number of bytes to retain (positive).
 * @returns the buffer.
 * @throws {TypeError} when the limit is not a positive integer.
 */
export function createRingBuffer(limitBytes: number): RingBuffer {
  if (!Number.isInteger(limitBytes) || limitBytes <= 0) {
    throw new TypeError(`console-hub: ring buffer limit must be a positive integer (got ${String(limitBytes)})`)
  }
  let buffer = new Uint8Array(0)
  let dropped = 0
  return {
    get length() {
      return buffer.length
    },
    get written() {
      return dropped + buffer.length
    },
    get oldestCursor() {
      return dropped
    },
    get droppedBytes() {
      return dropped
    },
    append(chunk) {
      if (chunk.length === 0) return
      const combined = new Uint8Array(buffer.length + chunk.length)
      combined.set(buffer, 0)
      combined.set(chunk, buffer.length)
      if (combined.length > limitBytes) {
        const excess = combined.length - limitBytes
        dropped += excess
        buffer = combined.slice(excess)
      } else {
        buffer = combined
      }
    },
    slice(cursor) {
      const start = Math.max(0, Math.min(cursor - dropped, buffer.length))
      return buffer.slice(start)
    },
  }
}

// ── Prompt / pager matching ─────────────────────────────────────────────────

/**
 * How much trailing text a prompt/pager search may look at. Measured in
 * characters (the unit the decoded text is in).
 */
const TAIL_WINDOW_CHARS = 1024

/** Trailing whitespace a match may carry without being part of the prompt. */
const TRAILING_SPACE = /[\s\u0000]+$/

/**
 * Match a tail-anchored pattern against the end of a text, limited to a small
 * window so a prompt printed thousands of lines ago cannot satisfy today's read.
 * @param text - the decoded tail of the session output.
 * @param pattern - a compiled tail-anchored matcher.
 * @returns the matched text, or `undefined`.
 */
function matchTail(text: string, pattern: RegExp): string | undefined {
  const trimmed = text.replace(TRAILING_SPACE, '')
  const window = trimmed.length > TAIL_WINDOW_CHARS ? trimmed.slice(-TAIL_WINDOW_CHARS) : trimmed
  const found = pattern.exec(window)
  if (found === null) return undefined
  const matched = found[0].replace(TRAILING_SPACE, '')
  return matched === '' ? undefined : matched
}

/**
 * Find a CLI prompt at the tail of the output.
 * @param text - decoded session output.
 * @param pattern - compiled prompt matcher.
 * @returns the prompt text (e.g. `<DUT1>`), or `undefined`.
 */
export function matchPrompt(text: string, pattern: RegExp): string | undefined {
  return matchTail(text, pattern)
}

/**
 * Find a pager prompt at the tail of the output.
 * @param text - decoded session output.
 * @param pattern - compiled pager matcher.
 * @returns the pager text (e.g. `--More--`), or `undefined`.
 */
export function matchPager(text: string, pattern: RegExp): string | undefined {
  return matchTail(text, pattern)
}
