import type { StorageAdapter } from '../core/settings'

/**
 * localStorage adapter.
 *
 * Some environments throw on access (private browsing, storage disabled) or on
 * write (quota). Everything is wrapped so a failing storage degrades to an
 * in-memory session instead of breaking the game.
 */

const memory = new Map<string, string>()
let persistent = true

export const localStorageAdapter: StorageAdapter = {
  read(key: string): string | null {
    if (persistent) {
      try {
        const value = window.localStorage.getItem(key)
        if (value !== null) return value
      } catch {
        persistent = false
      }
    }
    return memory.get(key) ?? null
  },

  write(key: string, value: string): void {
    memory.set(key, value)
    if (!persistent) return
    try {
      window.localStorage.setItem(key, value)
    } catch {
      // Quota exceeded or storage disabled: keep the in-memory copy only.
      persistent = false
    }
  }
}

/** True while writes are reaching localStorage (used by the settings panel). */
export function isStoragePersistent(): boolean {
  return persistent
}
