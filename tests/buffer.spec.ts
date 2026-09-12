/**
 * The per-console output store the console tab renders from.
 *
 * Every case here pins a defect that reached a real user:
 *
 * - a single shared output string was cleared on every console switch, so the
 *   pane showed `(暂无输出)` and then waited a full poll interval to re-show
 *   text that had already been read;
 * - that string grew without bound, because only a switch ever dropped a byte.
 *
 * @module dsh-console-hub/tests/buffer
 */
import { describe, expect, it } from 'vitest'
import {
  appendBounded,
  ConsoleBuffers,
  emptyBuffer,
  MAX_OUTPUT_CHARS,
  TRUNCATION_NOTICE,
} from '../src/client/buffer.ts'

describe('appendBounded', () => {
  it('passes through text under the cap unchanged', () => {
    expect(appendBounded('a', 'b', 100)).toBe('ab')
    expect(appendBounded('', '', 100)).toBe('')
  })

  it('keeps the newest text and marks the cut when the cap is passed', () => {
    const kept = appendBounded('x'.repeat(80), 'y'.repeat(80), 100)
    // The tail survives, so the newest device output is what the user sees.
    expect(kept.endsWith('y')).toBe(true)
    // ...and the loss is announced rather than silent.
    expect(kept.startsWith(TRUNCATION_NOTICE)).toBe(true)
  })

  it('trims at a line boundary when one is near enough to prefer', () => {
    // A fragment that begins mid-line reads as though the device emitted it, so
    // the trim resumes at the next newline when that costs little.
    const previous = 'first line\nsecond line\nthird line\nf'
    const kept = appendBounded(previous, 'ourth', 20)
    const body = kept.startsWith(TRUNCATION_NOTICE) ? kept.slice(TRUNCATION_NOTICE.length) : kept
    expect(body.startsWith('line')).toBe(false)
    expect(body).toContain('fourth')
  })

  it('never stacks the truncation notice across repeated trims', () => {
    let text = 'a'.repeat(50)
    for (let index = 0; index < 5; index += 1) text = appendBounded(text, 'b'.repeat(50), 60)
    expect(text.startsWith(TRUNCATION_NOTICE)).toBe(true)
    expect(text.slice(TRUNCATION_NOTICE.length)).not.toContain(TRUNCATION_NOTICE)
  })

  it('honours a custom cap', () => {
    const kept = appendBounded('', 'abcdefghij', 4)
    expect(kept.length).toBeLessThanOrEqual(4 + TRUNCATION_NOTICE.length)
  })

  it('does not grow past the cap while streaming', () => {
    // The unbounded-growth case: a device that keeps talking must not accumulate
    // for the life of the tab.
    let text = ''
    for (let index = 0; index < 500; index += 1) text = appendBounded(text, 'x'.repeat(1000), MAX_OUTPUT_CHARS)
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + TRUNCATION_NOTICE.length)
  })
})

describe('ConsoleBuffers', () => {
  it('keeps one console output out of another', () => {
    const buffers = new ConsoleBuffers()
    buffers.append('c1', 'from one', 10, false)
    buffers.append('c2', 'from two', 20, false)
    expect(buffers.get('c1').text).toBe('from one')
    expect(buffers.get('c2').text).toBe('from two')
    expect(buffers.get('c1').cursor).toBe(10)
    expect(buffers.get('c2').cursor).toBe(20)
  })

  it('returns empty, not undefined, for a console never read', () => {
    // The switch path asks for a buffer unconditionally; an undefined here was
    // the shape that would have thrown inside render.
    expect(new ConsoleBuffers().get('never-seen')).toEqual(emptyBuffer())
  })

  it('advances the cursor with the text that produced it', () => {
    const buffers = new ConsoleBuffers()
    buffers.append('c1', 'first', 5, false)
    const after = buffers.append('c1', 'second', 11, true)
    // The cursor must track the host stream, not this string's length: it is the
    // offset the next read asks from.
    expect(after.cursor).toBe(11)
    expect(after.text).toBe('firstsecond')
    expect(after.paging).toBe(true)
  })

  it('leaves the cursor alone when a read brought nothing', () => {
    const buffers = new ConsoleBuffers()
    buffers.append('c1', 'text', 7, false)
    const idle = buffers.append('c1', '', 7, false)
    expect(idle.text).toBe('text')
    expect(idle.cursor).toBe(7)
  })

  it('forgets a console on clear, so a closed one holds nothing', () => {
    const buffers = new ConsoleBuffers()
    buffers.append('c1', 'gone soon', 3, false)
    buffers.clear('c1')
    expect(buffers.get('c1')).toEqual(emptyBuffer())
  })

  it('retains only the live consoles and reports what it dropped', () => {
    const buffers = new ConsoleBuffers()
    buffers.append('c1', 'one', 1, false)
    buffers.append('c2', 'two', 2, false)
    buffers.append('c3', 'three', 3, false)
    const dropped = buffers.retainOnly(['c2'])
    expect(dropped.sort()).toEqual(['c1', 'c3'])
    expect(buffers.get('c2').text).toBe('two')
    // A dropped id reads empty rather than resurrecting its old text.
    expect(buffers.get('c1')).toEqual(emptyBuffer())
  })
})
