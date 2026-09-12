/**
 * The high-risk command fence.
 *
 * Two questions, deliberately separate:
 *
 * 1. {@link classifyCommand} — is this command dangerous? Pure and synchronous,
 *    so it can be shown, tested, and reasoned about without an agent.
 * 2. {@link approveConsoleCommand} — may it proceed? That is a human decision,
 *    asked through the approval seam and FAILING CLOSED on every non-grant.
 *
 * The fence is a guard-rail, not a sandbox: a device CLI usually accepts
 * abbreviations the pattern cannot enumerate (`conf`, `reb<tab>`), so the
 * README says so and deployments are expected to restrict the device account
 * too.
 *
 * `config`/`restart` are the defaults because they are the two commands that
 * change how a device behaves and are hardest to undo from a console: entering
 * configuration mode, and restarting the box.
 *
 * @module dsh-console-hub/guard
 */
import { compileCommandFence, DEFAULT_FENCE_RULES, DEFAULT_HIGH_RISK_PATTERNS, matchesFenceRule, type ConsoleFenceRule, type FenceAction } from './config-shared.ts'
import type { ConsoleApprovalService, ConsoleToolRunContext } from './context-types.ts'

/** The default fence sources, re-exported for callers that seed a policy. */
export const DEFAULT_FENCE_SOURCES: readonly string[] = [...DEFAULT_HIGH_RISK_PATTERNS]

/** The fence policy a classification runs against. */
export interface ConsoleFenceSettings {
  /**
   * What happens when no rule matches. Rules are the policy; this is the floor
   * beneath them.
   */
  approvalMode: 'always' | 'high-risk'
  /**
   * The ordered rules. First match wins.
   *
   * Absent means "the shipped defaults", so a policy composed by hand still
   * fences the dangerous commands rather than silently fencing nothing.
   */
  fenceRules?: readonly ConsoleFenceRule[]
  /**
   * LEGACY patterns, evaluated as `ask` rules after the ordered ones. Absent
   * means "none", NOT "the shipped defaults": this field exists so a document
   * that predates rules keeps the fence it was written with.
   */
  highRiskPatterns?: readonly string[]
}

/** Why one command was classified the way it was. */
export interface ConsoleCommandClassification {
  /** `high` requires an explicit human decision; `safe` may run. */
  risk: 'high' | 'safe'
  /**
   * What the matched rule decided. `deny` is the hard block: it never asks, so
   * no approval can release it.
   *
   * Deliberately separate from `risk`: a `deny` and an `ask` are both "not
   * safe", but a caller that treated them the same would offer an approval
   * prompt for a command that must never run.
   */
  action: FenceAction
  /** The rule id that matched, or `approvalMode:always` for the fallback. */
  matchedSource?: string
  /** The human explanation from the matched rule. */
  matchedNote?: string
  /** The command segment that matched (compound lines are split first). */
  matchedSegment?: string
  /** Every segment the line was split into, for diagnostics. */
  segments: readonly string[]
}

/** The rules a policy evaluates, in order, with the legacy field appended. */
export function fenceRulesOf(settings: ConsoleFenceSettings): ConsoleFenceRule[] {
  const explicit = settings.fenceRules === undefined
    ? [...DEFAULT_FENCE_RULES]
    : [...settings.fenceRules]
  // Legacy patterns come LAST so an explicit rule can supersede one -- including
  // by `allow`, which is the only way to release a command an inherited document
  // fences.
  const legacy = (settings.highRiskPatterns ?? []).map((source, index) => ({
    id: `legacy:${String(index)}`,
    action: 'ask' as const,
    tokens: '',
    pattern: source,
    note: `matches the legacy high-risk pattern "${source}"`,
  }))
  return [...explicit, ...legacy]
}

/**
 * Compile a fence source into anchored matchers.
 * @param source - the pattern source.
 * @returns one matcher per alternative, all anchored at the command start.
 * @throws {SyntaxError} when the source is not a valid regular expression.
 */
export function compileFence(source: string): RegExp[] {
  // Compile once to surface a malformed source immediately, then keep the
  // single anchored matcher: callers only need "does any alternative match".
  return [compileCommandFence(source)]
}

/**
 * Split one console line into the commands a device would run.
 *
 * `;`, `&&`, and a newline separate commands. A separator inside a quoted
 * string is data (a `banner motd "a;b"`), so quotes are tracked: splitting there
 * would both misclassify and mis-report what was actually sent.
 *
 * @param line - the raw command line.
 * @returns the trimmed non-empty segments, in order.
 */
export function commandSegments(line: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === '&' && line[index + 1] === '&') {
      segments.push(current)
      current = ''
      index += 1
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(segment => segment !== '')
}

/** How restrictive each action is, so a compound line can be combined safely. */
const SEVERITY: Record<FenceAction, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Classify one command line against a fence policy.
 *
 * The line is split into the commands a device would actually run, and EACH
 * segment is classified on its own: rules in order, first match wins, and the
 * fallback (`approvalMode`) when none matches. The line's outcome is then the
 * MOST RESTRICTIVE segment.
 *
 * Per-segment classification with a most-restrictive combination is the whole
 * safety argument for compound lines. Evaluating the line as a whole lets a
 * single `allow` rule swallow everything after it — with a `show` allowed and
 * rules checked in order, `show version; reboot` would match `allow show`, return
 * safe, and the `reboot` would never be looked at. Splitting first means the
 * `reboot` segment is classified whatever the first segment decided.
 *
 * @param command - the raw line the model or the panel wants to send.
 * @param settings - the active fence policy.
 * @returns the classification, including which segment and rule decided it.
 */
export function classifyCommand(command: string, settings: ConsoleFenceSettings): ConsoleCommandClassification {
  const segments = commandSegments(command)
  if (segments.length === 0) {
    // Nothing to run: an empty write must not present an approval prompt.
    return { risk: 'safe', action: 'allow', segments }
  }

  const rules = fenceRulesOf(settings)
  const fallback: FenceAction = settings.approvalMode === 'always' ? 'ask' : 'allow'

  let decision: { action: FenceAction, segment: string, rule?: ConsoleFenceRule } | undefined
  for (const segment of segments) {
    const matched = rules.find(rule => matchesFenceRule(segment, rule))
    const action = matched === undefined ? fallback : matched.action
    if (decision === undefined || SEVERITY[action] > SEVERITY[decision.action]) {
      decision = { action, segment, ...matched === undefined ? {} : { rule: matched } }
      // nothing can outrank a deny, so stop as soon as one is found
      if (action === 'deny') break
    }
  }

  const settled = decision as { action: FenceAction, segment: string, rule?: ConsoleFenceRule }
  return {
    risk: settled.action === 'allow' ? 'safe' : 'high',
    action: settled.action,
    ...settled.rule === undefined
      ? { matchedSource: `approvalMode:${settings.approvalMode}` }
      : { matchedSource: settled.rule.id, matchedNote: settled.rule.note },
    matchedSegment: settled.segment,
    segments,
  }
}

/**
 * Whether one command line needs an explicit human decision.
 * @param command - the raw command line.
 * @param settings - the active fence policy.
 * @returns true when the command is fenced.
 */
export function isHighRisk(command: string, settings: ConsoleFenceSettings): boolean {
  return classifyCommand(command, settings).risk === 'high'
}

/** One command about to be written to a device. */
export interface ConsoleApprovalRequest {
  /** The tool execution asking (carries the agent, the call id, and the signal). */
  exec: ConsoleToolRunContext
  /** The device label, so the prompt names the right device. */
  consoleLabel: string
  /** The full command line. */
  command: string
}

/** The dependencies an approval decision needs. */
export interface ConsoleApprovalDeps {
  /** The active fence policy. */
  policy: ConsoleFenceSettings
  /** The approval seam, or `undefined` when none is composed. */
  approver: ConsoleApprovalService | undefined
}

/** The outcome of asking. */
export interface ConsoleApprovalResult {
  /** Whether the command may be written. */
  approved: boolean
  /** When refused, why — surfaced verbatim to the model and the user. */
  reason?: string
  /** What the fence saw, so a caller can record it. */
  classification: ConsoleCommandClassification
}

/**
 * Decide whether one command may be written.
 *
 * Three outcomes, in this order:
 *
 * 1. `allow` — approved without asking.
 * 2. `deny` — refused, and the approval seam is NOT consulted. A `deny` rule
 *    that still raised a prompt would be a rule that asks the human to override
 *    a policy that exists to be un-overridable.
 * 3. `ask` — approved ONLY on `allowed-once`; every other outcome (a rejection,
 *    a cancellation, an absent answerer, an absent service, a missing agent, or
 *    a thrown approver) refuses. That is the whole fail-closed rule, and it
 *    lives here rather than at each call site.
 *
 * @param request - the command and the execution asking.
 * @param deps - the policy and the approval seam.
 * @returns the decision, with the classification that produced it.
 */
export async function approveConsoleCommand(
  request: ConsoleApprovalRequest,
  deps: ConsoleApprovalDeps,
): Promise<ConsoleApprovalResult> {
  const classification = classifyCommand(request.command, deps.policy)
  if (classification.action === 'allow') return { approved: true, classification }

  const segment = classification.matchedSegment ?? request.command
  const why = classification.matchedNote === undefined
    ? 'every command requires approval (approvalMode "always")'
    : `"${segment}" ${classification.matchedNote}`

  // The hard block. Checked BEFORE the approver so no approval channel, however
  // configured, can release it -- and so a deployment with no approver gets the
  // real reason (the rule) rather than "no approval service is composed".
  if (classification.action === 'deny') {
    return {
      approved: false,
      reason: `refusing to run ${why} on "${request.consoleLabel}": a "deny" rule forbids it `
        + `(rule "${classification.matchedSource ?? ''}"); this cannot be approved`,
      classification,
    }
  }

  if (deps.approver === undefined) {
    return {
      approved: false,
      reason: `refusing to run ${why} on "${request.consoleLabel}", but no approval service is composed`,
      classification,
    }
  }

  const agent = request.exec.agent
  if (agent === undefined) {
    return {
      approved: false,
      reason: `refusing to run ${why} on "${request.consoleLabel}", but the call has no agent to route approval through`,
      classification,
    }
  }

  let outcome: string
  try {
    outcome = await deps.approver.request({
      agent,
      toolName: 'console_send',
      callId: request.exec.callId,
      // Self-contained for the audit trail: device, exact command, and why the
      // fence fired, so the human decides on facts.
      reason: `run a high-risk console command on "${request.consoleLabel}": ${request.command} (${why})`,
      signal: request.exec.signal,
    })
  } catch (error) {
    return {
      approved: false,
      reason: `refusing to run ${why} on "${request.consoleLabel}": the approval request failed `
        + `(${error instanceof Error ? error.message : String(error)})`,
      classification,
    }
  }

  if (outcome === 'allowed-once') return { approved: true, classification }
  const explanation = outcome === 'rejected'
    ? 'the user rejected it'
    : outcome === 'cancelled'
      ? 'the approval request was cancelled'
      : 'no approval channel is available'
  return {
    approved: false,
    reason: `refusing to run ${why} on "${request.consoleLabel}": ${explanation}`,
    classification,
  }
}
