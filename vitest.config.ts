import { defineConfig } from 'vitest/config'

/**
 * The live-lab suite dials real devices on the lab network, so it is opt-in
 * through `DSH_CONSOLE_LIVE=1`. The exclusion is applied here rather than
 * unconditionally because vitest cannot re-include a file that the config
 * excludes — a CLI filter only narrows the included set, so an unconditional
 * exclusion would make the suite impossible to run at all.
 */
const live = process.env.DSH_CONSOLE_LIVE === '1'

export default defineConfig({
  test: {
    // Worker pool: the default `forks` pool spawns each worker with piped
    // stdio, which a confined harness refuses with `EPERM` — no test ever
    // runs. Threads need no extra process, so the suite works both inside the
    // sandbox and on a normal machine.
    pool: 'threads',
    // Host-half suites (net, http, credentials) run on node. Browser-half
    // suites opt into jsdom per file with a `// @vitest-environment jsdom`
    // docblock, so host suites never pay for a DOM.
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/lib/**',
      ...live ? [] : ['tests/live/**'],
    ],
  },
})
