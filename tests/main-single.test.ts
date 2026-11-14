// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { ACCESS_KEY_TEXT, LINK_DATA, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'

it('opens a single-file share directly, with no tree, back button or Download all', async () => {
  const share = await makeShare([{ path: 'note.txt', content: new TextEncoder().encode('just one file') }])
  vi.stubGlobal('fetch', serveRange(share).fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))

  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}&d=${LINK_DATA}`
  await import('../src/main.js')

  const app = document.getElementById('app') as HTMLElement
  const input = app.querySelector('#access-key') as HTMLInputElement
  input.value = ACCESS_KEY_TEXT
  app.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  for (let attempt = 0; attempt < 200 && !app.querySelector('pre'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  expect(app.querySelector('pre')?.textContent).toBe('just one file')
  expect(app.querySelector('a[download]')?.getAttribute('download')).toBe('note.txt')
  expect(app.querySelector('#download-all')).toBeNull()
  expect(app.querySelector('#back-btn')).toBeNull()
})

it('downloads a file named only with spaces or dots under the default name', async () => {
  const share = await makeShare([{ path: ' . ', content: new TextEncoder().encode('odd name') }])
  vi.stubGlobal('fetch', serveRange(share).fetch)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
  vi.resetModules()

  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}&d=${LINK_DATA}`
  await import('../src/main.js')

  const app = document.getElementById('app') as HTMLElement
  const input = app.querySelector('#access-key') as HTMLInputElement
  input.value = ACCESS_KEY_TEXT
  app.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  for (let attempt = 0; attempt < 200 && !app.querySelector('pre'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  expect(app.querySelector('pre')?.textContent).toBe('odd name')
  expect(app.querySelector('a[download]')?.getAttribute('download')).toBe('Decrypted file')
})
