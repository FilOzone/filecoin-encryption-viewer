import type { ProtectedArchive, ProtectedEntry } from './car-archive.js'
import { openProtectedArchive } from './car-archive.js'
import { MAX_BINARY_PREVIEW_BYTES, MAX_DOCUMENT_PREVIEW_BYTES, readEntryPrefix, readInlineEntry } from './decrypt.js'
import { NotAvailableError, RangeUnsupportedError, WrongAccessKeyError } from './errors.js'
import { parseFragment } from './fragment.js'
import { removeOwnStagedFiles, removeStagedFiles } from './opfs-save.js'
import {
  detectContentType,
  isBinaryPreviewType,
  renderContent,
  revokePdfObjectUrls,
  revokeRenderedObjectUrls,
} from './render.js'
import { revokeStagedUrl, saveEntry } from './save.js'
import type { SaveResult } from './save.js'
import {
  addBackButton,
  showAccessKeyPrompt,
  showDecrypting,
  showLinkError,
  showMissingLink,
  showProtectedArchive,
  showRangeUnsupported,
  showSaveEntry,
  unlockErrorMessage,
} from './ui.js'
import { archiveZip, zipFileName } from './zip.js'

function getContainer(): HTMLElement {
  const element = document.getElementById('app')
  if (!element) throw new Error('Viewer root is missing')
  return element
}

const container = getContainer()
let activeArchive: ProtectedArchive | undefined
const folderState = new Map<string, boolean>()

// Bumped each time a share is closed. Async work notes it when it starts, and once it no longer matches (another link
// was opened), that work stops without touching the page.
let generation = 0
const isStale = (since: number) => since !== generation

// Aborted when the share is closed: its requests stop, including the body of a 200 still offered as encrypted.fee
let shareRequests = new AbortController()

async function closeArchive(archive: ProtectedArchive): Promise<void> {
  if (activeArchive === archive) activeArchive = undefined
  await archive.close()
}

const fileName = (entry: ProtectedEntry) => entry.path.split('/').at(-1) ?? 'Decrypted file'

async function openAndRender(archive: ProtectedArchive, entry: ProtectedEntry, closeAfterOpen = false): Promise<void> {
  if (entry.directory) return
  const since = generation
  try {
    if (entry.size <= MAX_DOCUMENT_PREVIEW_BYTES) {
      const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_DOCUMENT_PREVIEW_BYTES)
      const contentType = await detectContentType(data)
      if (isStale(since)) return
      renderContent(container, data, contentType, fileName(entry), entry.path)
      if (closeAfterOpen) await closeArchive(archive)
      return
    }

    const detectedType = await detectContentType(await readEntryPrefix(await archive.open(entry.path)))
    if (entry.size <= MAX_BINARY_PREVIEW_BYTES) {
      if (isBinaryPreviewType(detectedType)) {
        const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_BINARY_PREVIEW_BYTES)
        if (isStale(since)) return
        renderContent(container, data, detectedType, fileName(entry), entry.path)
        if (closeAfterOpen) await closeArchive(archive)
        return
      }
    }

    if (isStale(since)) return
    showSaveEntry(
      container,
      entry,
      async (onProgress) => {
        const result = await orRangeIgnored(
          saveEntry(
            {
              size: entry.size,
              contentType: entry.contentType,
              open: () => archive.open(entry.path),
            },
            entry.path.split('/').at(-1) ?? 'decrypted-content',
            onProgress
          )
        )
        if (result === 'saved' && closeAfterOpen) await closeArchive(archive)
        return result
      },
      false,
      detectedType
    )
  } catch (error) {
    if (closeAfterOpen) await closeArchive(archive)
    throw error
  }
}

// A 200 can also arrive while saving (a file or Download all): show the same screen instead of a save error
async function orRangeIgnored(save: Promise<SaveResult>): Promise<SaveResult> {
  const since = generation
  try {
    return await save
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response, since)
    return 'cancelled'
  }
}

// The server answered a Range request with the whole encrypted file: offer the body already in flight as encrypted.fee.
// Unless the share opened at `since` was replaced meanwhile: then the body is discarded.
function showRangeIgnored(response: Response, since: number): void {
  if (isStale(since)) {
    void response.body?.cancel().catch(() => undefined)
    return
  }
  const archive = activeArchive
  const length = Number(response.headers.get('content-length'))
  const size = length > 0 ? length : undefined
  showRangeUnsupported(container, size, (onProgress) =>
    saveEntry(
      {
        size: size ?? 0,
        contentType: 'application/octet-stream',
        open: async () => {
          if (!response.body || response.bodyUsed) throw new Error('The encrypted file was already read')
          return response.body
        },
      },
      'encrypted.fee',
      onProgress
    )
  )
  // Reached from inside a folder share: the tree is still there to go back to
  if (archive) addBackButton(container, () => showTree(archive))
}

// Folder shares keep the archive open: every file view gets a way back to the tree, with no new fetch.
async function openEntry(archive: ProtectedArchive, entry: ProtectedEntry): Promise<void> {
  const startedAt = performance.now()
  const since = generation
  try {
    await openAndRender(archive, entry)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response, since)
    return
  }
  if (isStale(since)) return
  if (import.meta.env.DEV) devLog(`open ${entry.path} (${entry.size} bytes): ${elapsed(startedAt)}`)
  addBackButton(container, () => showTree(archive))
}

function showTree(archive: ProtectedArchive): void {
  revokeRenderedObjectUrls(container)
  container.classList.remove('wide')
  showProtectedArchive(
    container,
    archive.list(),
    (entry) => openEntry(archive, entry),
    folderState,
    (onProgress) => downloadAll(archive, onProgress)
  )
}

// Zips the open archive straight into the save (picker, OPFS or, as a last resort, memory).
async function downloadAll(
  archive: ProtectedArchive,
  onProgress: (done: number, total: number) => void
): Promise<SaveResult> {
  return orRangeIgnored(saveEntry(archiveZip(archive, onProgress), zipFileName(archive)))
}

// Dev only (stripped from production builds, see scripts/check-dist.mjs): serve a local share.
const elapsed = (since: number) => `${Math.round(performance.now() - since)} ms`
const devLog = (message: string) => console.log(`[foc-viewer dev] ${message}`)

// Serves the range requests from the dev harness and logs each one (offset, length, time until headers).
// ?ignore-range makes the harness answer 200 with the whole file (opened from memory), and ?ignore-range=chunked the
// same without Content-Length, to see the "can't be opened" state. The value is passed on as given.
function devFetch(): typeof fetch {
  const ignoreRange = new URLSearchParams(window.location.search).get('ignore-range')
  const url = `/__dev-share${ignoreRange === null ? '' : `?${new URLSearchParams({ 'ignore-range': ignoreRange })}`}`
  return async (_input, init) => {
    const startedAt = performance.now()
    const response = await fetch(url, init)
    const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/)
    const what = range ? `offset ${range[1]}, length ${Number(range[2]) - Number(range[1]) + 1}` : 'no range'
    devLog(`range request (${what}) -> ${response.status}: ${elapsed(startedAt)}`)
    return response
  }
}

async function unlockArchive(cid: string, payload: Uint8Array, accessKey: Uint8Array): Promise<void> {
  const since = generation
  try {
    await unlock(cid, payload, accessKey)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response, since)
  }
}

async function unlock(cid: string, payload: Uint8Array, accessKey: Uint8Array): Promise<void> {
  const startedAt = performance.now()
  const since = generation
  const { signal } = shareRequests
  const fetchFn = import.meta.env.DEV ? devFetch() : fetch
  const archive = await openProtectedArchive(cid, payload, accessKey, (input, init) =>
    fetchFn(input, { ...init, signal })
  )
  if (import.meta.env.DEV)
    devLog(`archive ready (payload + head + metadata + decrypt + listing): ${elapsed(startedAt)}`)
  // Opened for a share that was replaced meanwhile: close it at once (zeroing its key), it never becomes active
  if (isStale(since)) return archive.close()
  void activeArchive?.close()
  activeArchive = archive
  const entries = archive.list()
  if (entries.length === 1 && !entries[0].directory) {
    await openAndRender(archive, entries[0], true)
    return
  }
  const listingStartedAt = performance.now()
  folderState.clear()
  showTree(archive)
  if (import.meta.env.DEV) {
    devLog(`render tree (${entries.length} entries): ${elapsed(listingStartedAt)}`)
    devLog(`unlock total: ${elapsed(startedAt)}`)
  }
}

const KEY_FAILED_MESSAGE = "The key in this link didn't work. Enter the Access key you received instead."
const KEY_REMOVED_MESSAGE =
  "For safety, this link's key was removed from the address. Open the original link again, or enter the Access key."

// The key from a link, kept only so "Try again" can reuse it: the address bar no longer has it. Zeroed once done.
let linkKey: Uint8Array | undefined

function forgetLinkKey(): void {
  linkKey?.fill(0)
  linkKey = undefined
}

// The link carries its Access key: open with a copy of it (openProtectedArchive zeroes what it gets). A wrong key falls
// back to the prompt; a share that isn't available yet can be retried with the same key; anything else is final.
async function unlockWithKey(cid: string, payload: Uint8Array, accessKey: Uint8Array): Promise<void> {
  const since = generation
  linkKey = accessKey
  showDecrypting(container)
  try {
    await unlockArchive(cid, payload, accessKey.slice())
  } catch (error) {
    // Replaced meanwhile: closing the share already zeroed this key, and linkKey may now be the next link's
    if (isStale(since)) return
    if (error instanceof NotAvailableError) {
      showLinkError(container, unlockErrorMessage(error), () => void unlockWithKey(cid, payload, accessKey))
      return
    }
    forgetLinkKey()
    if (error instanceof WrongAccessKeyError) {
      showAccessKeyPrompt(container, (key) => unlockArchive(cid, payload, key), KEY_FAILED_MESSAGE)
    } else {
      showLinkError(container, unlockErrorMessage(error))
    }
    return
  }
  if (!isStale(since)) forgetLinkKey()
}

// Ends the current share: aborts its requests, closes its archive (zeroing the piece key), forgets the link's key, and
// frees its object URLs. Work still running for it sees the new generation and stops. Finished saves are left alone:
// the browser may still be copying them, and the next save or leaving the page deletes them.
function closeShare(): void {
  generation++
  shareRequests.abort()
  shareRequests = new AbortController()
  const archive = activeArchive
  activeArchive = undefined
  void archive?.close()
  forgetLinkKey()
  revokeRenderedObjectUrls(container)
  revokePdfObjectUrls()
}

function leavePage(): void {
  closeShare()
  shownAddress = undefined
  revokeStagedUrl()
  void removeOwnStagedFiles()
}

// The share on screen, as its link without `k` (`#v1/<cid>&d=…`); undefined when no share is shown.
let shownAddress: string | undefined

// Opens the share in the address bar's fragment, at startup and on every fragment change (a pasted link, Back or
// Forward), after closing the one on screen.
function openShare(): void {
  const hash = window.location.hash
  const fragment = parseFragment(hash)
  // `k` is always last
  const address = fragment?.key ? hash.slice(0, hash.indexOf('&k=')) : hash
  if (fragment && !fragment.key && address === shownAddress) return

  closeShare()
  container.classList.remove('wide')
  shownAddress = fragment ? address : undefined
  if (!fragment) {
    showMissingLink(container)
    return
  }

  const { cid, payload, key } = fragment
  if (key) {
    // Before any request: a reload or a copy of the address no longer carries the key. The entry only records that it
    // had one, so a reload can say why the prompt is back.
    history.replaceState({ keyRemoved: true }, '', address)
    void unlockWithKey(cid, payload, key)
    return
  }
  const keyRemoved = (history.state as { keyRemoved?: unknown } | null)?.keyRemoved === true
  showAccessKeyPrompt(
    container,
    (accessKey) => unlockArchive(cid, payload, accessKey),
    keyRemoved ? KEY_REMOVED_MESSAGE : undefined
  )
}

window.addEventListener('hashchange', openShare)
window.addEventListener('pagehide', leavePage)
// Back to this page from the back-forward cache: the share was closed on pagehide, so open it again
window.addEventListener('pageshow', (event) => {
  if (event.persisted) openShare()
})

// A save staged by an earlier page is only deleted by a later save, startup or pagehide, see opfs-save.ts
void removeStagedFiles()
openShare()
