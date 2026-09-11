/**
 * Red-first suite for `src/guard.ts`: the high-risk command fence and its two
 * approval paths.
 *
 * The unit under test is pure classification plus the approval choreography, so
 * it is driven with a fake approval service rather than a live agent.
 */
import { describe, expect, it } from 'vitest'
import {
  approveConsoleCommand,
  classifyCommand,
  commandSegments,
  compileFence,
  DEFAULT_FENCE_SOURCES,
  isHighRisk,
  type ConsoleFenceSettings,
} from '../src/guard.ts'
import type { ConsoleApprovalOutcome, ConsoleApprovalService, ConsoleToolRunContext } from '../src/context-types.ts'

/** A fence policy for tests. */
function policy(overrides: Partial<ConsoleFenceSettings> = {}): ConsoleFenceSettings {
  return {
    approvalMode: 'high-risk',
    highRiskPatterns: [...DEFAULT_FENCE_SOURCES],
    ...overrides,
  }
}

/** A tool-exec context stub. */
function exec(): ConsoleToolRunContext {
  return {
    agent: { session: { id: 'session-a' } },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

/** An approval stub that records every ask and answers with a scripted outcome. */
function fakeApproval(outcome: ConsoleApprovalOutcome = 'allowed-once'): ConsoleApprovalService & {
  asks: { toolName: string, callId: string, reason: string }[]
} {
  const asks: { toolName: string, callId: string, reason: string }[] = []
  return {
    asks,
    async request(req) {
      asks.push({ toolName: req.toolName, callId: req.callId, reason: req.reason })
      return outcome
    },
  }
}

describe('compileFence', () => {
  it('anchors at the command start and ignores case', () => {
    const fence = compileFence('config|conf|configure')
    expect(fence.some(pattern => pattern.test('config terminal'))).toBe(true)
    expect(fence.some(pattern => pattern.test('CONF t'))).toBe(true)
    expect(fence.some(pattern => pattern.test('configure'))).toBe(true)
  })

  it('does not fence a command that merely mentions the word', () => {
    const fence = compileFence('config|conf|configure')
    for (const command of ['show running-config', 'display current-configuration', 'show configuration']) {
      expect(fence.some(pattern => pattern.test(command))).toBe(false)
    }
  })

  it('rejects a malformed source', () => {
    expect(() => compileFence('(')).toThrow()
  })
})

describe('commandSegments', () => {
  it('splits a compound line on the separators a device CLI accepts', () => {
    expect(commandSegments('config terminal; show version')).toEqual(['config terminal', 'show version'])
    expect(commandSegments('enable && configure')).toEqual(['enable', 'configure'])
    expect(commandSegments('a\nb')).toEqual(['a', 'b'])
    expect(commandSegments('  spaced  ')).toEqual(['spaced'])
    expect(commandSegments('')).toEqual([])
  })

  it('keeps a quoted separator inside its segment', () => {
    // A `;` inside quotes is data, not a command boundary; splitting it would
    // both misclassify and mis-report what was sent.
    expect(commandSegments('banner motd "a;b"')).toEqual(['banner motd "a;b"'])
  })
})

describe('classifyCommand', () => {
  it('fences configuration entry and restarts', () => {
    for (const command of ['config terminal', 'conf t', 'configure', 'restart', 'reboot', 'reload']) {
      expect(classifyCommand(command, policy()).risk).toBe('high')
    }
  })

  it('lets ordinary reads through', () => {
    for (const command of [
      'show version',
      'show running-config',
      'display current-configuration',
      'show interfaces',
      '?',
      'exit',
    ]) {
      expect(classifyCommand(command, policy()).risk).toBe('safe')
    }
  })

  it('fences a compound line when ANY segment is high risk', () => {
    const classified = classifyCommand('show version; config terminal', policy())
    expect(classified.risk).toBe('high')
    expect(classified.matchedSegment).toBe('config terminal')
  })

  it('reports which source and segment matched so the prompt can be specific', () => {
    const classified = classifyCommand('reload in 5', policy())
    expect(classified.risk).toBe('high')
    expect(classified.matchedSource).toBe('restart|reboot|reload')
    expect(classified.matchedSegment).toBe('reload in 5')
  })

  it('fences EVERY command in always mode, including a read', () => {
    const classified = classifyCommand('show version', policy({ approvalMode: 'always' }))
    expect(classified.risk).toBe('high')
    expect(classified.matchedSource).toBe('approvalMode:always')
  })

  it('treats an empty or whitespace command as safe (there is nothing to run)', () => {
    expect(classifyCommand('', policy()).risk).toBe('safe')
    expect(classifyCommand('   ', policy()).risk).toBe('safe')
  })

  it('honours a custom pattern set', () => {
    const custom = policy({ highRiskPatterns: ['write|erase'] })
    expect(classifyCommand('write memory', custom).risk).toBe('high')
    expect(classifyCommand('erase startup-config', custom).risk).toBe('high')
    // The defaults no longer apply once the deployment states its own set.
    expect(classifyCommand('config terminal', custom).risk).toBe('safe')
  })
})

describe('isHighRisk', () => {
  it('mirrors classifyCommand for the common question', () => {
    expect(isHighRisk('config terminal', policy())).toBe(true)
    expect(isHighRisk('show version', policy())).toBe(false)
  })
})

describe('approveConsoleCommand', () => {
  it('asks nothing for a safe command', async () => {
    const approval = fakeApproval()
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'show version' },
      { policy: policy(), approver: approval },
    )
    expect(result.approved).toBe(true)
    expect(approval.asks).toHaveLength(0)
  })

  it('asks for a high-risk command and proceeds on allowed-once', async () => {
    const approval = fakeApproval('allowed-once')
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'config terminal' },
      { policy: policy(), approver: approval },
    )
    expect(result.approved).toBe(true)
    expect(approval.asks).toHaveLength(1)
    expect(approval.asks[0]?.toolName).toBe('console_send')
    expect(approval.asks[0]?.callId).toBe('call-1')
    // The reason names the device and the exact command, so the user decides on
    // facts rather than on "the model wants to run something".
    expect(approval.asks[0]?.reason).toContain('FW1')
    expect(approval.asks[0]?.reason).toContain('config terminal')
  })

  it('fails closed when the user rejects', async () => {
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver: fakeApproval('rejected') },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/reject/i)
  })

  it('fails closed when the ask is cancelled', async () => {
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver: fakeApproval('cancelled') },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/cancel/i)
  })

  it('fails closed when no approval channel exists', async () => {
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver: fakeApproval('unavailable') },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/approval|available/i)
  })

  it('fails closed when no approver is composed at all', async () => {
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver: undefined },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/approval/i)
  })

  it('fails closed when the call has no agent to route the question through', async () => {
    const approval = fakeApproval()
    const result = await approveConsoleCommand(
      { exec: { callId: 'c1', signal: new AbortController().signal }, consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver: approval },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/agent/i)
    // No agent means no one to ask, so nothing should have been dispatched.
    expect(approval.asks).toHaveLength(0)
  })

  it('fails closed when the approver throws', async () => {
    const approver: ConsoleApprovalService = {
      async request() {
        throw new Error('approval transport down')
      },
    }
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'FW1', command: 'restart' },
      { policy: policy(), approver },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/approval/i)
  })

  it('carries the call signal into the ask so an abort withdraws the question', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const approver: ConsoleApprovalService = {
      async request(req) {
        seen = req.signal
        return 'allowed-once'
      },
    }
    await approveConsoleCommand(
      {
        exec: { agent: { session: { id: 's' } }, callId: 'c1', signal: controller.signal },
        consoleLabel: 'FW1',
        command: 'restart',
      },
      { policy: policy(), approver },
    )
    expect(seen).toBe(controller.signal)
  })

  it('names the specific segment in the reason for a compound command', async () => {
    const approval = fakeApproval()
    await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'SW1', command: 'show version; reboot' },
      { policy: policy(), approver: approval },
    )
    expect(approval.asks[0]?.reason).toContain('reboot')
  })
})
