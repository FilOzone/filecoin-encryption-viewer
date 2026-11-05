// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBytes } from '../src/format.js'
import { expectSameBytes } from './fixtures/bytes.js'
import { stubOpfs } from './fixtures/fake-opfs.js'
import { ACCESS_KEY_TEXT, LINK_DATA, makeShare } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const COMMAND = 'npx filecoin-pin decrypt encrypted.fee ./shared'

async function waitFor<T>(find: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the page')
}

const app = () => document.getElementById('app') as HTMLElement
const saveButton = () => app().querySelector<HTMLButtonElement>('#save-encrypted')

async function openPage(): Promise<void> {
  vi.resetModules()
  document.body.innerHTML = '<div id="app"></div>'
  window.location.hash = `#v1/${CID}&d=${LINK_DATA}`
  await import('../src/main.js')
  const input = await waitFor(() => app().querySelector<HTMLInputElement>('#access-key'))
  input.value = ACCESS_KEY_TEXT
  app()
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

// A save picker that collects what is written
function stubPicker() {
  const written: number[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      for (const byte of chunk) written.push(byte)
    },
  })
  const picker = vi.fn(async () => ({ createWritable: async () => writable }))
  vi.stubGlobal('showSaveFilePicker', picker)
  return { picker, written }
}

const folder = [
  { path: 'docs/big.bin', content: new Uint8Array(700_000).map((_, index) => index % 251) },
  { path: 'docs/note.txt', content: new TextEncoder().encode('note') },
]

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }))
})
afterEach(() => vi.unstubAllGlobals())

describe('range ignored by the server', () => {
  it('shows the state on the head request, with the size and the command, and saves the body through the picker', async () => {
    const share = await makeShare(folder)
    vi.stubGlobal('fetch', serveRange(share, 'full').fetch)
    const { picker, written } = stubPicker()

    await openPage()
    const button = await waitFor(saveButton)

    expect(app().querySelector('h1')?.textContent).toBe("This share can't be opened in the browser")
    expect(button.textContent).toBe(`Download encrypted file (${formatBytes(share.length)})`)
    expect(app().querySelector('code')?.textContent).toBe(COMMAND)
    // no archive yet on the first request: nothing to go back to
    expect(app().querySelector('#back-btn')).toBeNull()

    button.click()
    await waitFor(() => app().querySelector('#save-status')?.textContent === 'Saved.')
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'encrypted.fee' })
    expectSameBytes(new Uint8Array(written), share)
  })

  it('omits the size without a Content-Length, and saves the body byte-identical through the Blob fallback', async () => {
    const share = await makeShare(folder)
    vi.stubGlobal('fetch', async () => new Response(share as BodyInit, { status: 200 }))
    vi.stubGlobal('showSaveFilePicker', undefined)
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:encrypted')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await openPage()
    const button = await waitFor(saveButton)
    expect(button.textContent).toBe('Download encrypted file')

    button.click()
    await waitFor(() => app().querySelector('#save-status')?.textContent === 'Saved.')
    expect(click).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0][0]
    expectSameBytes(new Uint8Array(await blob.arrayBuffer()), share)
  })

  it('saves the encrypted file through OPFS when available, with progress', async () => {
    const share = await makeShare(folder)
    vi.stubGlobal('fetch', serveRange(share, 'full').fetch)
    const { files } = stubOpfs()
    vi.stubGlobal('showSaveFilePicker', undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:encrypted'), revokeObjectURL: vi.fn() })
    )

    await openPage()
    const button = await waitFor(saveButton)
    button.click()
    await waitFor(() => app().querySelector('#save-status')?.textContent === 'Saved.')

    expect(click).toHaveBeenCalledOnce()
    const staged = new Uint8Array(await new Blob([...files.values()][0] as BlobPart[]).arrayBuffer())
    expectSameBytes(staged, share)
  })

  it('switches the file view to the state when a file read gets a 200', async () => {
    const share = await makeShare(folder)
    const stub = serveRange(share)
    vi.stubGlobal('fetch', stub.fetch)
    const { written } = stubPicker()

    await openPage()
    const file = await waitFor(() =>
      Array.from(app().querySelectorAll<HTMLButtonElement>('button.tree-file')).find((b) =>
        b.textContent?.includes('big.bin')
      )
    )
    stub.mode = 'full'
    file.click()

    const button = await waitFor(saveButton)
    expect(app().querySelector('code')?.textContent).toBe(COMMAND)
    // inside a folder share the tree still exists, so there is a way back to it
    expect(app().querySelector('#back-btn')).not.toBeNull()

    button.click()
    await waitFor(() => app().querySelector('#save-status')?.textContent === 'Saved.')
    expectSameBytes(new Uint8Array(written), share)
  })

  it('switches to the screen when a 200 arrives while saving a large file', async () => {
    const huge = {
      path: 'docs/huge.bin',
      content: new Uint8Array(9 * 1024 * 1024).map((_, index) => (index * 31) % 251),
    }
    const share = await makeShare([huge, folder[1]])
    const stub = serveRange(share)
    vi.stubGlobal('fetch', stub.fetch)
    vi.stubGlobal('showSaveFilePicker', undefined)

    await openPage()
    const file = await waitFor(() =>
      Array.from(app().querySelectorAll<HTMLButtonElement>('button.tree-file')).find((b) =>
        b.textContent?.includes('huge.bin')
      )
    )
    file.click()
    const save = await waitFor(() => app().querySelector<HTMLButtonElement>('#save-entry'))
    stub.mode = 'full'
    save.click()

    await waitFor(saveButton)
    expect(app().querySelector('h1')?.textContent).toBe("This share can't be opened in the browser")

    // "← All files" returns to the tree
    app().querySelector<HTMLButtonElement>('#back-btn')?.click()
    await waitFor(() => app().querySelector('#archive-tree'))
  })

  it('switches to the screen when a 200 arrives during Download all', async () => {
    const share = await makeShare(folder)
    const stub = serveRange(share)
    vi.stubGlobal('fetch', stub.fetch)
    vi.stubGlobal('showSaveFilePicker', undefined)

    await openPage()
    const downloadAll = await waitFor(() => app().querySelector<HTMLButtonElement>('#download-all'))
    stub.mode = 'full'
    downloadAll.click()

    await waitFor(saveButton)
    expect(app().querySelector('h1')?.textContent).toBe("This share can't be opened in the browser")
  })
})

const INACTIVE = "This page isn't connected to the Filecoin gateway yet. Open the link again, or reload the page."

describe("the gateway's installer page (200 text/html)", () => {
  it('shows the gateway message at unlock, cancels the page and offers no encrypted.fee', async () => {
    const stub = serveRange(await makeShare(folder), 'installer')
    vi.stubGlobal('fetch', stub.fetch)

    await openPage()
    await waitFor(() => app().querySelector<HTMLElement>('#error')?.textContent === INACTIVE)

    expect(stub.installerPages).toBeGreaterThan(0)
    expect(stub.installerCancels).toBe(stub.installerPages)
    expect(saveButton()).toBeNull()
  })

  it('shows the gateway message when opening a file after unlock', async () => {
    const stub = serveRange(await makeShare(folder))
    vi.stubGlobal('fetch', stub.fetch)

    await openPage()
    const file = await waitFor(() =>
      Array.from(app().querySelectorAll<HTMLButtonElement>('button.tree-file')).find((b) =>
        b.textContent?.includes('big.bin')
      )
    )
    stub.mode = 'installer'
    file.click()

    await waitFor(() => app().textContent?.includes(INACTIVE))
    expect(stub.installerPages).toBeGreaterThan(0)
    expect(stub.installerCancels).toBe(stub.installerPages)
    expect(saveButton()).toBeNull()
  })
})
