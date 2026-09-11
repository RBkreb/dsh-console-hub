/**
 * Diagnose why the host sees no saved devices while the settings file has them.
 *
 * Reads the deployment's real settings document, extracts this plugin's
 * namespace, and runs the SAME `parseSettingsDocument` the host runs. That
 * function is the single entry point every reader goes through, so if it
 * rejects the stored section the host silently falls back to an empty
 * inventory -- which is exactly the symptom being chased.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/diagnose-settings.mjs [path]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parseSettingsDocument } from '../src/config.ts'

const path = process.argv[2] ?? join(homedir(), '.dsh', 'settings.yaml')
console.log(`[diag] settings document: ${path}`)

const text = readFileSync(path, 'utf8')

// The deployment's own YAML parser, resolved from the profile rather than
// reimplemented: a different parser would make this diagnosis meaningless.
const require = createRequire(join(homedir(), '.dsh', 'profiles', 'node_modules', 'x.js'))
let yaml
try {
  yaml = require('js-yaml')
} catch (error) {
  console.error(`[diag] could not load js-yaml from the profile: ${String(error)}`)
  process.exit(2)
}

const document = yaml.load(text)
const section = document?.['dsh-console-hub']
if (section === undefined) {
  console.log('[diag] the document has NO "dsh-console-hub" section at all')
  console.log(`[diag] top-level keys: ${Object.keys(document ?? {}).join(', ')}`)
  process.exit(1)
}

console.log(`[diag] stored section keys: ${Object.keys(section).join(', ')}`)
console.log(`[diag] stored views: ${Object.keys(section.views ?? {}).length}`)

// The exact call the host makes on every read.
try {
  const resolved = parseSettingsDocument(section)
  const ids = Object.keys(resolved.views)
  console.log(`[diag] parseSettingsDocument OK -- resolved ${ids.length} view(s)`)
  for (const id of ids) {
    const view = resolved.views[id]
    console.log(`         ${id}  ${view.name}  ${view.host}:${view.port}  ${view.kind}`)
  }
  if (ids.length === 0) {
    console.log('[diag] the document parsed but carries NO views -- the section itself is empty')
    process.exit(3)
  }
} catch (error) {
  // This is the interesting case: the host swallows exactly this and serves
  // defaults, so the panel shows an empty list with no error anywhere.
  console.error('[diag] parseSettingsDocument REJECTED the stored section:')
  console.error(`       ${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack !== undefined) {
    console.error(error.stack.split('\n').slice(1, 4).join('\n'))
  }
  process.exit(1)
}
