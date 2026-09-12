/**
 * The draggable divider between the console list and the console itself.
 *
 * The left column was a fixed 38%, which is wrong for both extremes: a long
 * device label or many consoles want more room, and a wide command answer wants
 * less. The split is therefore the user's to set.
 *
 * The width is a PREFERENCE, not per-session state: it is stored in the same
 * shared prefs store the tab already uses, so it survives a session switch and
 * applies to every console tab. Pointer capture keeps the drag alive when the
 * cursor outruns the thin handle, which is the usual cause of a "sticky"
 * resizer that stops following the mouse.
 *
 * @module dsh-console-hub/client/Splitter
 */
import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { MAX_LIST_WIDTH_PX, MIN_LIST_WIDTH_PX } from './prefs.ts'

/** Props for {@link Splitter}. */
export interface SplitterProps {
  /** Current list width in pixels. */
  width: number
  /** Called continuously while dragging, with the clamped width. */
  onResize(width: number): void
  /** Accessible label for the separator. */
  label?: string
}

/** Clamp a requested width into the range the layout can honour. */
export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return MIN_LIST_WIDTH_PX
  return Math.min(MAX_LIST_WIDTH_PX, Math.max(MIN_LIST_WIDTH_PX, Math.round(width)))
}

/**
 * Render the drag handle.
 * @param props - the current width and the resize callback.
 * @returns the separator element.
 */
export function Splitter({ width, onResize, label = '调整宽度' }: SplitterProps): ReactElement {
  /** Latest callback, so the drag listeners never capture a stale closure. */
  const onResizeRef = useRef(onResize)
  useEffect(() => { onResizeRef.current = onResize }, [onResize])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; a right-click must not start a resize.
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = width

    const onMove = (move: PointerEvent): void => {
      onResizeRef.current(clampListWidth(startWidth + (move.clientX - startX)))
    }
    const onUp = (up: PointerEvent): void => {
      handle.releasePointerCapture(up.pointerId)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
    }
    // Bound to the HANDLE, not the window: pointer capture retargets every
    // later pointer event here, including one that leaves the element, so the
    // drag survives the cursor leaving the thin strip.
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }, [width])

  /** Keyboard resizing, because a pointer-only control is unreachable. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 8
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onResizeRef.current(clampListWidth(width - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onResizeRef.current(clampListWidth(width + step))
    }
  }, [width])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={{
        // Wider than it looks: a 1px target is unhittable, so the visible line
        // sits inside a comfortably grabbable strip.
        width: 6,
        flex: 'none',
        cursor: 'col-resize',
        background: 'transparent',
        // The line is drawn with a pseudo-element-free inner div so the whole
        // strip stays draggable without a hover-only hit area.
        display: 'flex',
        justifyContent: 'center',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      <div style={{ width: 1, background: 'rgba(127,127,127,0.35)' }} />
    </div>
  )
}
