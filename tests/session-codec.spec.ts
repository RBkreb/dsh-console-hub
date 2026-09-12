/**
 * Red-first suite for `src/session-codec.ts`: the pure telnet/encoding/ring
 * buffer layer. Fixtures come from the lab capture in `tmp_console/fw1_console.py`,
 * which verified that the serial server emits an IAC negotiation storm on
 * connect and lands at a user-view prompt.
 */
import { describe, expect, it } from 'vitest'
import {
  IAC,
  decodeBytes,
  encodeText,
  createRingBuffer,
  matchPager,
  matchPrompt,
  negotiationReply,
  stripIac,
} from '../src/session-codec.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN, compilePattern } from '../src/config-shared.ts'

const DO = 253
const DONT = 254
const WILL = 251
const WONT = 252
const SB = 250
const SE = 240

/** Build a byte string from code points, so fixtures stay readable. */
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('stripIac', () => {
  it('leaves plain ASCII and UTF-8 text untouched', () => {
    const text = Buffer.from('show version\r\nVersion 1.2.3\r\n', 'utf8')
    expect(stripIac(new Uint8Array(text))).toEqual(new Uint8Array(text))
  })

  it('removes the 3-byte negotiation storm the serial server sends', () => {
    // The real shape: IAC DO <opt> / IAC WILL <opt> interleaved with spaces,
    // exactly as fw1_console.py documents.
    const input = bytes(IAC, DO, 24, 0x20, IAC, WILL, 1, 0x20, IAC, DONT, 34)
    expect([...stripIac(input)]).toEqual([0x20, 0x20])
  })

  it('keeps text around the negotiation bytes', () => {
    const input = new Uint8Array([
      ...Buffer.from('<DUT1>', 'utf8'),
      IAC, DO, 24,
      0x20,
      IAC, WILL, 1,
      ...Buffer.from('\r\n', 'utf8'),
    ])
    expect(Buffer.from(stripIac(input)).toString('utf8')).toBe('<DUT1> \r\n')
  })

  it('keeps a literal 0xFF that arrived escaped as IAC IAC', () => {
    expect([...stripIac(bytes(0x41, IAC, IAC, 0x42))]).toEqual([0x41, 0xFF, 0x42])
  })

  it('drops a whole subnegotiation payload (IAC SB … IAC SE)', () => {
    const input = bytes(0x41, IAC, SB, 1, 2, 3, IAC, SE, 0x42)
    expect([...stripIac(input)]).toEqual([0x41, 0x42])
  })

  it('handles a sequence truncated mid-command without throwing', () => {
    expect([...stripIac(bytes(0x41, IAC))]).toEqual([0x41])
    expect([...stripIac(bytes(0x41, IAC, DO))]).toEqual([0x41])
    expect([...stripIac(bytes(0x41, IAC, SB, 1, 2))]).toEqual([0x41])
  })

  it('ignores a lone 0xFF in the middle of text', () => {
    // A raw 0xFF that is NOT part of a command still terminates the scan for
    // that chunk rather than emitting a bogus byte.
    expect([...stripIac(bytes(0x41, IAC, 0x42))]).toEqual([0x41])
  })
})

describe('negotiationReply', () => {
  it('refuses every option the peer requests', () => {
    const reply = negotiationReply(bytes(IAC, DO, 24))
    expect([...reply]).toEqual([IAC, WONT, 24])
  })

  it('replies DONT to WILL and to WONT, DO and DONT both answer WONT', () => {
    expect([...negotiationReply(bytes(IAC, WILL, 1))]).toEqual([IAC, DONT, 1])
    expect([...negotiationReply(bytes(IAC, WONT, 1))]).toEqual([IAC, DONT, 1])
    expect([...negotiationReply(bytes(IAC, DONT, 1))]).toEqual([IAC, WONT, 1])
  })

  it('collects every request in one chunk into one reply', () => {
    const reply = negotiationReply(bytes(IAC, DO, 24, IAC, WILL, 1, IAC, DO, 31))
    expect([...reply]).toEqual([IAC, WONT, 24, IAC, DONT, 1, IAC, WONT, 31])
  })

  it('returns nothing when the chunk carries no request', () => {
    expect(negotiationReply(bytes(...Buffer.from('hello', 'utf8'))).length).toBe(0)
    expect(negotiationReply(bytes(IAC, SB, 1, 2, IAC, SE)).length).toBe(0)
  })
})

describe('encodeText / decodeBytes', () => {
  it('round-trips UTF-8 and GBK', () => {
    expect(decodeBytes(encodeText('你好', 'utf-8'), 'utf-8')).toBe('你好')
    expect(decodeBytes(encodeText('你好', 'gbk'), 'gbk')).toBe('你好')
    expect(decodeBytes(encodeText('交换机', 'gb18030'), 'gb18030')).toBe('交换机')
  })

  it('works without an explicit encoding, defaulting to UTF-8', () => {
    expect(decodeBytes(encodeText('abc'))).toBe('abc')
  })

  it('rejects an encoding it cannot resolve', () => {
    expect(() => encodeText('x', 'rot13')).toThrow(/rot13/)
    expect(() => decodeBytes(bytes(0x41), 'rot13')).toThrow(/rot13/)
  })

  it('never throws on bytes that are invalid in the declared encoding', () => {
    // A console emitting a stray high byte must not kill the session; the
    // decoder substitutes rather than rejecting.
    const decoded = decodeBytes(bytes(0x41, 0xFF, 0xFE, 0x42), 'utf-8')
    expect(decoded.startsWith('A')).toBe(true)
    expect(decoded.endsWith('B')).toBe(true)
  })

  it('accepts the encoding label in any case', () => {
    expect(decodeBytes(encodeText('你好', 'GBK'), 'GBK')).toBe('你好')
  })

  it('decodes a bare high byte deterministically as GBK as well', () => {
    expect(decodeBytes(bytes(0xC4, 0xE3, 0xBA, 0xC3), 'gbk')).toBe('你好')
  })
})

describe('createRingBuffer', () => {
  it('accumulates bytes and reports a monotonic cursor', () => {
    const ring = createRingBuffer(1024)
    expect(ring.length).toBe(0)
    expect(ring.droppedBytes).toBe(0)
    ring.append(bytes(0x41, 0x42))
    ring.append(bytes(0x43))
    expect(ring.length).toBe(3)
    expect([...ring.slice(0)]).toEqual([0x41, 0x42, 0x43])
    expect([...ring.slice(1)]).toEqual([0x42, 0x43])
  })

  it('keeps the newest bytes and counts what it dropped', () => {
    const ring = createRingBuffer(4)
    ring.append(bytes(1, 2, 3, 4, 5, 6))
    expect(ring.length).toBe(4)
    expect(ring.droppedBytes).toBe(2)
    expect([...ring.slice(0)]).toEqual([3, 4, 5, 6])
  })

  it('reports a cursor that accounts for dropped bytes', () => {
    const ring = createRingBuffer(4)
    ring.append(bytes(1, 2, 3, 4, 5, 6))
    // `written` counts everything ever appended; a reader holding an older
    // cursor learns it fell out of the window instead of silently reading the
    // wrong bytes.
    expect(ring.written).toBe(6)
    expect(ring.length).toBe(4)
    expect(ring.oldestCursor).toBe(2)
  })

  it('refuses a non-positive limit', () => {
    expect(() => createRingBuffer(0)).toThrow(/limit/)
    expect(() => createRingBuffer(-1)).toThrow(/limit/)
  })

  it('empties on clear while keeping the cursor absolute', () => {
    // The property that makes clearing safe: `written` is an offset into the
    // STREAM, not into the retained window. Advancing the drop counter to meet
    // it retires the bytes without renumbering anything, so a reader holding a
    // pre-clear cursor lands outside the (now empty) window and gets nothing --
    // rather than being handed a shifted window of unrelated bytes.
    const ring = createRingBuffer(1024)
    ring.append(bytes(1, 2, 3))
    const before = ring.written
    ring.clear()
    expect(ring.length).toBe(0)
    expect(ring.written).toBe(before)
    expect([...ring.slice(0)]).toEqual([])
    expect([...ring.slice(before)]).toEqual([])
  })

  it('keeps counting after a clear, so post-clear output is readable', () => {
    const ring = createRingBuffer(1024)
    ring.append(bytes(1, 2, 3))
    ring.clear()
    ring.append(bytes(4, 5))
    // The cursor did not restart, so output that arrives after the clear is not
    // confused with the bytes that were dropped.
    expect(ring.written).toBe(5)
    expect([...ring.slice(3)]).toEqual([4, 5])
    expect([...ring.slice(0)]).toEqual([4, 5])
  })
})

describe('matchPrompt / matchPager', () => {
  const prompt = compilePattern(DEFAULT_PROMPT_PATTERN)
  const pager = compilePattern(DEFAULT_PAGER_PATTERN)

  it('recognizes the lab device prompts', () => {
    expect(matchPrompt('<DUT1>', prompt)).toBe('<DUT1>')
    expect(matchPrompt('[DUT1]', prompt)).toBe('[DUT1]')
    expect(matchPrompt('  [DUT1-interface-Gi0/1] ', prompt)).toBe('[DUT1-interface-Gi0/1]')
    // Trailing output after the prompt means the prompt is not the tail.
    expect(matchPrompt('<DUT1>\r\nshow version', prompt)).toBeUndefined()
    expect(matchPrompt('Version 1.2.3', prompt)).toBeUndefined()
  })

  it('only looks at the tail window, so old output cannot fake a prompt', () => {
    // A prompt printed long ago, then a lot of output after it.
    const long = `<DUT1>\r\n${'x'.repeat(4000)}`
    expect(matchPrompt(long, prompt)).toBeUndefined()
  })

  it('recognizes pager prompts', () => {
    expect(matchPager('... lots of lines ...\r\n  --More--', pager)).toBe('--More--')
    expect(matchPager('---- More ----', pager)).toBe('---- More ----')
    expect(matchPager('More: ', pager)).toBe('More:')
    expect(matchPager('...\r\n(q)uit', pager)).toBe('(q)uit')
    expect(matchPager('--More--  ', pager)).toBe('--More--')
    expect(matchPager('ordinary output line', pager)).toBeUndefined()
  })

  it('does not treat a mid-line mention as a pager', () => {
    expect(matchPager('the --More-- flag is documented below\r\nnext line', pager)).toBeUndefined()
  })

  it('reports the matched text so the caller can log what it saw', () => {
    expect(matchPager('foo\r\n Press any key', pager)).toBe('Press any key')
  })
})

describe('IAC constant', () => {
  it('is 0xFF', () => {
    expect(IAC).toBe(255)
  })
})
