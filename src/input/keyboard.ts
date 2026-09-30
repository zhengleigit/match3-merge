/**
 * Keyboard input -> semantic actions.
 *
 * Kept separate from pointer input so both feed the same semantic actions
 * (undo / restart) and the rules layer stays blind to the actual keys, which
 * also makes rebinding and replay straightforward.
 */

export interface KeyboardCallbacks {
  onUndo(): void
  onRestart(): void
}

/** True when the focus is in a field, so shortcuts must not hijack typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export interface KeyboardOptions {
  /** Blocks shortcuts while a modal dialog owns the screen. */
  isBlocked: () => boolean
}

/** Attaches the handlers and returns a disposer. */
export function attachKeyboard(
  target: Window,
  callbacks: KeyboardCallbacks,
  options: KeyboardOptions
): () => void {
  const handler = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return
    if (options.isBlocked()) return

    const key = event.key

    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'Z')) {
      event.preventDefault()
      callbacks.onUndo()
      return
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && (key === 'r' || key === 'R')) {
      event.preventDefault()
      callbacks.onRestart()
    }
  }

  target.addEventListener('keydown', handler)
  return () => target.removeEventListener('keydown', handler)
}
