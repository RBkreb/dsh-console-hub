/**
 * Scaffold contract: the package must be installable as a DSH bundle and its
 * two halves must exist. These assertions are the guard rails the rest of the
 * project builds on — every later step assumes the manifest shape checked here.
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The package id the bundle patch and the client bundle both register under. */
const PACKAGE_NAME = 'dsh-console-hub'

interface PackageManifest {
  name: string
  type: string
  main: string
  exports: Record<string, string | { default?: string }>
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string, inject?: string[] }
  }
}

async function readManifest(): Promise<PackageManifest> {
  const raw = await readFile(join(REPO_ROOT, 'package.json'), 'utf8')
  return JSON.parse(raw) as PackageManifest
}

/** The relative entry an exports subpath resolves to, string and conditional forms alike. */
function exportEntry(manifest: PackageManifest, subpath: string): string | undefined {
  const value = manifest.exports[subpath]
  if (typeof value === 'string') return value
  return value?.default
}

describe('scaffold', () => {
  it('declares a dual-face DSH bundle package', async () => {
    const manifest = await readManifest()
    expect(manifest.name).toBe(PACKAGE_NAME)
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
    expect(exportEntry(manifest, '.')).toBe('./lib/index.js')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('exports the browser half the client-module system serves', async () => {
    const manifest = await readManifest()
    const client = exportEntry(manifest, './client')
    expect(client).toBeTruthy()
    expect(client?.startsWith('./')).toBe(true)
  })

  it('keeps the marketplace manifest constraints', async () => {
    const manifest = await readManifest()
    // Install-time build hooks are refused by the plugin-market policy.
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(manifest.scripts[hook]).toBeUndefined()
    }
    // `cordis` must never appear in any dependency field, optional included.
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('cordis')
    }
  })

  it('ships a bundle patch that inserts exactly this row', async () => {
    const manifest = await readManifest()
    const patchPath = join(REPO_ROOT, manifest.dsh?.bundle?.patch ?? '')
    expect(existsSync(patchPath)).toBe(true)
    const patch = await readFile(patchPath, 'utf8')
    // The patch is a YAML list whose one entry inserts the plugin row; the
    // loader resolves the row by package name.
    expect(patch).toMatch(/^-\s+insert:/m)
    expect(patch).toContain(`name: ${PACKAGE_NAME}`)
    expect(patch).toContain('id: dsh-console-hub')
  })

  it('has both plugin halves on disk', async () => {
    expect(existsSync(join(REPO_ROOT, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'src/client/index.tsx'))).toBe(true)
  })

  it('builds the host half from a node entry and the client half from the browser entry', async () => {
    const config = await readFile(join(REPO_ROOT, 'tsdown.config.ts'), 'utf8')
    expect(config).toContain("entry: { index: 'src/index.ts' }")
    expect(config).toContain("entry: { client: 'src/client/index.tsx' }")
    expect(config).toContain('__ModuleLoader__.load')
  })

  it('keeps sources free of lazy chunk bundles (single-script client artifact)', async () => {
    const srcEntries = await readdir(join(REPO_ROOT, 'src'))
    expect(srcEntries).not.toContain('chunks')
  })
})
