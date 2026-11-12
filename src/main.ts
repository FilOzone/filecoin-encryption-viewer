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

async function closeArchive(archive: ProtectedArchive): Promise<void> {
  if (activeArchive === archive) activeArchive = undefined
  await archive.close()
}

// A name of only spaces or dots would leave the browser to pick its own download name
function fileName(entry: ProtectedEntry): string {
  const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
  return /^[\s.]*$/.test(name) ? 'Decrypted file' : name
}

async function openAndRender(archive: ProtectedArchive, entry: ProtectedEntry, closeAfterOpen = false): Promise<void> {
  if (entry.directory) return
  try {
    if (entry.size <= MAX_DOCUMENT_PREVIEW_BYTES) {
      const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_DOCUMENT_PREVIEW_BYTES)
      renderContent(container, data, await detectContentType(data), fileName(entry), entry.path)
      if (closeAfterOpen) await closeArchive(archive)
      return
    }

    const detectedType = await detectContentType(await readEntryPrefix(await archive.open(entry.path)))
    if (entry.size <= MAX_BINARY_PREVIEW_BYTES) {
      if (isBinaryPreviewType(detectedType)) {
        const data = await readInlineEntry(await archive.open(entry.path), entry.size, MAX_BINARY_PREVIEW_BYTES)
        renderContent(container, data, detectedType, fileName(entry), entry.path)
        if (closeAfterOpen) await closeArchive(archive)
        return
      }
    }

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
            fileName(entry),
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
  try {
    return await save
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response)
    return 'cancelled'
  }
}

// The server answered a Range request with the whole encrypted file: offer the body already in flight as encrypted.fee.
function showRangeIgnored(response: Response): void {
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
  try {
    await openAndRender(archive, entry)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response)
    return
  }
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
  try {
    await unlock(cid, payload, accessKey)
  } catch (error) {
    if (!(error instanceof RangeUnsupportedError)) throw error
    showRangeIgnored(error.response)
  }
}

async function unlock(cid: string, payload: Uint8Array, accessKey: Uint8Array): Promise<void> {
  const startedAt = performance.now()
  const archive = import.meta.env.DEV
    ? await openProtectedArchive(cid, payload, accessKey, devFetch())
    : await openProtectedArchive(cid, payload, accessKey)
  if (import.meta.env.DEV)
    devLog(`archive ready (payload + head + metadata + decrypt + listing): ${elapsed(startedAt)}`)
  await activeArchive?.close()
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

// The key from a link, kept only so "Try again" can reuse it: the address bar no longer has it. Zeroed once done.
let linkKey: Uint8Array | undefined

function forgetLinkKey(): void {
  linkKey?.fill(0)
  linkKey = undefined
}

// The link carries its Access key: open with a copy of it (openProtectedArchive zeroes what it gets). A wrong key falls
// back to the prompt; a share that isn't available yet can be retried with the same key; anything else is final.
async function unlockWithKey(cid: string, payload: Uint8Array, accessKey: Uint8Array): Promise<void> {
  linkKey = accessKey
  showDecrypting(container)
  try {
    await unlockArchive(cid, payload, accessKey.slice())
  } catch (error) {
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
  forgetLinkKey()
}

function init(): void {
  const hash = window.location.hash
  const fragment = parseFragment(hash)
  if (!fragment) {
    showMissingLink(container)
    return
  }

  const { cid, payload, key } = fragment
  if (key) {
    // Before any request: a reload or a copy of the address no longer carries the key. `k` is always last.
    history.replaceState(null, '', hash.slice(0, hash.indexOf('&k=')))
    void unlockWithKey(cid, payload, key)
    return
  }
  showAccessKeyPrompt(container, (accessKey) => unlockArchive(cid, payload, accessKey))
}

window.addEventListener(
  'pagehide',
  () => {
    const archive = activeArchive
    activeArchive = undefined
    void archive?.close()
    forgetLinkKey()
    revokePdfObjectUrls()
    revokeStagedUrl()
    void removeOwnStagedFiles()
  },
  { once: true }
)

// A save staged by an earlier page is only deleted by a later save, startup or pagehide, see opfs-save.ts
void removeStagedFiles()
init()
