/**
 * The polling decision, kept out of `hub.ts` so the console view can import it
 * without a cycle (`hub.ts` imports the view, the view needs this predicate).
 *
 * @module dsh-console-hub/client/poll
 */

/**
 * Whether the console view should be polling for new output right now.
 *
 * The shell keeps a hidden tab mounted, so polling is gated on `visible` rather
 * than on mount — otherwise every device console in every background tab keeps
 * hitting the host.
 *
 * @param state - the tab's visibility and the selected console.
 * @returns true when a poll should be scheduled.
 */
export function shouldPoll(state: { visible: boolean, consoleId?: string }): boolean {
  return state.visible && state.consoleId !== undefined && state.consoleId !== ''
}
