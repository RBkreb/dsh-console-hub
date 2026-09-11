/**
 * Node preload (`node --import ./scripts/test-preload.mjs`) for `vitest run`.
 *
 * Vite's Windows realpath optimization probes the SMB mapping table once by
 * shelling out to `net use` (`optimizeSafeRealPathSync`), before it resolves a
 * single file. A confined harness refuses that child spawn with `EPERM`, so
 * config loading dies before any test runs — an environment artifact, never a
 * project concern. The probe is neutralized here, before Vite's module graph
 * is even constructed.
 *
 * On a normal machine this preload is a no-op: the `net use` call is answered
 * with empty output, which is exactly what the probe does when the machine has
 * no mapped network drives. Plain JavaScript on purpose — a preload cannot
 * rely on a TypeScript loader being registered yet.
 */
import childProcess from 'node:child_process'

const cp = childProcess

for (const name of ['exec', 'execFile']) {
  const original = cp[name]
  if (typeof original !== 'function') continue
  cp[name] = function patched(command, options, callback) {
    if (String(command).trim().toLowerCase().startsWith('net use')) {
      const done = typeof options === 'function' ? options : callback
      if (typeof done === 'function') done(null, '')
      return undefined
    }
    return original.call(this, command, options, callback)
  }
}
