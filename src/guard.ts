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
import { compileCommandFence, DEFAULT_HIGH_RISK_PATTERNS } from './config-shared.ts'
import type { ConsoleApprovalService, ConsoleToolRunContext } from './context-types.ts'

/** The default fence sources, re-exported for callers that seed a policy. */
export const DEFAULT_FENCE_SOURCES: readonly string[] = [...DEFAULT_HIGH_RISK_PATTERNS]

/** The fence policy a classification runs against. */
export interface ConsoleFenceSettings {
  /** `always` fences every command; `high-risk` only the listed patterns. */
  approvalMode: 'always' | 'high-risk'
  /** Pattern sources, each anchored at the command start. */
  highRiskPatterns: readonly string[]
}

/** Why one command was classified the way it was. */
export interface ConsoleCommandClassification {
  /** `high` requires an explicit human decision; `safe` may run. */
  risk: 'high' | 'safe'
  /** The pattern source that matched, or `approvalMode:always`. */
  matchedSource?: string
  /** The command segment that matched (compound lines are split first). */
  matchedSegment?: string
  /** Every segment the line was split into, for diagnostics. */
  segments: readonly string[]
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

/**
 * Classify one command line against a fence policy.
 * @param command - the raw line the model or the panel wants to send.
 * @param settings - the active fence policy.
 * @returns the classification, including which segment and source matched.
 * @throws {SyntaxError} when a configured pattern source is malformed.
 */
export function classifyCommand(command: string, settings: ConsoleFenceSettings): ConsoleCommandClassification {
  const segments = commandSegments(command)
  if (segments.length === 0) {
    // Nothing to run: an empty write must not present an approval prompt.
    return { risk: 'safe', segments }
  }

  if (settings.approvalMode === 'always') {
    return {
      risk: 'high',
      matchedSource: 'approvalMode:always',
      matchedSegment: segments[0],
      segments,
    }
  }

  const matchers = settings.highRiskPatterns.map(source => ({ source, pattern: compileCommandFence(source) }))
  for (const segment of segments) {
    for (const { source, pattern } of matchers) {
      if (pattern.test(segment)) {
        return { risk: 'high', matchedSource: source, matchedSegment: segment, segments }
      }
    }
  }
  return { risk: 'safe', segments }
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
 * A safe command is approved without asking. A fenced command is approved ONLY
 * on `allowed-once`; every other outcome — a rejection, a cancellation, an
 * absent answerer, an absent service, a missing agent, or a thrown approver —
 * refuses. That is the whole fail-closed rule, and it lives here rather than at
 * each call site.
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
  if (classification.risk === 'safe') return { approved: true, classification }

  const segment = classification.matchedSegment ?? request.command
  const why = classification.matchedSource === 'approvalMode:always'
    ? 'every command requires approval (approvalMode "always")'
    : `"${segment}" matches the high-risk pattern "${classification.matchedSource ?? ''}"`

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
