/**
 * The device-inventory operations, shared by the HTTP API and the model tools.
 *
 * Both surfaces edit the same document, so both go through these functions. That
 * is not tidiness for its own sake: the write path carries the schema check, the
 * pattern check, the secret guard, and the `replace`-not-`update` rule (a merge
 * cannot delete a key, so a removal routed through one silently does nothing).
 * A second implementation would be a second chance to get one of those wrong.
 *
 * @module dsh-console-hub/inventory
 */
import { parseSettingsDocument } from './config.ts'
import { clearSecret, describeSecret, writeSecret } from './secrets.ts'
import { HubError, optionalString, requireString } from './wire.ts'
import { assertNoSecretsInViews, newViewId, normalizeView, redactView, type ConsoleViewRedacted } from './views.ts'
import type { ConsoleHubSettings } from './config-shared.ts'
import type { ConsoleCredentialProvider, ConsoleSettingsScope } from './context-types.ts'

/**
 * What one inventory write needs.
 *
 * Deliberately narrower than the API's own dependency table: the tools have a
 * manager and a credential seam but no HTTP carrier, so the seam is optional
 * here and every path below tolerates its absence.
 */
export interface InventoryApi {
  /** The live settings value. */
  current(): ConsoleHubSettings
  /** Replace the whole section. Absent only in a composition that offers no write path. */
  replace?(patch: object): Promise<void>
  /** The seam itself, for the writes `replace` cannot express (see {@link applySettingsPatch}). */
  update?(patch: object): Promise<void>
  /** The registered owner scope, preferred over the two above when present. */
  scope?: ConsoleSettingsScope<ConsoleHubSettings>
  credentials: ConsoleCredentialProvider | undefined
}

/** One view, redacted, with its credential facts loaded. */
export async function redactedView(
  api: InventoryApi,
  viewId: string,
  view: ConsoleHubSettings['views'][string],
): Promise<ConsoleViewRedacted> {
  const secret = await describeSecret(api.credentials, viewId)
  return redactView(view, {
    secretConfigured: secret.configured,
    ...secret.source === undefined ? {} : { secretSource: secret.source },
    secretWritable: secret.writable,
  })
}

/**
 * Every stored view, redacted and sorted by display name.
 * @param api - the inventory dependencies.
 * @returns the rows a configuration surface renders.
 */
export async function listViews(api: InventoryApi): Promise<Array<{ viewId: string, view: ConsoleViewRedacted }>> {
  const settings = api.current()
  const views = await Promise.all(
    Object.entries(settings.views).map(async ([viewId, view]) =>
      ({ viewId, view: await redactedView(api, viewId, view) })),
  )
  views.sort((left, right) => left.view.name.localeCompare(right.view.name))
  return views
}

/**
 * Replace this plugin's whole settings section after validating it.
 *
 * Goes through `replace`, NOT `update`, and that distinction is the whole point.
 * The settings seam's `update` is a RECURSIVE MERGE: plain objects merge key by
 * key and no merge can remove a key, because the keys it would have to remove
 * are exactly the ones it does not carry. Merging a view map that is missing a
 * deleted entry therefore reinstates it, the write reports success, and the
 * device stays on disk.
 *
 * Absent keys fall back to the schema defaults, which is what this section's
 * author expects: the patch is built from the live document plus one change, so
 * nothing is being reset by accident.
 *
 * @param api - the inventory dependencies.
 * @param patch - fields to change; anything absent reverts to its default.
 * @returns the resolved settings after the write.
 * @throws {HubError} `settings-rejected` when the resulting document is invalid.
 */
export async function applySettingsPatch(api: InventoryApi, patch: object): Promise<ConsoleHubSettings> {
  const merged = { ...api.current(), ...patch }
  try {
    // Validating the MERGED document refuses the write before it commits.
    parseSettingsDocument(merged)
  } catch (error) {
    throw new HubError('settings-rejected', error instanceof Error ? error.message : String(error))
  }
  if (api.scope !== undefined) await api.scope.replace(merged)
  else if (api.replace !== undefined) await api.replace(merged)
  else if (api.update !== undefined) await api.update(merged)
  else throw new HubError('not-supported', 'this deployment has no writable settings document', 501)
  return api.current()
}

/** A write the credential store refused, mapped onto the wire code. */
async function writeSecretOrReject(
  api: InventoryApi,
  viewId: string,
  secret: { password: string, user?: string },
): Promise<void> {
  try {
    await writeSecret(api.credentials, viewId, secret)
  } catch (error) {
    throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
  }
}

/** A credential removal the store refused, mapped onto the wire code. */
async function clearSecretOrReject(api: InventoryApi, viewId: string): Promise<void> {
  try {
    await clearSecret(api.credentials, viewId)
  } catch (error) {
    throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
  }
}

/** The fields one upsert may carry, flat or nested under `view`. */
const VIEW_FIELDS = [
  'name', 'host', 'port', 'kind', 'encoding', 'user',
  'promptPattern', 'pagerPattern', 'pagingMode', 'tags', 'notes',
] as const

/**
 * Create or update one stored device.
 *
 * @param api - the inventory dependencies.
 * @param payload - the flat fields, an optional nested `view`, an optional `viewId`, and an optional `password`.
 * @returns the stored id and the redacted row.
 * @throws {HubError} `bad-request` on a malformed payload or a rejected view.
 */
export async function upsertView(
  api: InventoryApi,
  payload: unknown,
): Promise<{ viewId: string, view: ConsoleViewRedacted }> {
  const settings = api.current()
  const requestedId = optionalString(payload, 'viewId')
  const viewId = requestedId ?? newViewId()
  // Upsert means create-or-update: a supplied id that does not exist yet is a
  // creation, so the only thing to check is that the id is usable as both a
  // settings key and a credential record id.
  if (requestedId !== undefined && !/^[a-z][a-z0-9-]*$/.test(requestedId)) {
    throw new HubError('bad-request', `"viewId" must match [a-z][a-z0-9-]* (got "${requestedId}")`)
  }

  // The view document is built from the fields the view owns, so a flat
  // payload's `sessionId` (or a caller's stray key) can never be mistaken for a
  // view field, and a secret-shaped key inside `view` is still caught.
  const record = (payload ?? {}) as Record<string, unknown>
  const nested = record.view
  if (nested !== undefined && (nested === null || typeof nested !== 'object' || Array.isArray(nested))) {
    throw new HubError('bad-request', '"view" must be a JSON object')
  }
  if (nested !== undefined) {
    // A caller who nested a credential inside the view document gets a named
    // refusal rather than a silent drop.
    try {
      assertNoSecretsInViews(nested)
    } catch (error) {
      throw new HubError('bad-request', error instanceof Error ? error.message : String(error))
    }
  }
  const source = nested ?? Object.fromEntries(VIEW_FIELDS.map(field => [field, record[field]]))

  let view
  try {
    view = normalizeView(source as never)
  } catch (error) {
    throw new HubError('bad-request', error instanceof Error ? error.message : String(error))
  }

  // The password travels beside the view, never inside it; a secret-shaped key
  // in the document is refused by name.
  const password = optionalString(record, 'password')
  if (password !== undefined && password !== '') {
    const user = optionalString(record, 'user')
    await writeSecretOrReject(api, viewId, { password, ...user === undefined ? {} : { user } })
  }

  await applySettingsPatch(api, { views: { ...settings.views, [viewId]: view } })
  return { viewId, view: await redactedView(api, viewId, view) }
}

/**
 * Remove one stored device and its credential.
 *
 * @param api - the inventory dependencies.
 * @param payload - carries `viewId`.
 * @returns whether a credential was configured before the removal.
 * @throws {HubError} `not-found` when the id names no stored view.
 */
export async function removeView(
  api: InventoryApi,
  payload: unknown,
): Promise<{ removed: true, secretRemoved: boolean }> {
  const settings = api.current()
  const viewId = requireString(payload, 'viewId')
  if (settings.views[viewId] === undefined) {
    throw new HubError('not-found', `no view "${viewId}"`, 404)
  }

  const nextViews = { ...settings.views }
  const secretWasConfigured = (await describeSecret(api.credentials, viewId)).configured
  delete nextViews[viewId]
  await applySettingsPatch(api, { views: nextViews })
  // Dropping a view drops its credential with it: a record left behind by a
  // deleted view would be unreachable and would keep a secret on disk.
  await clearSecretOrReject(api, viewId)
  return { removed: true, secretRemoved: secretWasConfigured }
}
