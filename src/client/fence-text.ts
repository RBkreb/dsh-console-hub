/**
 * The fence-rule TEXT FORMAT, shared by the settings editor and its tests.
 *
 * The rules live in the host settings document, but a settings panel is not a
 * structured form: the operator wants a large text box they can type into. So
 * the rules round-trip through a line-per-rule text form whose whole job is to be
 * obvious to a human and lossless for the engine.
 *
 * ```
 * # 每行一条规则，自上而下第一条命中生效
 * ask  configuration rollback      # 用保存的配置覆盖运行配置
 * deny re:erase\s+startup-config   # 抹掉已保存的配置
 * allow show|display
 * ```
 *
 * Three properties the format has to hold, each of which is a test:
 *
 * 1. **Lossless.** `parseFenceRules(formatFenceRules(rules))` returns the rules
 *    unchanged, so opening the editor and pressing save without typing anything
 *    cannot silently rewrite the policy.
 * 2. **Readable.** A rule's action and matcher are the first two things on the
 *    line, and the note is a trailing comment.
 * 3. **Total.** Malformed input produces a per-line error rather than throwing,
 *    so the editor can point at the offending line instead of discarding the
 *    operator's work.
 *
 * @module dsh-console-hub/client/fence-text
 */
import { FENCE_ACTIONS, type ConsoleFenceRule, type FenceAction } from '../config-shared.ts'

/** The prefix that marks a matcher as a raw regular expression. */
export const PATTERN_PREFIX = 're:'

/**
 * The placeholder shown for a rule's note when the parsed line carried none.
 *
 * Not empty: the schema allows an empty note, but a blank tail makes a rule look
 * truncated in the box, and the approval prompt reads better with the action
 * spelled out when the author supplied nothing.
 */
export function defaultNote(action: FenceAction): string {
  return action === 'deny'
    ? '已被规则禁止，任何审批都无法放行'
    : action === 'ask'
      ? '需要一次人工确认'
      : '显式放行'
}

/** One parsed line's outcome. */
export type FenceTextLine =
  | { kind: 'rule', line: number, rule: ConsoleFenceRule }
  | { kind: 'comment', line: number }
  | { kind: 'error', line: number, text: string, message: string }

/** Serialize one rule as its line. */
export function formatFenceRule(rule: ConsoleFenceRule): string {
  const matcher = rule.pattern !== '' ? `${PATTERN_PREFIX}${rule.pattern}` : rule.tokens
  const note = rule.note.trim() === '' ? '' : `   # ${rule.note.trim()}`
  return `${rule.action} ${matcher}${note}`
}

/** Serialize the whole rule list, one rule per line. */
export function formatFenceRules(rules: readonly ConsoleFenceRule[]): string {
  return rules.map(formatFenceRule).join('\n')
}

/**
 * Split a note off a line body.
 *
 * A `#` only starts a note when whitespace precedes it, so a regex may contain
 * one (`re:a#b`) without needing an escape hatch nobody would remember.
 *
 * @param body - the line with its leading action already removed.
 * @returns the matcher text and the note (empty when there was none).
 */
function splitNote(body: string): { matcher: string, note: string } {
  const found = /\s#\s?/.exec(body)
  if (found === null) return { matcher: body.trim(), note: '' }
  return {
    matcher: body.slice(0, found.index).trim(),
    note: body.slice(found.index + found[0].length).trim(),
  }
}

/**
 * Parse the editor's text into rules, reporting each bad line.
 *
 * Never throws: the caller shows the errors and keeps the operator's text.
 *
 * @param source - the text box's contents.
 * @returns the parsed rules (only when there are no errors) and every line outcome.
 */
export function parseFenceRules(source: string): {
  rules: ConsoleFenceRule[]
  lines: FenceTextLine[]
  errors: Array<{ line: number, text: string, message: string }>
} {
  const lines: FenceTextLine[] = []
  const errors: Array<{ line: number, text: string, message: string }> = []
  const rules: ConsoleFenceRule[] = []

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const text = raw.trim()
    if (text === '' || text.startsWith('#')) {
      lines.push({ kind: 'comment', line })
      return
    }
    const space = text.search(/\s/)
    const action = (space === -1 ? text : text.slice(0, space)).toLowerCase()
    const body = space === -1 ? '' : text.slice(space + 1)
    if (!(FENCE_ACTIONS as readonly string[]).includes(action)) {
      const message = `动作必须是 ${FENCE_ACTIONS.join(' / ')}（读到 "${action}"）`
      lines.push({ kind: 'error', line, text, message })
      errors.push({ line, text, message })
      return
    }
    const { matcher, note } = splitNote(body)
    if (matcher === '') {
      const message = '缺少匹配器：写词序列（如 configuration rollback），或以 re: 开头的正则'
      lines.push({ kind: 'error', line, text, message })
      errors.push({ line, text, message })
      return
    }
    const asAction = action as FenceAction
    const isPattern = matcher.startsWith(PATTERN_PREFIX)
    // The emptiness check belongs to the PATTERN branch alone. A token rule has
    // an empty `pattern` by design, so testing `pattern === ''` after the branch
    // would reject every token rule the operator writes -- which is exactly what
    // it did.
    const pattern = isPattern ? matcher.slice(PATTERN_PREFIX.length).trim() : ''
    if (isPattern && pattern === '') {
      const message = `"${PATTERN_PREFIX}" 后面没有正则内容`
      lines.push({ kind: 'error', line, text, message })
      errors.push({ line, text, message })
      return
    }
    const rule: ConsoleFenceRule = {
      id: '',
      action: asAction,
      tokens: isPattern ? '' : matcher,
      pattern,
      note: note === '' ? defaultNote(asAction) : note,
    }
    rules.push(rule)
    lines.push({ kind: 'rule', line, rule })
  })

  return { rules, lines, errors }
}

/**
 * A stable, readable rule id derived from what the rule DOES.
 *
 * Ids appear in approval prompts and the audit trail, so they have to be
 * meaningful to whoever reads them and stable across saves. Deriving beats
 * numbering: `rule-3` changes meaning the moment a line is inserted, whereas
 * `ask-configuration-rollback` still describes the rule it names.
 *
 * @param rule - the rule to name.
 * @param taken - ids already in use, so a collision gets a suffix.
 * @returns the id to store.
 */
export function deriveRuleId(rule: ConsoleFenceRule, taken: ReadonlySet<string>): string {
  const source = rule.tokens !== '' ? rule.tokens : rule.pattern
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const base = `${rule.action}-${slug === '' ? 'rule' : slug}`
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`
    if (!taken.has(candidate)) return candidate
  }
  return base
}

/**
 * Give every parsed rule an id, REUSING the existing id when the rule did not
 * actually change.
 *
 * Without this, saving the box would rename every rule (derived ids differ from
 * any hand-written ones), and every audit entry written before the save would
 * point at a name that no longer exists. Matching on action + matcher + note is
 * what makes the editor non-destructive for rules the operator did not touch.
 *
 * @param rules - the parsed rules, with empty ids.
 * @param existing - the rules currently stored.
 * @returns rules carrying ids.
 */
export function assignRuleIds(
  rules: readonly ConsoleFenceRule[],
  existing: readonly ConsoleFenceRule[],
): ConsoleFenceRule[] {
  const taken = new Set<string>()
  const used = new Set<number>()
  return rules.map((rule) => {
    const match = existing.findIndex((candidate, index) => !used.has(index)
      && candidate.action === rule.action
      && candidate.tokens === rule.tokens
      && candidate.pattern === rule.pattern
      && candidate.note === rule.note)
    if (match !== -1) {
      used.add(match)
      const id = (existing[match] as ConsoleFenceRule).id
      if (!taken.has(id)) {
        taken.add(id)
        return { ...rule, id }
      }
    }
    const id = deriveRuleId(rule, taken)
    taken.add(id)
    return { ...rule, id }
  })
}
