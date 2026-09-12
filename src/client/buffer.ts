/**
 * Per-console output storage for the console tab.
 *
 * One shared output string was wrong in two ways at once. Switching consoles
 * cleared it and then waited for the next poll tick to refill it -- so every
 * switch flashed `(暂无输出)` before showing text that had ALREADY been read,
 * and the delay grew with the poll interval. And it grew without bound: a
 * device that streams (`show log`, a debug trace) appended forever, because
 * nothing but a console switch ever dropped a byte.
 *
 * A buffer per console fixes both. The cursor is stored WITH the text it
 * produced, so a switch back is instant and correct -- no re-read, no gap --
 * and each buffer is bounded on the client exactly as the host bounds its own
 * ring, trimming from the FRONT because old output is the expendable end.
 *
 * The cursor is a byte offset into the host's ring and is deliberately NOT
 * rewound when text is trimmed: it addresses the host's stream, not this
 * string, and a rewound cursor would re-deliver output already shown.
 *
 * @module dsh-console-hub/client/buffer
 */

/**
 * Client-side cap on one console's retained text, in characters.
 *
 * Mirrors the host's default `scrollbackLimitBytes` (262144). The host already
 * refuses to hand out more than its own window, so this bound exists for the
 * case the host cannot cover: many consoles open at once, each accumulating
 * for as long as the tab lives.
 */
export const MAX_OUTPUT_CHARS = 262_144

/**
 * The marker prepended when the front of a buffer is trimmed. Its presence is
 * also the test for "already marked", so repeated trims do not stack markers.
 */
export const TRUNCATION_NOTICE = '⋯（前部输出已截断）\n'

/** One console's retained output and the cursor that produced it. */
export interface ConsoleBuffer {
  /** The retained text, oldest first; may begin with {@link TRUNCATION_NOTICE}. */
  text: string
  /** Host stream offset of the NEXT unread byte. Independent of {@link text}. */
  cursor: number
  /** Whether the host reports the pager as still active. */
  paging: boolean
}

/** An empty buffer, as a console that has produced nothing yet. */
export function emptyBuffer(): ConsoleBuffer {
  return { text: '', cursor: 0, paging: false }
}

/**
 * Append output to a bounded buffer, trimming the front when it overflows.
 *
 * Trimming prefers a newline boundary so the retained text starts on a whole
 * line: a device's output is line-oriented, and cutting mid-line leaves a
 * fragment that reads as if the device emitted it.
 *
 * @param previous - the text retained so far.
 * @param text - the newly read text to append.
 * @param limit - the character cap; defaults to {@link MAX_OUTPUT_CHARS}.
 * @returns the text to retain, never longer than `limit` plus the notice.
 */
export function appendBounded(
  previous: string,
  text: string,
  limit: number = MAX_OUTPUT_CHARS,
): string {
  const combined = previous + text
  if (combined.length <= limit) return combined
  const tail = combined.slice(combined.length - limit)
  // Resume at the first line start, so no half line survives -- but only when
  // dropping that much still leaves most of the window.
  const firstBreak = tail.indexOf('\n')
  const trimmed = firstBreak !== -1 && firstBreak < tail.length / 2 ? tail.slice(firstBreak + 1) : tail
  return trimmed.startsWith(TRUNCATION_NOTICE) ? trimmed : TRUNCATION_NOTICE + trimmed
}

/**
 * The per-console buffers, keyed by console id.
 *
 * The view holds one of these in a ref rather than in state: a read appends on
 * every tick, and routing that through React state for consoles the user is not
 * looking at would re-render the whole tab per byte for no visible change.
 */
export class ConsoleBuffers {
  private readonly buffers = new Map<string, ConsoleBuffer>()

  /**
   * @param limit - per-console character cap; defaults to {@link MAX_OUTPUT_CHARS}.
   */
  constructor(private readonly limit: number = MAX_OUTPUT_CHARS) {}

  /**
   * The buffer for one console, created empty on first ask.
   * @param consoleId - the console to look up.
   * @returns its buffer (never `undefined`; never shared).
   */
  get(consoleId: string): ConsoleBuffer {
    const existing = this.buffers.get(consoleId)
    if (existing !== undefined) return existing
    const created = emptyBuffer()
    this.buffers.set(consoleId, created)
    return created
  }

  /**
   * Record one read's output and advance that console's cursor.
   * @param consoleId - the console that produced the text.
   * @param text - the newly read text.
   * @param cursor - the cursor the host returned for this read.
   * @param paging - whether the host reports the pager as active.
   * @returns the updated buffer.
   */
  append(consoleId: string, text: string, cursor: number, paging: boolean): ConsoleBuffer {
    const current = this.get(consoleId)
    const next: ConsoleBuffer = {
      text: text === '' ? current.text : appendBounded(current.text, text, this.limit),
      cursor,
      paging,
    }
    this.buffers.set(consoleId, next)
    return next
  }

  /**
   * Drop one console's buffer, for a console that has ended.
   * @param consoleId - the console to forget.
   */
  clear(consoleId: string): void {
    this.buffers.delete(consoleId)
  }

  /**
   * Drop every buffer not in `keep`, so consoles closed elsewhere do not hold
   * their output for the life of the tab.
   * @param keep - the console ids still live.
   * @returns the ids forgotten.
   */
  retainOnly(keep: Iterable<string>): string[] {
    const live = new Set(keep)
    const dropped: string[] = []
    for (const consoleId of [...this.buffers.keys()]) {
      if (!live.has(consoleId)) {
        this.buffers.delete(consoleId)
        dropped.push(consoleId)
      }
    }
    return dropped
  }
}
