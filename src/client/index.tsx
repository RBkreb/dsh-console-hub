/**
 * dsh-console-hub — browser half.
 *
 * Registers the sidebar tab through `ctx.betterSidebar` and renders the device
 * console surface (view list, config editor, and the console itself). The
 * bundle is a module-table consumer only (react + react/jsx-runtime), so it
 * needs no DSH client package at runtime; the `betterSidebar` service shape is
 * mirrored as a local type (see ../context-types.ts).
 *
 * @module dsh-console-hub/client
 */
import type { Context } from '../context-types.ts'

/** Services required before mounting: the sidebar registry this tab joins. */
export const inject = ['betterSidebar']

/** Client plugin body — tab registration lands here. */
export function apply(_ctx: Context): void {}
