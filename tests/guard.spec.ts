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
  fenceRulesOf,
  isHighRisk,
  type ConsoleFenceSettings,
} from '../src/guard.ts'
import { DEFAULT_FENCE_RULES, matchesFenceRule, type ConsoleFenceRule } from '../src/config-shared.ts'
import type { ConsoleApprovalOutcome, ConsoleApprovalService, ConsoleToolRunContext } from '../src/context-types.ts'

/** A fence policy for tests. */
function policy(overrides: Partial<ConsoleFenceSettings> = {}): ConsoleFenceSettings {
  return {
    approvalMode: 'high-risk',
    highRiskPatterns: [...DEFAULT_FENCE_SOURCES],
    ...overrides,
  }
}

/** A well-formed rule: the unused matcher is the empty string, as the schema produces. */
function rule(id: string, action: ConsoleFenceRule['action'], tokens: string, note = ''): ConsoleFenceRule {
  return { id, action, tokens, pattern: '', note }
}

/** A rule that matches by raw pattern instead of by tokens. */
function patternRule(id: string, action: ConsoleFenceRule['action'], pattern: string, note = ''): ConsoleFenceRule {
  return { id, action, tokens: '', pattern, note }
}
/** A policy with ONLY ordered rules: no legacy patterns, so nothing is inherited. */
function rulesOnly(rules: ConsoleFenceRule[], approvalMode: 'always' | 'high-risk' = 'high-risk'): ConsoleFenceSettings {
  return { approvalMode, fenceRules: rules, highRiskPatterns: [] }
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
    // The shipped RULE id, not the legacy pattern source: rules are evaluated
    // first, so the id a human sees names the rule they can go and edit.
    expect(classified.matchedSource).toBe('restart')
    expect(classified.matchedSegment).toBe('reload in 5')
    expect(classified.matchedNote).toBeTruthy()
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

/**
 * The ordered rule engine, and the bypass it was written to close.
 *
 * The fence these replace matched `config|conf|configure` with a `\b`
 * terminator, and there is no word boundary inside `configuration` -- so
 * `configuration rollback replace BasicConfig`, a command that replaces the
 * running configuration, classified as SAFE and reached the device with no
 * confirmation. Every test in this block is stated against RULES ONLY (no legacy
 * patterns), so it measures the mechanism rather than an inherited document.
 */
describe('fence rules', () => {
  const shipped = (): ConsoleFenceSettings => rulesOnly([...DEFAULT_FENCE_RULES])

  it('fences a configuration ROLLBACK, which the old default pattern missed', () => {
    // The regression. This exact string was `safe` before the rule engine: the
    // device accepts it, and it rewrites the running configuration.
    expect(classifyCommand('configuration rollback replace BasicConfig', shipped()).action).toBe('ask')
    // The old policy is asserted here too, so the test documents what changed
    // rather than only what is true now.
    const legacy = classifyCommand('configuration rollback replace BasicConfig', {
      approvalMode: 'high-risk',
      highRiskPatterns: ['config|conf|configure', 'restart|reboot|reload'],
      fenceRules: [],
    })
    expect(legacy.action).toBe('allow')
  })

  it('fences the ABBREVIATED forms the device also accepts', () => {
    // A device CLI takes any unambiguous prefix, so a rule that only recognised
    // the spelled-out form would be bypassed by typing less. All of these run the
    // same rollback.
    for (const command of [
      'configuration rollback replace BasicConfig',
      'config rollback replace BasicConfig',
      'conf rollback replace BasicConfig',
      'conf roll replace BasicConfig',
      'conf rollb replace BasicConfig',
    ]) {
      expect(classifyCommand(command, shipped()).action, command).toBe('ask')
    }
    // A token that is NOT a prefix of the keyword is not an abbreviation the
    // device would accept either (`rollo` diverges from `rollback` at the 5th
    // character), so it must not match: over-matching beyond what the CLI takes
    // would fence commands that cannot do the thing the rule describes.
    expect(classifyCommand('conf rollo replace BasicConfig', shipped()).action).toBe('allow')
  })

  it('does NOT fence entering configuration mode', () => {
    // Deliberate: `conf` is how anyone edits a device and every edit still has to
    // be committed, so fencing it would bury the dangerous case in a prompt the
    // operator learns to click through. The rule declares TWO tokens, so the
    // one-token prefix does not match it.
    for (const command of ['conf', 'conf t', 'configure', 'configure terminal', 'config', 'configuration']) {
      expect(classifyCommand(command, shipped()).action, command).toBe('allow')
    }
  })

  it('does not fence a READ whose argument merely mentions the words', () => {
    for (const command of [
      'show running-config',
      'display configuration',
      'show configuration rollback',
      'show version',
    ]) {
      expect(classifyCommand(command, shipped()).action, command).toBe('allow')
    }
  })

  it('fences restarts, including abbreviated ones', () => {
    for (const command of ['reboot', 'restart', 'reload', 'rebo', 'rel']) {
      expect(classifyCommand(command, shipped()).action, command).toBe('ask')
    }
  })

  it('takes the FIRST matching rule, so order is the configuration', () => {
    const ordered = rulesOnly([
      rule('allow-rollback', 'allow', 'configuration rollback', 'trusted here'),
      rule('ask-rollback', 'ask', 'configuration rollback', 'replaces the config'),
    ])
    expect(classifyCommand('configuration rollback replace BasicConfig', ordered).matchedSource).toBe('allow-rollback')
    // Flipping the order flips the outcome: nothing else changed.
    const flipped = rulesOnly([
      rule('ask-rollback', 'ask', 'configuration rollback', 'replaces the config'),
      rule('allow-rollback', 'allow', 'configuration rollback', 'trusted here'),
    ])
    expect(classifyCommand('configuration rollback replace BasicConfig', flipped).matchedSource).toBe('ask-rollback')
  })

  it('supports a narrow ALLOW carved out of a broad deny', () => {
    const carve = rulesOnly([
      rule('no-config', 'deny', 'configuration', 'no config changes'),
      rule('reads', 'allow', 'show|display', 'reads are fine'),
    ])
    expect(classifyCommand('configuration terminal', carve).action).toBe('deny')
    expect(classifyCommand('show version', carve).action).toBe('allow')
  })

  it('accepts a raw pattern as an alternative matcher', () => {
    const withPattern = rulesOnly([
      patternRule('erase', 'deny', 'erase\\s+startup-config', 'wipes the saved config'),
    ])
    expect(classifyCommand('erase startup-config', withPattern).action).toBe('deny')
    expect(classifyCommand('show erase', withPattern).action).toBe('allow')
  })

  it('does NOT let an allow rule swallow a later segment of a compound line', () => {
    // The bypass a naive "match the whole line" implementation would have: with
    // `allow show` first, `show version; reboot` would match the allow and the
    // reboot would never be classified. Segments are classified independently and
    // the line takes the most restrictive outcome.
    const mixed = rulesOnly([
      rule('reads', 'allow', 'show'),
      rule('restart', 'ask', 'reboot|restart', 'restarts'),
    ])
    const chained = classifyCommand('show version; reboot', mixed)
    expect(chained.action).toBe('ask')
    expect(chained.matchedSegment).toBe('reboot')

    const anded = classifyCommand('show version && reboot', mixed)
    expect(anded.action).toBe('ask')

    // And a deny anywhere in the line wins over everything.
    const withDeny = rulesOnly([
      rule('reads', 'allow', 'show'),
      rule('never', 'deny', 'format', 'destroys data'),
    ])
    expect(classifyCommand('show version; format flash:', withDeny).action).toBe('deny')
    // Two segments that are both fine stay fine.
    expect(classifyCommand('show version; show clock', withDeny).action).toBe('allow')
  })

  it('treats `always` as the FALLBACK, so a rule can still carve an exception', () => {
    const strict = rulesOnly([rule('reads', 'allow', 'show')], 'always')
    expect(classifyCommand('show version', strict).action).toBe('allow')
    // Everything else still asks, which is what `always` is for.
    expect(classifyCommand('reboot', strict).action).toBe('ask')
    expect(classifyCommand('some unknown command', strict).action).toBe('ask')
  })

  it('still honours the legacy pattern field, after the ordered rules', () => {
    // A document written before rules existed must not lose its fence: dropping
    // it would be a security regression performed by an upgrade.
    const inherited: ConsoleFenceSettings = {
      approvalMode: 'high-risk',
      fenceRules: [],
      highRiskPatterns: ['config|conf|configure'],
    }
    expect(classifyCommand('conf t', inherited).action).toBe('ask')
    expect(classifyCommand('conf t', inherited).matchedSource).toBe('legacy:0')
    // An explicit rule can supersede an inherited one, by allow or by deny.
    const superseded: ConsoleFenceSettings = {
      approvalMode: 'high-risk',
      fenceRules: [rule('trusted', 'allow', 'conf', 'trusted operator')],
      highRiskPatterns: ['config|conf|configure'],
    }
    expect(classifyCommand('conf t', superseded).action).toBe('allow')
  })

  it('defaults to the shipped rules when a policy states none', () => {
    // A hand-composed policy with no `fenceRules` must fence the dangerous
    // commands rather than silently fencing nothing.
    const bare: ConsoleFenceSettings = { approvalMode: 'high-risk' }
    expect(classifyCommand('configuration rollback replace X', bare).action).toBe('ask')
    expect(fenceRulesOf(bare).map(rule => rule.id)).toContain('config-rollback')
  })

  it('matches a rule by token PREFIX, and needs every token it declares', () => {
    const rollback = rule('r', 'ask', 'configuration rollback')
    expect(matchesFenceRule('conf roll', rollback)).toBe(true)
    expect(matchesFenceRule('configuration rollback replace X', rollback)).toBe(true)
    // One token short: this is what keeps bare `conf` out of the rule.
    expect(matchesFenceRule('configuration', rollback)).toBe(false)
    expect(matchesFenceRule('conf', rollback)).toBe(false)
    // Wrong token at the second position.
    expect(matchesFenceRule('conf undo', rollback)).toBe(false)
    // Not the first token at all.
    expect(matchesFenceRule('show conf roll', rollback)).toBe(false)
  })

  it('matches nothing for a malformed or empty rule instead of throwing', () => {
    // Defence in depth. The schema refuses these at the WRITE, but the engine
    // must stay total anyway: a fence that throws is a fence that is not
    // enforcing, so an unusable rule is inert rather than fatal. The casts stand
    // in for "a rule that reached the runtime despite the schema".
    const malformed = { id: 'a', action: 'ask', tokens: '', pattern: '(', note: '' } as ConsoleFenceRule
    const empty = { id: 'b', action: 'ask', tokens: '', pattern: '', note: '' } as ConsoleFenceRule
    const blank = { id: 'c', action: 'ask', tokens: '   ', pattern: '', note: '' } as ConsoleFenceRule
    expect(matchesFenceRule('anything', malformed)).toBe(false)
    expect(matchesFenceRule('anything', empty)).toBe(false)
    expect(matchesFenceRule('anything', blank)).toBe(false)
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

  it('refuses a DENIED rule without asking, even when the answerer would allow', async () => {
    // The hard block. A `deny` that still raised a prompt would be a rule asking
    // the human to override a policy that exists to be un-overridable -- and an
    // approval UI that says "allow once" would release it in one click.
    const approval = fakeApproval('allowed-once')
    const deny = rulesOnly([patternRule('never-erase', 'deny', 'erase', 'wipes the config')])
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'SW1', command: 'erase startup-config' },
      { policy: deny, approver: approval },
    )
    expect(result.approved).toBe(false)
    // THE assertion: the question was never asked.
    expect(approval.asks).toHaveLength(0)
    expect(result.classification.action).toBe('deny')
    // The refusal names the rule, so the operator knows which one to edit.
    expect(result.reason).toContain('never-erase')
    expect(result.reason).toMatch(/cannot be approved/i)
  })

  it('refuses a denied rule even with NO approver, naming the rule not the missing seam', async () => {
    // Order matters: checking the approver first would report "no approval
    // service is composed" for a command that no approval could have released.
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'SW1', command: 'erase startup-config' },
      {
        policy: rulesOnly([patternRule('never-erase', 'deny', 'erase', 'wipes the config')]),
        approver: undefined,
      },
    )
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('never-erase')
    expect(result.reason).not.toMatch(/no approval service/i)
  })

  it('refuses a denied command hidden behind an allowed first segment', async () => {
    // A compound line must not smuggle a denied command past the block.
    const approval = fakeApproval('allowed-once')
    const mixed = rulesOnly([
      rule('reads', 'allow', 'show'),
      rule('never-erase', 'deny', 'erase', 'wipes the config'),
    ])
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'SW1', command: 'show version; erase startup-config' },
      { policy: mixed, approver: approval },
    )
    expect(result.approved).toBe(false)
    expect(approval.asks).toHaveLength(0)
  })

  it('names the rule and its note in the ask, so the human decides on facts', async () => {
    const approval = fakeApproval('allowed-once')
    const result = await approveConsoleCommand(
      { exec: exec(), consoleLabel: 'SW1', command: 'configuration rollback replace BasicConfig' },
      { policy: rulesOnly([...DEFAULT_FENCE_RULES]), approver: approval },
    )
    expect(result.approved).toBe(true)
    expect(approval.asks).toHaveLength(1)
    // The reported command, and WHY it is fenced.
    expect(approval.asks[0]?.reason).toContain('configuration rollback replace BasicConfig')
    expect(approval.asks[0]?.reason).toMatch(/replaces the running configuration/i)
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
