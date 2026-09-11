/**
 * The credential half of a device view.
 *
 * Two rules shape this module:
 *
 * 1. **A value never travels on a read path.** Every function that answers a
 *    question about a credential returns facts — configured, source, writable —
 *    and the only functions that hand back a value are the ones the connect
 *    path calls, immediately before opening a socket.
 * 2. **A stored record is owner-format.** The seam hands `payload` back exactly
 *    as it was written, so this module is the only thing that can interpret it;
 *    anything it did not write reads as "no credential".
 *
 * Storage is a `GrantRecord` under `<scope>/<recordId>`, both derived from the
 * view id ({@link secretRefOfView}), so the settings document never has to
 * carry a second identifier. An environment-variable reference
 * ({@link secretRefOf}) overrides the record, which lets a deployment inject a
 * password without writing one to disk.
 *
 * @module dsh-console-hub/secrets
 */
import { CONSOLE_HUB_CREDENTIAL_SCOPE, recordIdOf, secretRefOf } from './config-shared.ts'
import type { ConsoleCredentialProvider, ConsoleCredentialRecord, ConsoleCredentialInfo } from './context-types.ts'

/** The one payload shape this plugin writes into a credential record. */
export interface ConsoleSecretPayload {
  /** Format marker; bumped if the shape ever changes. */
  version: 1
  /** Login user, when the device wants one. */
  user?: string
  /** The secret itself. */
  password: string
}

/** A resolved credential, on its way to a socket and nowhere else. */
export interface ConsoleResolvedSecret {
  /** The secret. Never log, never return to a caller that renders. */
  password: string
  /** The login user, if one was configured. */
  user?: string
  /** Where the value came from. */
  source: 'env' | 'record'
}

/** The record id segment derived from a view id. */
export function secretRecordIdOfView(viewId: string): string {
  return recordIdOf(viewId)
}

/** The environment-variable reference that may override this view's record. */
export function secretRefOfView(viewId: string): string {
  return secretRefOf(viewId)
}

/** The credential key (`<scope>/<recordId>`) this view's record lives under. */
export function secretKeyOfView(viewId: string): string {
  return `${CONSOLE_HUB_CREDENTIAL_SCOPE}/${secretRecordIdOfView(viewId)}`
}

/**
 * Read one stored payload out of a record, refusing anything this plugin did
 * not write.
 * @param payload - the record's opaque payload.
 * @returns the parsed payload, or `undefined` when it is not ours.
 */
export function parseSecretPayload(payload: unknown): ConsoleSecretPayload | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (typeof record.password !== 'string' || record.password === '') return undefined
  if (record.user !== undefined && typeof record.user !== 'string') return undefined
  return {
    version: 1,
    ...record.user === undefined || record.user === '' ? {} : { user: record.user },
    password: record.password,
  }
}

/** The record a payload is written as (a grant: opaque to the seam). */
function grantOf(payload: ConsoleSecretPayload): ConsoleCredentialRecord {
  // `payload` already carries the version marker; spreading it keeps the
  // stored record exactly the shape `parseSecretPayload` accepts.
  return { kind: 'grant', payload: { ...payload } }
}

/**
 * Store (or replace) the credential for one view.
 * @param credentials - the credential seam.
 * @param viewId - the view whose credential this is.
 * @param secret - the password and optional user.
 * @throws {TypeError} when the password is empty.
 * @throws {Error} when the store refuses the write (read-only shadow, absent provider).
 */
export async function writeSecret(
  credentials: ConsoleCredentialProvider,
  viewId: string,
  secret: { password: string, user?: string },
): Promise<void> {
  if (typeof secret.password !== 'string' || secret.password === '') {
    throw new TypeError('console-hub: a credential password must be a non-empty string')
  }
  const payload: ConsoleSecretPayload = {
    version: 1,
    ...secret.user === undefined || secret.user === '' ? {} : { user: secret.user },
    password: secret.password,
  }
  // `modifyRecord` is the seam's only write path; the mutation replaces
  // wholesale because a device credential has no partial update.
  await credentials.modifyRecord(secretKeyOfView(viewId), async () => grantOf(payload))
}

/**
 * Remove one view's credential. Removing an absent one is a no-op.
 * @param credentials - the credential seam.
 * @param viewId - the view whose credential to drop.
 */
export async function clearSecret(credentials: ConsoleCredentialProvider, viewId: string): Promise<void> {
  await credentials.deleteRecord(secretKeyOfView(viewId))
}

/**
 * Read one view's stored credential.
 * @param credentials - the credential seam.
 * @param viewId - the view to read.
 * @returns the payload, or `undefined` when none is stored or the store is unreadable.
 */
export async function readSecret(
  credentials: ConsoleCredentialProvider,
  viewId: string,
): Promise<ConsoleSecretPayload | undefined> {
  try {
    const record = await credentials.readRecord(secretKeyOfView(viewId))
    if (record === undefined) return undefined
    return parseSecretPayload(record.payload)
  } catch {
    // An unreadable store means "no credential I can vouch for", which fails
    // closed at the connect path rather than breaking the settings read.
    return undefined
  }
}

/**
 * Describe one view's credential for a configuration surface.
 * @param credentials - the credential seam.
 * @param viewId - the view to describe.
 * @returns configured/source/writable facts; never the value.
 */
export async function describeSecret(
  credentials: ConsoleCredentialProvider,
  viewId: string,
): Promise<ConsoleCredentialInfo & { recordConfigured: boolean }> {
  const ref = secretRefOfView(viewId)
  try {
    const info = await credentials.describe(ref as never)
    const record = await credentials.readRecord(secretKeyOfView(viewId))
    if (info.configured) {
      return {
        configured: true,
        ...info.source === undefined ? {} : { source: info.source },
        writable: info.writable,
        recordConfigured: record !== undefined,
      }
    }
    return {
      configured: record !== undefined,
      ...record === undefined ? {} : { source: 'record' },
      writable: info.writable,
      recordConfigured: record !== undefined,
    }
  } catch {
    // No provider mounted, or an unreadable store: report read-only-and-empty
    // so a configuration surface renders the state instead of crashing.
    return { configured: false, writable: false, recordConfigured: false }
  }
}

/**
 * Resolve the credential to actually use for a connect: the environment
 * reference wins over the stored record, because an injected secret is the
 * deployment's explicit override.
 * @param credentials - the credential seam.
 * @param viewId - the view being connected.
 * @param fallbackUser - the view's configured user, used when the credential states none.
 * @returns the resolved credential, or `undefined` when none is configured.
 */
export async function resolveSecret(
  credentials: ConsoleCredentialProvider,
  viewId: string,
  fallbackUser?: string,
): Promise<ConsoleResolvedSecret | undefined> {
  const record = await readSecret(credentials, viewId)

  let ambient: string | undefined
  try {
    const resolved = await credentials.resolve(secretRefOfView(viewId) as never)
    // The seam already treats an empty stored value as absent, but the fake and
    // some providers may hand back whitespace; treat both as absent.
    if (resolved !== undefined && resolved.value !== '') ambient = resolved.value
  } catch {
    ambient = undefined
  }

  if (ambient !== undefined) {
    // `user:pass` in one value is the conventional shape for an injected
    // console credential; a bare value is the password alone.
    const separator = ambient.indexOf(':')
    if (separator > 0) {
      return { user: ambient.slice(0, separator), password: ambient.slice(separator + 1), source: 'env' }
    }
    return {
      password: ambient,
      ...resolveEnvUser(record, fallbackUser) === undefined ? {} : { user: resolveEnvUser(record, fallbackUser) },
      source: 'env',
    }
  }

  if (record === undefined) return undefined
  const user = record.user ?? (fallbackUser === undefined || fallbackUser === '' ? undefined : fallbackUser)
  return { password: record.password, ...user === undefined ? {} : { user }, source: 'record' }
}

/** The user an environment-supplied password should be paired with. */
function resolveEnvUser(
  record: ConsoleSecretPayload | undefined,
  fallbackUser: string | undefined,
): string | undefined {
  if (record?.user !== undefined && record.user !== '') return record.user
  return fallbackUser === undefined || fallbackUser === '' ? undefined : fallbackUser
}
