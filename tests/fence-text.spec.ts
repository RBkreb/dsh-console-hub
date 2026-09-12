/**
 * The fence-rule text format: the settings editor's round trip.
 *
 * The property under test is LOSSLESSNESS. The operator edits a text box and
 * presses save; if the format dropped or reshaped a field on the way through, the
 * policy would change without anyone touching a rule -- and a fence that quietly
 * weakens itself is worse than one that is merely hard to edit.
 */
import { describe, expect, it } from 'vitest'
import {
  assignRuleIds,
  defaultNote,
  deriveRuleId,
  formatFenceRule,
  formatFenceRules,
  parseFenceRules,
} from '../src/client/fence-text.ts'
import type { ConsoleFenceRule } from '../src/config-shared.ts'

/** A rule with both matcher fields stated, as the schema produces. */
function rule(
  id: string,
  action: ConsoleFenceRule['action'],
  tokens: string,
  pattern = '',
  note = 'a note',
): ConsoleFenceRule {
  return { id, action, tokens, pattern, note }
}

describe('fence rule text format', () => {
  it('round-trips every field a rule can carry', () => {
    const rules = [
      rule('config-rollback', 'ask', 'configuration rollback', '', '覆盖运行配置'),
      rule('no-erase', 'deny', '', 'erase\\s+startup-config', '抹掉已保存的配置'),
      rule('reads', 'allow', 'show|display', '', '只读'),
    ]
    const parsed = parseFenceRules(formatFenceRules(rules))
    expect(parsed.errors).toEqual([])
    // Ids are NOT part of the text (they are derived on save), so they are
    // compared field by field rather than wholesale.
    expect(parsed.rules.map(entry => [entry.action, entry.tokens, entry.pattern, entry.note]))
      .toEqual(rules.map(entry => [entry.action, entry.tokens, entry.pattern, entry.note]))
  })

  it('marks a raw regex with re: so it cannot be read as a token list', () => {
    const pattern = rule('p', 'deny', '', 'erase\\s+startup-config', 'note')
    expect(formatFenceRule(pattern)).toBe('deny re:erase\\s+startup-config   # note')
    const tokens = rule('t', 'ask', 'configuration rollback', '', 'note')
    expect(formatFenceRule(tokens)).toBe('ask configuration rollback   # note')
  })

  it('keeps a note that itself contains a # or spaces', () => {
    const withHash = rule('h', 'ask', 'reboot', '', 'i.e. #1 restart path')
    const parsed = parseFenceRules(formatFenceRules([withHash]))
    expect(parsed.rules[0]?.note).toBe('i.e. #1 restart path')
    expect(parsed.rules[0]?.tokens).toBe('reboot')
  })

  it('splits the note only at a # that follows whitespace', () => {
    // A regex may legitimately contain a #; requiring whitespace before the
    // separator means it does not need an escape hatch nobody would remember.
    const parsed = parseFenceRules('deny re:erase#1   # 说明')
    expect(parsed.errors).toEqual([])
    expect(parsed.rules[0]?.pattern).toBe('erase#1')
    expect(parsed.rules[0]?.note).toBe('说明')
  })

  it('ignores blank lines and comments, so the box can be annotated', () => {
    const parsed = parseFenceRules([
      '# 这是注释',
      '',
      '   ',
      'ask reboot   # 重启',
      '# 末尾注释',
    ].join('\n'))
    expect(parsed.errors).toEqual([])
    expect(parsed.rules).toHaveLength(1)
    expect(parsed.lines.filter(entry => entry.kind === 'comment')).toHaveLength(4)
  })

  it('reports a bad action by line number instead of throwing', () => {
    const parsed = parseFenceRules(['ask reboot', 'block erase'].join('\n'))
    expect(parsed.rules).toHaveLength(1)
    expect(parsed.errors).toEqual([
      { line: 2, text: 'block erase', message: expect.stringContaining('动作必须是') as unknown as string },
    ])
  })

  it('reports a missing matcher by line number', () => {
    // A rule with no matcher would match nothing. The engine's schema refuses it;
    // catching it here means the operator is told which line, before a round trip
    // to the host.
    for (const source of ['ask', 'deny   ', 'allow']) {
      const parsed = parseFenceRules(source)
      expect(parsed.rules).toEqual([])
      expect(parsed.errors[0]?.message).toMatch(/缺少匹配器/)
    }
  })

  it('reports an empty regex after the re: prefix', () => {
    const parsed = parseFenceRules('deny re:   ')
    expect(parsed.rules).toEqual([])
    expect(parsed.errors[0]?.message).toMatch(/没有正则内容/)
  })

  it('is case-insensitive about the action without rewriting the matcher', () => {
    const parsed = parseFenceRules('ASK Reboot')
    expect(parsed.errors).toEqual([])
    expect(parsed.rules[0]?.action).toBe('ask')
    // The matcher keeps its case: a device CLI is case-insensitive, but the
    // token may be part of a regex where case is the author's choice.
    expect(parsed.rules[0]?.tokens).toBe('Reboot')
  })

  it('supplies a note when the line carried none, naming the action', () => {
    // An empty note reads as a truncated rule in the box, and the approval prompt
    // is better with the action spelled out than with nothing.
    for (const action of ['deny', 'ask', 'allow'] as const) {
      const parsed = parseFenceRules(`${action} reboot`)
      expect(parsed.rules[0]?.note).toBe(defaultNote(action))
      expect(parsed.rules[0]?.note).not.toBe('')
    }
  })
})

describe('fence rule ids', () => {
  it('derives a readable id from what the rule does', () => {
    expect(deriveRuleId(rule('', 'ask', 'configuration rollback'), new Set()))
      .toBe('ask-configuration-rollback')
    expect(deriveRuleId(rule('', 'deny', '', 'erase\\s+startup-config'), new Set()))
      .toBe('deny-erase-s-startup-config')
  })

  it('suffixes a collision instead of reusing an id', () => {
    // Two rules sharing an id would make an audit trail ambiguous about which one
    // fired, which is the one thing the id exists for.
    const taken = new Set(['ask-reboot'])
    expect(deriveRuleId(rule('', 'ask', 'reboot'), taken)).toBe('ask-reboot-2')
    expect(deriveRuleId(rule('', 'ask', 'reboot'), new Set([...taken, 'ask-reboot-2']))).toBe('ask-reboot-3')
  })

  it('REUSES the existing id when the rule did not actually change', () => {
    // The property that makes the editor non-destructive. Ids appear in approval
    // prompts and audit entries; re-deriving them on every save would rename rules
    // an operator only meant to look at, orphaning every earlier reference.
    const existing = [rule('hand-written-name', 'ask', 'configuration rollback', '', '覆盖运行配置')]
    const parsed = parseFenceRules('ask configuration rollback   # 覆盖运行配置')
    const assigned = assignRuleIds(parsed.rules, existing)
    expect(assigned[0]?.id).toBe('hand-written-name')
  })

  it('derives a fresh id for a rule that DID change, keeping the others intact', () => {
    const existing = [
      rule('keep-me', 'ask', 'configuration rollback', '', '覆盖运行配置'),
      rule('old-reboot', 'ask', 'reboot', '', '重启设备'),
    ]
    const parsed = parseFenceRules([
      'ask configuration rollback   # 覆盖运行配置',
      'deny reboot   # 重启设备',
    ].join('\n'))
    const assigned = assignRuleIds(parsed.rules, existing)
    expect(assigned[0]?.id).toBe('keep-me')
    // The action changed, so this is a different rule and must not inherit the id.
    expect(assigned[1]?.id).toBe('deny-reboot')
  })

  it('keeps every id unique even when a derived one collides with a reused one', () => {
    const existing = [rule('ask-reboot', 'ask', 'reboot', '', '重启设备')]
    const parsed = parseFenceRules(['ask reboot   # 重启设备', 'ask reboot   # 另一条'].join('\n'))
    const assigned = assignRuleIds(parsed.rules, existing)
    expect(assigned[0]?.id).toBe('ask-reboot')
    expect(assigned[1]?.id).toBe('ask-reboot-2')
    expect(new Set(assigned.map(entry => entry.id)).size).toBe(2)
  })
})
