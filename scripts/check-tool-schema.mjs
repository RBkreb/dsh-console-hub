/**
 * Verify the plugin's tool definitions against the REAL `dsh-tools` validator.
 *
 * The unit suite drives a fake registry that only reads `definition.name`, so a
 * definition rejected by the real contract would register nothing and the tests
 * would still pass. This harness closes that gap by calling the same
 * `assertSupportedJsonSchema` the runtime uses, against every definition
 * `registerConsoleTools` hands the registry.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/check-tool-schema.mjs
 */
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { CONSOLE_TOOL_NAMES, registerConsoleTools } from '../src/tools.ts'

/** Collect every definition the registrar tries to register. */
const captured = []
const registry = {
  register(definition) {
    captured.push(definition)
    return () => {}
  },
}

const dispose = registerConsoleTools({
  registry,
  manager: {
    list: () => [],
    get: () => undefined,
    bannerOf: () => '',
    describe: () => undefined,
    send: async () => ({ state: 'open' }),
    read: () => ({ text: '', cursor: 0, truncated: false, bytes: 0, encoding: 'utf-8', paging: { active: false, pagesConsumed: 0, reason: null } }),
    waitFor: async () => ({ matched: false, reason: 'timeout', cursor: 0, elapsedMs: 0, paging: { active: false, pagesConsumed: 0, reason: null } }),
    resumePaging: () => {},
    wake: async () => true,
    close: async () => {},
    connect: async () => ({}),
    openCount: () => 0,
    startReaper: () => {},
    dispose: async () => {},
  },
  views: () => ({}),
  defaults: () => ({ encoding: 'utf-8', kind: 'telnet', pagingMode: 'auto-more' }),
  // The inventory surface. Present so registration runs to the end: a missing
  // dependency here used to abort `registerConsoleTools` part-way, and the gate
  // then reported on a PREFIX of the family while claiming to have checked it.
  listViews: async () => [],
  upsertView: async () => ({ viewId: 'v-check', view: { name: 'x', host: 'h', port: 1, kind: 'raw' } }),
  removeView: async () => ({ removed: true, secretRemoved: false }),
  resolveSecret: async () => undefined,
})

console.log(`[check] definitions handed to the registry: ${captured.length}`)
// Registration is a loop over the whole family, so a count that disagrees with
// the declared names means it stopped early -- and every check below would then
// be reporting on a prefix. Compared here so that cannot pass silently.
if (captured.length !== CONSOLE_TOOL_NAMES.length) {
  console.error(
    `[check] FAILED: ${String(captured.length)} definition(s) captured but `
    + `${String(CONSOLE_TOOL_NAMES.length)} name(s) declared; registration did not complete`,
  )
  console.error(`[check] declared: ${CONSOLE_TOOL_NAMES.join(', ')}`)
  console.error(`[check] captured: ${captured.map(entry => entry.name).join(', ')}`)
  process.exit(1)
}
const missing = CONSOLE_TOOL_NAMES.filter(name => !captured.some(entry => entry.name === name))
if (missing.length > 0) {
  console.error(`[check] FAILED: declared but never registered: ${missing.join(', ')}`)
  process.exit(1)
}

let failures = 0

for (const definition of captured) {
  const name = definition.name
  // The check `register()` OMITS. `parameters` is stored verbatim and handed to
  // the model API, so it must already be raw JSON Schema with an object root. A
  // DSL-spelled parameters object has no top-level `type`, and the provider then
  // rejects the WHOLE tool list -- "schema must be a JSON Schema of
  // 'type: \"object\"', got 'type: null'" -- before the model can reply at all.
  try {
    assertObjectJsonSchema(definition.parameters)
    console.log(`[check] ${name}: parameters OK`)
  } catch (error) {
    failures += 1
    console.log(`[check] ${name}: parameters REJECTED -> ${error.message}`)
  }

  // The output schema is the enforced-subset contract (which register DOES check).
  try {
    assertSupportedJsonSchema(definition.output.schema)
    console.log(`[check] ${name}: output.schema OK`)
  } catch (error) {
    failures += 1
    console.log(`[check] ${name}: output.schema REJECTED -> ${error.message}`)
    if (error.violations !== undefined) {
      for (const violation of error.violations) console.log(`         ${violation}`)
    }
  }

  // 2. `required` must be an array on the object node, never `true` per property.
  const scan = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (node.required !== undefined && !Array.isArray(node.required)) {
      failures += 1
      console.log(`[check] ${name}: ${path}.required is ${JSON.stringify(node.required)}, expected an array`)
    }
    if (node.properties !== undefined) {
      for (const [key, child] of Object.entries(node.properties)) scan(child, `${path}.properties.${key}`)
    }
    if (node.items !== undefined) scan(node.items, `${path}.items`)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach((child, index) => scan(child, `${path}.oneOf[${index}]`))
  }
  scan(definition.output.schema, 'output.schema')

  // 3. Every property the model is offered must carry a description, and every
  //    name listed in `required` must actually be declared. Both are silent
  //    quality failures otherwise: an undescribed parameter is a parameter the
  //    model guesses at, and a required name with no property is unsatisfiable.
  const properties = definition.parameters?.properties ?? {}
  for (const [key, spec] of Object.entries(properties)) {
    if (spec.description === undefined || spec.description === '') {
      failures += 1
      console.log(`[check] ${name}: parameters.properties.${key} has no description`)
    }
  }
  for (const key of definition.parameters?.required ?? []) {
    if (!(key in properties)) {
      failures += 1
      console.log(`[check] ${name}: parameters.required names undeclared property "${key}"`)
    }
  }
}

dispose()
console.log(failures === 0 ? '[check] ALL DEFINITIONS ACCEPTED' : `[check] ${failures} PROBLEM(S) FOUND`)
process.exit(failures === 0 ? 0 : 1)
