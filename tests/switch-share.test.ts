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

// Runs the promise continuations queued by work that just finished, so a stale path has had its chance to act
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const app = () => document.getElementById('app') as HTMLElement
const shown = (content: string) => app().querySelector('pre')?.textContent === content
const tree = () => app().querySelector<HTMLButtonElement>('button.tree-file')

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
let openings: { cid: string; opening: Promise<ProtectedArchive> }[]
let keys: Uint8Array[]
let requests: { cid: string; hash: string; signal?: AbortSignal | null }[]
let holds: Record<string, Promise<void>>
let detections: Promise<string>[]
let sniffing: Promise<void> | undefined
let revoked: string[]
let removeOwnStagedFiles: ReturnType<typeof vi.fn>
// A answers its requests with a 200 and the whole file, without Content-Length; cancelledBodies counts its cancels
let wholeA: boolean
let cancelledBodies: number

const requestsOf = (cid: string) => requests.filter((request) => request.cid === cid)

// The share's requests wait until release(), or fail as the network would on fail()
function hold(cid: string) {
  const held = { release: () => {}, fail: () => {} }
  holds[cid] = new Promise((resolve, reject) => {
    held.release = resolve
    held.fail = () => reject(new TypeError('Failed to fetch'))
  })
  return held
}

function wholeFile(): Response {
  const body = new ReadableStream({
    pull: (controller) => controller.enqueue(shareA.subarray(0, 1024)),
    cancel: () => void cancelledBodies++,
  })
  return new Response(body, { status: 200 })
}

beforeEach(() => {
  opened = []
  openings = []
  keys = []
  requests = []
  holds = {}
  detections = []
  sniffing = undefined
  revoked = []
  wholeA = false
  cancelledBodies = 0
  // main.ts's fetch (in tests the dev one, with no CID in its URL) reaches the global fetch, which serves each share
  // from its own stub; the share comes along as a header. Records the address bar and the signal at every request.
  const stubs: Record<string, RangeStub> = { [CID_A]: serveRange(shareA), [CID_B]: serveRange(shareB) }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const cid = new Headers(init?.headers).get('x-share') as string
    requests.push({ cid, hash: window.location.hash, signal: init?.signal })
    await holds[cid]
    if (cid === CID_A && wholeA) return wholeFile()
    return stubs[cid].fetch(input, init)
  })
  let urls = 0
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${++urls}`),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    })
  )
  // Every archive opened, with a spy on its close(), and every link key parsed
  vi.doMock('../src/car-archive.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/car-archive.js')>()
    const openProtectedArchive: typeof original.openProtectedArchive = async (cid, payload, key, fetchFn = fetch) => {
      const opening = original.openProtectedArchive(cid, payload, key, (input, init) =>
        fetchFn(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-share': cid } })
      )
      openings.push({ cid, opening })
      const archive = await opening
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
  // A file's content type is sniffed once its bytes are read, right before it's shown; it waits for `sniffing`
  vi.doMock('../src/render.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/render.js')>()
    const detectContentType: typeof original.detectContentType = (data) => {
      const detection = (async () => {
        await sniffing
        return original.detectContentType(data)
      })()
      detections.push(detection)
      return detection
    }
    return { ...original, detectContentType }
  })
  removeOwnStagedFiles = vi.fn(async () => {})
  vi.doMock('../src/opfs-save.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/opfs-save.js')>()),
    removeOwnStagedFiles,
  }))
})

afterEach(() => {
  unloadPage()
  vi.doUnmock('../src/car-archive.js')
  vi.doUnmock('../src/fragment.js')
  vi.doUnmock('../src/render.js')
  vi.doUnmock('../src/opfs-save.js')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Opens A from its prompt, then its first file, which renders a.txt with a download object URL
async function openFileInA(): Promise<void> {
  await loadPage(LINK_A)
  submitKey()
  ;(await waitFor(tree)).click()
  await waitFor(() => shown('alpha text'))
}

it("opens a pasted link's share in place of the open one, closing it and revoking its object URLs", async () => {
  await openFileInA()
  expect(revoked).toEqual([])
  expect(document.getElementById('card-label')?.childElementCount).toBe(1)

  navigate(LINK_B)
  await waitFor(() => app().querySelector('#access-key'))
  expect(app().textContent).not.toContain('alpha text')
  expect(app().classList.contains('wide')).toBe(false)
  expect(document.getElementById('card-label')?.childElementCount).toBe(0)
  expect(opened[0].close).toHaveBeenCalled()
  expect(revoked).toContain('blob:1')
  // Finished saves stay until the next save or pagehide: the browser may still be copying them
  expect(removeOwnStagedFiles).not.toHaveBeenCalled()

  submitKey()
  await waitFor(() => shown('beta text'))
  expect(app().querySelector('#back-btn')).toBeNull()
})

it('removes k from the address before the switched-to share is fetched, and opens it with no prompt', async () => {
  await openFileInA()
  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => shown('beta text'))

  expect(window.location.hash).toBe(LINK_B)
  const ofB = requestsOf(CID_B)
  expect(ofB.length).toBeGreaterThan(0)
  expect(ofB.every((request) => request.hash === LINK_B)).toBe(true)
  expect(document.body.innerHTML).not.toContain(ACCESS_KEY_TEXT)
})

// A with its key starts opening, then B's link (with its key) replaces it while both are still fetching
async function replaceOpeningA() {
  const a = hold(CID_A)
  const b = hold(CID_B)
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => requestsOf(CID_A).length > 0)
  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => requestsOf(CID_B).length > 0)
  return { a, b }
}

it('aborts the replaced share and never lets its late success touch the new one', async () => {
  const { a, b } = await replaceOpeningA()
  expect(requestsOf(CID_A)[0].signal?.aborted).toBe(true)
  expect(requestsOf(CID_B)[0].signal?.aborted).toBe(false)
  // A's link key, kept for Try again, is zeroed when A is closed
  expectSameBytes(keys[0], new Uint8Array(32))

  // The stub ignores the abort, as a response already on its way would: A finishes opening
  a.release()
  const lateA = await waitFor(() => opened.find((entry) => entry.cid === CID_A))
  await waitFor(() => lateA.close.mock.calls.length > 0)
  await settle()
  expect(keys[1].some((byte) => byte !== 0)).toBe(true)
  expect(tree()).toBeNull()

  b.release()
  await waitFor(() => shown('beta text'))
  expect(tree()).toBeNull()
  expect(app().querySelector('#link-error')).toBeNull()
})

it("never lets the replaced share's failure touch the new one", async () => {
  const { a, b } = await replaceOpeningA()
  a.fail()
  await openings[0].opening.catch(() => undefined)
  await settle()
  expect(app().querySelector('#link-error')).toBeNull()
  expect(app().querySelector('#access-key')).toBeNull()
  expect(keys[1].some((byte) => byte !== 0)).toBe(true)

  b.release()
  await waitFor(() => shown('beta text'))
})

it('cancels the body of a 200 that arrives for a share already replaced', async () => {
  wholeA = true
  const a = hold(CID_A)
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => requestsOf(CID_A).length > 0)
  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => shown('beta text'))

  a.release()
  await waitFor(() => cancelledBodies === 1)
  expect(shown('beta text')).toBe(true)
  expect(app().querySelector('#save-encrypted')).toBeNull()
})

it('aborts the 200 offered as encrypted.fee when the share is replaced', async () => {
  wholeA = true
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(() => app().querySelector('#save-encrypted'))
  const [head] = requestsOf(CID_A)
  expect(head.signal?.aborted).toBe(false)

  navigate(LINK_B)
  expect(head.signal?.aborted).toBe(true)
})

it('never shows a file of the replaced share that was read just before the switch', async () => {
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  const file = await waitFor(tree)
  let sniffed = () => {}
  sniffing = new Promise((resolve) => {
    sniffed = resolve
  })
  file.click()
  await waitFor(() => detections.length === 1)
  const sniffA = detections[0]
  navigate(`${LINK_B}&k=${ACCESS_KEY_TEXT}`)
  sniffing = undefined
  await waitFor(() => shown('beta text'))

  sniffed()
  await sniffA
  await settle()
  expect(shown('beta text')).toBe(true)
  expect(app().querySelector('#back-btn')).toBeNull()
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
  await waitFor(tree)
  navigate(LINK_B)
  await waitFor(() => app().querySelector('#access-key'))
  // Only A's history entry records that its key was removed
  expect((app().querySelector('#error') as HTMLElement).hidden).toBe(true)
  submitKey()
  await waitFor(() => shown('beta text'))

  history.back()
  await waitFor(() => window.location.hash === LINK_A && app().querySelector('#access-key'))
  expect(app().textContent).not.toContain('beta text')
  expect(app().querySelector('#error')?.textContent).toContain("this link's key was removed")
  submitKey()
  await waitFor(tree)
})

it("doesn't reopen the share on a hashchange to the address it already shows, as after removing k", async () => {
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(tree)
  const before = requests.length

  window.dispatchEvent(new Event('hashchange'))
  expect(opened).toHaveLength(1)
  expect(opened[0].close).not.toHaveBeenCalled()
  expect(requests).toHaveLength(before)
  expect(tree()).not.toBeNull()
})

it('closes the share on every pagehide, and opens it again when the page comes back from the back-forward cache', async () => {
  await loadPage(`${LINK_A}&k=${ACCESS_KEY_TEXT}`)
  await waitFor(tree)

  window.dispatchEvent(new Event('pagehide'))
  expect(opened[0].close).toHaveBeenCalled()
  expect(removeOwnStagedFiles).toHaveBeenCalledTimes(1)

  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  await waitFor(() => app().querySelector('#access-key'))
  expect(app().querySelector('#error')?.textContent).toContain("this link's key was removed")
  submitKey()
  await waitFor(tree)

  window.dispatchEvent(new Event('pagehide'))
  expect(opened[1].close).toHaveBeenCalled()
  expect(removeOwnStagedFiles).toHaveBeenCalledTimes(2)
})
