import { defineConfig } from 'vitest/config'

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
    // Live-lab suites talk to real consoles and are opt-in
    // (DSH_CONSOLE_LIVE=1); they are excluded from the default run.
    exclude: [
      '**/node_modules/**',
      '**/lib/**',
      'tests/live/**',
    ],
  },
})
