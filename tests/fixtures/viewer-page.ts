import { vi } from 'vitest'

// The window listeners each loaded copy of main.ts added, removed by unloadPage so that a later test's fragment
// change doesn't reach an earlier test's viewer (happy-dom keeps one window per file).
const listeners: [string, EventListenerOrEventListenerObject][] = []

/**
 * Loads a fresh copy of the viewer at `hash`, with `state` as the history entry's state (a reload keeps both).
 * Unlike browsers, happy-dom fires hashchange for replaceState and pushState too, so the viewer sees its own address
 * again once loaded, and again after it removes `k`.
 */
export async function loadPage(hash: string, state: unknown = null): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  history.replaceState(state, '', hash)
  const add = vi.spyOn(window, 'addEventListener')
  try {
    await import('../../src/main.js')
  } finally {
    for (const [type, listener] of add.mock.calls)
      listeners.push([type, listener as EventListenerOrEventListenerObject])
    add.mockRestore()
  }
}

export function unloadPage(): void {
  for (const [type, listener] of listeners.splice(0)) window.removeEventListener(type, listener)
}
