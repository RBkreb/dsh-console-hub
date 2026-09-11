/**
 * dsh-console-hub — host half.
 *
 * Manages network-device console mappings (Telnet / Raw TCP console servers):
 * device views with credentials kept in the credential seam, per-session
 * console connections with paging-aware reads, the plugin's fenced JSON API
 * for the sidebar tab, and the model-facing `console_*` tools.
 *
 * The browser half ships separately through package.json's `dsh.client`
 * declaration and `exports["./client"]`; it registers the sidebar tab through
 * the `betterSidebar` service.
 *
 * @module dsh-console-hub
 */

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-console-hub'

/** Host plugin body — capability registration lands here as the plugin grows. */
export function apply(): void {}
