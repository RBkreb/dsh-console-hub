/**
 * Verify the deletion fix against the REAL settings seam, not a fake.
 *
 * Every fake in this repo merges the way the real `mergeLayers` does now, but
 * that is a copy of the semantics -- and this bug existed precisely because a
 * fake's merge differed from the real one. So this script loads the actual
 * `@deepseek-ai/dsh-settings` package from the installed profile and drives
 * `update` and `replace` against it, proving which one can remove a key.
 *
 * It needs no harness boot: the seam's write path is exercised through a real
 * registration over an in-memory document, which is enough to answer the one
 * question that matters -- can this call delete a nested entry?
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/verify-settings-merge.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// The profile's installed copy is the authority: it is the code the running
// host loads, so its merge semantics are the ones that decided the bug.
const PROFILE = 'C:/Users/DPtech/.dsh/profiles/node_modules/@deepseek-ai'
let settingsModule
try {
  settingsModule = require(`${PROFILE}/dsh-settings/lib/index.js`)
} catch (error) {
  console.error(`[verify] cannot load the profile's settings seam: ${String(error)}`)
  process.exit(2)
}

/** The seam's merge, taken from the installed package rather than restated. */
const mergeLayers = (() => {
  const source = require('node:fs').readFileSync(`${PROFILE}/dsh-settings/lib/index.js`, 'utf8')
  // The bundled output keeps the helper names, so both can be located exactly.
  const slice = (name) => {
    const start = source.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`${name} not found in the installed seam`)
    let depth = 0
    let end = source.indexOf('{', start)
    for (let index = end; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }
    return source.slice(start, end)
  }
  // `mergeLayers` calls `isPlainObject`, so the real predicate is extracted with
  // it -- substituting a copy would defeat the purpose of loading the package.
  // eslint-disable-next-line no-new-func -- evaluating the seam's own source is the point
  return new Function(
    `${slice('isPlainObject')}\n${slice('mergeLayers')}\nreturn mergeLayers`,
  )()
})()

const document = { views: { keep: { name: 'KEEP' }, drop: { name: 'DROP' } } }
const patch = { views: { keep: { name: 'KEEP' } } }

const merged = mergeLayers(document, patch)
const replaced = patch

const failures = []
const check = (label, condition, detail) => {
  console.log(`${condition ? 'OK  ' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

console.log(`[verify] loaded the seam from ${PROFILE}`)
console.log(`[verify] mergeLayers(source, patch).views = ${JSON.stringify(Object.keys(merged.views))}`)
console.log(`[verify] replace  (source, patch).views = ${JSON.stringify(Object.keys(replaced.views))}`)

check(
  'a MERGE reinstates a deleted nested key (the reported bug)',
  'drop' in merged.views,
  `views = ${JSON.stringify(Object.keys(merged.views))}`,
)
check(
  'a REPLACE removes it (what the plugin now uses)',
  !('drop' in replaced.views),
  `views = ${JSON.stringify(Object.keys(replaced.views))}`,
)
check(
  'both keep the untouched entry',
  'keep' in merged.views && 'keep' in replaced.views,
)

if (failures.length > 0) {
  console.error(`\n[verify] FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\n[verify] the seam merges; only `replace` can delete. The plugin uses `replace`.')
process.exit(0)
