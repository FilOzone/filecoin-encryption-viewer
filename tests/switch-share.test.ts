// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProtectedArchive } from '../src/car-archive.js'
import type { parseFragment } from '../src/fragment.js'
import { expectSameBytes } from './fixtures/bytes.js'
import { ACCESS_KEY_TEXT, LINK_DATA, makeShare, plainGrant } from './fixtures/make-share.js'
import { type RangeStub, serveRange } from './fixtures/serve-range.js'
import { loadPage, unloadPage } from './fixtures/viewer-page.js'

// Two shares with their own CID, salt and payload, opened with the same Access key
const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const CID_B = 'bafkreignymhjvidv5bx5tvggzvob775a7avje43er4tvzyyww7af5vcksy'
const SALT_B = `0x${'08'.repeat(16)}` as const
const LINK_A = `#v1/${CID_A}&d=${LINK_DATA}`
const LINK_B = `#v1/${CID_B}&d=${Buffer.from(await plainGrant({ salt: SALT_B })).toString('base64url')}`
const text = (value: string) => new TextEncoder().encode(value)
const shareA = await makeShare([
  { path: 'docs/a.txt', content: text('alpha text') },
  { path: 'docs/other.txt', content: text('other text') },
])
const shareB = await makeShare([{ path: 'b.txt', content: text('beta text') }], { salt: SALT_B })

async function waitFor<T>(find: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for the page: ${app().textContent?.replace(/\s+/g, ' ')}`)
}

const app = () => document.getElementById('app') as HTMLElement
const shown = (content: string) => app().querySelector('pre')?.textContent === content

function submitKey(): void {
  ;(app().querySelector('#access-key') as HTMLInputElement).value = ACCESS_KEY_TEXT
  app()
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

// A link pasted into the address bar: a new history entry, then hashchange (which happy-dom also fires for pushState)
function navigate(hash: string): void {
  history.pushState(null, '', hash)
  window.dispatchEvent(new Event('hashchange'))
}

let opened: { cid: string; archive: ProtectedArchive; close: ReturnType<typeof vi.fn> }[]
let keys: Uint8Array[]
let requests: { cid: string; hash: string }[]
let holdA: Promise<void> | undefined
let revoked: string[]

beforeEach(() => {
  opened = []
  keys = []
  requests = []
  holdA = undefined
  revoked = []
  // Each share from its own stub (main.ts passes a dev fetch with no CID in it in tests, so it's replaced below); A's
  // requests wait for holdA when it's set. Records the address bar at every request.
  const stubs: Record<string, RangeStub> = { [CID_A]: serveRange(shareA), [CID_B]: serveRange(shareB) }
  const fetchFor =
    (cid: string): typeof fetch =>
    async (input, init) => {
      requests.push({ cid, hash: window.location.hash })
      if (cid === CID_A) await holdA
      return stubs[cid].fetch(input, init)
    }
  let urls = 0
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${++urls}`),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    })
  )
  // Every archive opened, from its share's stub, with a spy on its close(), and every link key parsed
  vi.doMock('../src/car-archive.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/car-archive.js')>()
    const openProtectedArchive: typeof original.openProtectedArchive = async (cid, payload, key) => {
      const archive = await original.openProtectedArchive(cid, payload, key, fetchFor(cid))
      opened.push({ cid, archive, close: vi.spyOn(archive, 'close') as ReturnType<typeof vi.fn> })
      return archive
    }
    return { ...original, openProtectedArchive }
  })
  vi.doMock('../src/fragment.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/fragment.js')>()
    const capture: typeof parseFragment = (hash) => {
      const result = original.parseFragment(hash)
      if (result?.key) keys.push(result.key)
      return result
    }
    return { ...original, parseFragment: capture }
  })
})

afterEach(() => {
  unloadPage()
  vi.doUnmock('../src/car-archive.js')
  vi.doUnmock('../src/fragment.js')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Opens A from its prompt, then its first file, which renders a.txt with a download object URL
async function openFileInA(): Promise<void> {
  await loadPage(LINK_A)
  submitKey()
  ;(await waitFor(() => app().querySelector<HTMLButtonElement>('button.tree-file'))).click()
  await waitFor(() => shown('alpha text'))
}

it("opens a pasted link's share in place of the open one, closing it and revoking its object URLs", async () => {
  await openFileInA()
  expect(revoked).toEqual([])

  navigate(LINK_B)
  await waitFor(() => app().querySelector('#access-key'))
  expect(app().textContent).not.toContain('alpha text')
  expect(app().classList.contains('wide')).toBe(false)
  expect(document.getElementById('card-label')?.childElementCount ?? 0).toBe(0)
  expect(opened[0].close).toHaveBeenCalled()
  expect(revoked).toContain('blob:1')

  submitKey()
  await waitFor(() => shown('beta text'))
  expect(app().querySelector('#back-btn')).toBeNull()
})

it('removes k from the address before the switched-to share is fetched, and opens it with no prompt', async () => {
  await openFileInA()
  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => shown('beta text'))

  expect(window.location.hash).toBe(LINK_B)
  const ofB = requests.filter((request) => request.cid === CID_B)
  expect(ofB.length).toBeGreaterThan(0)
  expect(ofB.every((request) => request.hash === LINK_B)).toBe(true)
  expect(document.body.innerHTML).not.toContain(ACCESS_KEY_TEXT)
})

it('never shows a share that finishes opening after it was replaced, and closes its archive', async () => {
  let release = () => {}
  holdA = new Promise((resolve) => {
    release = resolve
  })
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => requests.length > 0)

  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => shown('beta text'))
  // A's link key, kept for Try again, is zeroed when A is closed
  expectSameBytes(keys[0], new Uint8Array(32))

  release()
  const lateA = await waitFor(() => opened.find((entry) => entry.cid === CID_A))
  await waitFor(() => lateA.close.mock.calls.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(shown('beta text')).toBe(true)
  expect(app().querySelector('button.tree-file')).toBeNull()
  expect(app().querySelector('#link-error')).toBeNull()
})

it('shows the incomplete-link screen for an invalid new fragment', async () => {
  await openFileInA()
  navigate('#nope')
  await waitFor(() => app().textContent?.includes('This link is incomplete.'))
  expect(app().textContent).not.toContain('alpha text')
  expect(opened[0].close).toHaveBeenCalled()
})

it("reopens A on Back, at its prompt since A's address no longer has its key", async () => {
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => app().querySelector('button.tree-file'))
  navigate(LINK_B)
  await waitFor(() => app().querySelector('#access-key'))
  submitKey()
  await waitFor(() => shown('beta text'))

  history.back()
  await waitFor(() => window.location.hash === LINK_A && app().querySelector('#access-key'))
  expect(app().textContent).not.toContain('beta text')
  submitKey()
  await waitFor(() => app().querySelector('button.tree-file'))
})

it("doesn't reopen the share on a hashchange to the address it already shows, as after removing k", async () => {
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => app().querySelector('button.tree-file'))
  const before = requests.length

  window.dispatchEvent(new Event('hashchange'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(opened).toHaveLength(1)
  expect(opened[0].close).not.toHaveBeenCalled()
  expect(requests).toHaveLength(before)
  expect(app().querySelector('button.tree-file')).not.toBeNull()
})
