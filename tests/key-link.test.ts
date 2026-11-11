// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAccessKey, type parseFragment } from '../src/fragment.js'
import { expectSameBytes } from './fixtures/bytes.js'
import { ACCESS_KEY_TEXT, LINK_DATA, accessKey, delivery, makeShare, plainGrant } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'
import { loadPage, unloadPage } from './fixtures/viewer-page.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const files = [
  { path: 'docs/a.txt', content: new TextEncoder().encode('alpha text') },
  { path: 'docs/b.txt', content: new TextEncoder().encode('beta text') },
]
const KEY_FAILED = "The key in this link didn't work. Enter the Access key you received instead."
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

async function waitFor<T>(find: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the page')
}

const app = () => document.getElementById('app') as HTMLElement
const errorText = () => (app().querySelector('#error') as HTMLElement).textContent

// Serves the default share and records the address bar at every fetch
async function stubFetch() {
  const stub = serveRange(await makeShare(files))
  const hashes: string[] = []
  const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    hashes.push(window.location.hash)
    return stub.fetch(input, init)
  })
  vi.stubGlobal('fetch', fetchFn)
  return { fetchFn, hashes }
}

const openPage = loadPage

function submitKey(text: string): void {
  ;(app().querySelector('#access-key') as HTMLInputElement).value = text
  app()
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

afterEach(() => {
  unloadPage()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a link that carries its Access key', () => {
  it.each([
    ['a plain grant', plainGrant],
    ['a Delivery', delivery],
  ])('opens %s with no prompt, and drops k (keeping d) before the first fetch', async (_, make) => {
    const { fetchFn, hashes } = await stubFetch()
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const link = `#v1/${CID}&d=${b64(await make())}`

    await openPage(`${link}&k=${ACCESS_KEY_TEXT}`)
    await waitFor(() => app().querySelector('button.tree-file'))

    expect(app().querySelector('#access-key')).toBeNull()
    expect(replaceState).toHaveBeenCalledWith({ keyRemoved: true }, '', link)
    expect(window.location.hash).toBe(link)
    expect(fetchFn).toHaveBeenCalled()
    expect(hashes.every((hash) => hash === link)).toBe(true)
    expect(document.body.innerHTML).not.toContain(ACCESS_KEY_TEXT)
  })

  it('falls back to the prompt with a notice, having fetched nothing, when the key is wrong', async () => {
    const { fetchFn } = await stubFetch()
    const wrongKey = encodeAccessKey(new Uint8Array(32).fill(0x44))

    await openPage(`#v1/${CID}&d=${LINK_DATA}&k=${wrongKey}`)
    await waitFor(() => app().querySelector('#access-key'))

    expect(errorText()).toBe(KEY_FAILED)
    expect(window.location.hash).toBe(`#v1/${CID}&d=${LINK_DATA}`)
    expect(fetchFn).not.toHaveBeenCalled()

    submitKey(ACCESS_KEY_TEXT)
    await waitFor(() => app().querySelector('button.tree-file'))
  })

  it('treats an all-zero key like a wrong key', async () => {
    const { fetchFn } = await stubFetch()
    await openPage(`#v1/${CID}&d=${LINK_DATA}&k=fak1_${'A'.repeat(43)}`)
    await waitFor(() => app().querySelector('#access-key'))
    expect(errorText()).toBe(KEY_FAILED)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('shows an expired share as final: its message, no prompt and no Try again', async () => {
    const { fetchFn } = await stubFetch()
    const expired = await delivery({ expires: Math.floor(Date.now() / 1000) - 3600 })
    await openPage(`#v1/${CID}&d=${b64(expired)}&k=${ACCESS_KEY_TEXT}`)
    await waitFor(() => app().querySelector('#link-error'))
    expect(app().querySelector('#link-error')?.textContent).toBe(
      'This share has expired. Ask the sender for a new link.'
    )
    expect(app().querySelector('#access-key')).toBeNull()
    expect(app().querySelector('#retry-btn')).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("shows the gateway's installer page as final: its message and no Try again", async () => {
    vi.stubGlobal('fetch', serveRange(await makeShare(files), 'installer').fetch)
    await openPage(`#v1/${CID}&d=${LINK_DATA}&k=${ACCESS_KEY_TEXT}`)
    await waitFor(() => app().querySelector('#link-error'))
    expect(app().querySelector('#link-error')?.textContent).toBe(
      "This page isn't connected to the Filecoin gateway yet. Open the link again, or reload the page."
    )
    expect(app().querySelector('#retry-btn')).toBeNull()
  })

  it('offers Try again with the same key when the share is not available yet, then zeroes the kept key', async () => {
    const stub = serveRange(await makeShare(files), 504)
    vi.stubGlobal('fetch', stub.fetch)
    // Capture the parsed key: it is the copy main.ts keeps for Try again
    let parsed = null as ReturnType<typeof parseFragment>
    vi.doMock('../src/fragment.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/fragment.js')>()
      // Only the parse with the key: happy-dom's hashchange for the viewer's own replaceState parses it again without
      const capture = (hash: string) => {
        const result = original.parseFragment(hash)
        if (result?.key) parsed = result
        return result
      }
      return { ...original, parseFragment: capture }
    })
    const link = `#v1/${CID}&d=${LINK_DATA}`

    try {
      await openPage(`${link}&k=${ACCESS_KEY_TEXT}`)
      const retry = await waitFor(() => app().querySelector<HTMLButtonElement>('#retry-btn'))
      expect(app().querySelector('#link-error')?.textContent).toBe(
        "This share isn't available yet, or the download was interrupted. Try again in a few minutes."
      )
      expect(app().querySelector('#access-key')).toBeNull()
      expectSameBytes(parsed?.key as Uint8Array, accessKey())

      stub.mode = 'range'
      retry.click()
      await waitFor(() => app().querySelector('button.tree-file'))
      expect(app().querySelector('#access-key')).toBeNull()
      expect(window.location.hash).toBe(link)
      expectSameBytes(parsed?.key as Uint8Array, new Uint8Array(32))
    } finally {
      vi.doUnmock('../src/fragment.js')
    }
  })
})

describe('a link without its Access key', () => {
  it('shows the prompt and fetches nothing until a key is entered', async () => {
    const { fetchFn } = await stubFetch()
    await openPage(`#v1/${CID}&d=${LINK_DATA}`)
    await waitFor(() => app().querySelector('#access-key'))
    expect((app().querySelector('#error') as HTMLElement).hidden).toBe(true)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('says why the prompt is back after a reload of a link whose key was removed, and stores no key', async () => {
    const { fetchFn } = await stubFetch()
    const link = `#v1/${CID}&d=${LINK_DATA}`
    await openPage(`${link}&k=${ACCESS_KEY_TEXT}`)
    await waitFor(() => app().querySelector('button.tree-file'))
    expect(history.state).toEqual({ keyRemoved: true })
    fetchFn.mockClear()

    unloadPage()
    await openPage(window.location.hash, history.state)
    await waitFor(() => app().querySelector('#access-key'))
    expect(window.location.hash).toBe(link)
    expect(errorText()).toBe(
      "For safety, this link's key was removed from the address. Open the original link again, or enter the Access key."
    )
    expect(fetchFn).not.toHaveBeenCalled()

    submitKey(ACCESS_KEY_TEXT)
    await waitFor(() => app().querySelector('button.tree-file'))
  })

  it('refuses a wrong key without fetching, then opens with the right one', async () => {
    const { fetchFn } = await stubFetch()
    await openPage(`#v1/${CID}&d=${LINK_DATA}`)
    await waitFor(() => app().querySelector('#access-key'))

    submitKey(encodeAccessKey(new Uint8Array(32).fill(0x44)))
    await waitFor(() => errorText() === "That Access key doesn't open this share. Check it and try again.")
    expect(fetchFn).not.toHaveBeenCalled()

    submitKey(ACCESS_KEY_TEXT)
    await waitFor(() => app().querySelector('button.tree-file'))
  })

  it.each([`#v1/${CID}`, `#v1/${CID}&d=`, `#v1/${CID}&k=${ACCESS_KEY_TEXT}`])(
    'shows the incomplete-link screen for %j',
    async (hash) => {
      const { fetchFn } = await stubFetch()
      await openPage(hash)
      expect(app().textContent).toContain('This link is incomplete.')
      expect(fetchFn).not.toHaveBeenCalled()
    }
  )
})
