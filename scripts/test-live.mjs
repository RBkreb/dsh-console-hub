/**
 * Run the live-lab suite against the real devices.
 *
 * `vitest.config.ts` excludes `tests/live/**` unless `DSH_CONSOLE_LIVE=1` is
 * already set in the environment, and a config exclusion cannot be undone from
 * the command line — so the variable must be set BEFORE vitest loads its
 * config, which is what this launcher is for (it avoids a shell-specific
 * `VAR=1 cmd` form that does not work on Windows).
 *
 * The lab devices are not always reachable; a failure here is a statement about
 * the network or the device, not about the engine.
 */
import { spawn } from 'node:child_process'

const child = spawn(
  process.execPath,
  ['--import', './scripts/test-preload.mjs', './node_modules/vitest/vitest.mjs', 'run', 'tests/live'],
  {
    stdio: 'inherit',
    env: { ...process.env, DSH_CONSOLE_LIVE: '1' },
  },
)

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[test:live] terminated by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
