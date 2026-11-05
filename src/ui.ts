import type { ProtectedEntry } from './car-archive.js'
import { clearCardLabel, setCardLabel } from './card-label.js'
import {
  DamagedLinkError,
  GatewayInactiveError,
  NotAShareError,
  NotAvailableError,
  OtherUploadError,
  ShareExpiredError,
  ShareModifiedError,
  TooLargeError,
  TooManyEntriesError,
  WrongAccessKeyError,
} from './errors.js'
import { fileTypeLabel } from './file-type.js'
import { formatBytes } from './format.js'
import { decodeAccessKey } from './fragment.js'
import type { SaveResult } from './save.js'

const HERO_URL = new URL('../assets/filecoin-private-sharing.svg', import.meta.url).href

const hero = (small = false) =>
  `<img class="hero${small ? ' small' : ''}" src="${HERO_URL}" alt="" width="600" height="354" decoding="async" />`

const ICON =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
const LOCK_ICON = `<svg ${ICON}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>`
const SHIELD_ICON = `<svg ${ICON}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>`

// The Filecoin ƒ mark, adapted from filecoin-pay-explorer's filecoin-logo.svg (circle and mask removed)
const FILECOIN_ICON = `<svg viewBox="9.4 5.3 21.5 29.3" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M21.9 17.6l-.6 3.2 5.7.8-.4 1.5-5.6-.8c-.4 1.3-.6 2.7-1.1 3.9-.5 1.4-1 2.8-1.6 4.1-.8 1.7-2.2 2.9-4.1 3.2-1.1.2-2.3.1-3.2-.6-.3-.2-.6-.6-.6-.9 0-.4.2-.9.5-1.1.2-.1.7 0 1 .1.3.3.6.7.8 1.1.6.8 1.4.9 2.2.3.9-.8 1.4-1.9 1.7-3 .6-2.4 1.2-4.7 1.7-7.1v-.4l-5.3-.8.2-1.5 5.5.8.7-3.1-5.7-.9.2-1.6 5.9.8c.2-.6.3-1.1.5-1.6.5-1.8 1-3.6 2.2-5.2 1.2-1.6 2.6-2.6 4.7-2.5.9 0 1.8.3 2.4 1 .1.1.3.3.3.5 0 .4 0 .9-.3 1.2-.4.3-.9.2-1.3-.2-.3-.3-.5-.6-.8-.9-.6-.8-1.5-.9-2.2-.2-.5.5-1 1.2-1.3 1.9-.7 2.1-1.2 4.3-1.9 6.5l5.5.8-.4 1.5-5.3-.8" /></svg>`

const features = () => `
  <ul class="features">
    <li><span class="feature-icon">${LOCK_ICON}</span>End-to-end<br />encryption</li>
    <li><span class="feature-icon">${FILECOIN_ICON}</span>Filecoin<br />network</li>
    <li><span class="feature-icon">${SHIELD_ICON}</span>Your privacy<br />matters</li>
  </ul>`

export const TOO_LARGE_MESSAGE = 'This file is too large to save in this browser. Use `filecoin-pin decrypt` instead.'
const EMPTY_KEY_ERROR = 'Enter the Access key you received from the sender.'

/** The message for a known error class, else `fallback`. */
export function unlockErrorMessage(
  cause: unknown,
  fallback = 'Something went wrong opening this share. Try again.'
): string {
  if (cause instanceof WrongAccessKeyError) {
    return "That Access key doesn't open this share. Check it and try again."
  }
  if (cause instanceof OtherUploadError) {
    return 'This link is for another upload. Ask the sender for the right link.'
  }
  if (cause instanceof ShareExpiredError) {
    return 'This share has expired. Ask the sender for a new link.'
  }
  if (cause instanceof DamagedLinkError) {
    return 'This link is damaged. Copy it again, or ask the sender for a new one.'
  }
  if (cause instanceof ShareModifiedError) {
    return 'This share is damaged or was modified, so it was not opened.'
  }
  if (cause instanceof NotAvailableError) {
    return "This share isn't available yet, or the download was interrupted. Try again in a few minutes."
  }
  if (cause instanceof GatewayInactiveError) {
    return "This page isn't connected to the Filecoin gateway yet. Open the link again, or reload the page."
  }
  if (cause instanceof TooLargeError) {
    return TOO_LARGE_MESSAGE
  }
  if (cause instanceof TooManyEntriesError) {
    return 'This share has too many files, or folders nested too deeply, to open in the browser. Use `filecoin-pin decrypt`.'
  }
  if (cause instanceof NotAShareError) {
    return "This link doesn't point to a filecoin-pin encrypted share."
  }
  return fallback
}

/**
 * Checks a pasted Access key locally, the way filecoin-pin's parseAccessKey does: its 32 bytes, or what to tell the
 * user. Whitespace is dropped, since keys get wrapped and indented when pasted.
 */
export function readAccessKey(text: string): Uint8Array | string {
  const clean = text.replace(/\s+/g, '')
  if (!clean) return EMPTY_KEY_ERROR
  if (clean.startsWith('fgr1_')) return "That's a group key Grant, not an Access key."
  if (clean.includes('#v1/')) return "That's a Share link, not an Access key."
  if (!clean.startsWith('fak1_')) return 'An Access key starts with fak1_'
  return decodeAccessKey(clean) ?? 'This Access key is incomplete. Copy it again.'
}

export function showAccessKeyPrompt(
  container: HTMLElement,
  onSubmit: (accessKey: Uint8Array) => Promise<void>,
  notice?: string
): void {
  clearCardLabel()
  container.innerHTML = `
    <form class="key-form">
      ${hero()}
      <p class="eyebrow center">Encrypted share</p>
      <h1 class="big center">Unlock this share</h1>
      <p class="lede center">
        <span>The data is encrypted and stored on Filecoin.</span>
        <span>Use the Access key the sender gave you separately.</span>
        <span>Decryption happens in your browser.</span>
      </p>
      ${features()}
      <label for="access-key">Access key</label>
      <div class="key-input">
        <input type="password" id="access-key" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="fak1_…" />
        <button class="key-toggle" id="key-toggle" type="button" aria-label="Show Access key" aria-pressed="false">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M2.7 12s3.4-5.2 9.3-5.2S21.3 12 21.3 12s-3.4 5.2-9.3 5.2S2.7 12 2.7 12Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
            <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.7" />
          </svg>
        </button>
      </div>
      <button class="btn-primary" id="view-btn" type="submit">Unlock</button>
      <p class="error" id="error" role="alert" hidden></p>
      <p class="hint">${LOCK_ICON}Only someone with the Access key can unlock this share.</p>
    </form>
  `

  const form = container.querySelector('form') as HTMLFormElement
  const keyInput = container.querySelector('#access-key') as HTMLInputElement
  const button = container.querySelector('#view-btn') as HTMLButtonElement
  const keyToggle = container.querySelector('#key-toggle') as HTMLButtonElement
  const error = container.querySelector('#error') as HTMLParagraphElement
  const showError = (message: string) => {
    error.textContent = message
    error.hidden = false
  }
  if (notice) showError(notice)
  keyInput.focus()

  keyToggle.addEventListener('click', () => {
    const showKey = keyInput.type === 'password'
    const { selectionStart, selectionEnd } = keyInput
    keyInput.type = showKey ? 'text' : 'password'
    keyToggle.setAttribute('aria-label', showKey ? 'Hide Access key' : 'Show Access key')
    keyToggle.setAttribute('aria-pressed', String(showKey))
    keyInput.focus()
    if (selectionStart !== null && selectionEnd !== null) {
      keyInput.setSelectionRange(selectionStart, selectionEnd)
    }
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (button.disabled) return

    const accessKey = readAccessKey(keyInput.value)
    if (typeof accessKey === 'string') {
      showError(accessKey)
      return
    }

    button.disabled = true
    button.textContent = 'Decrypting…'
    error.hidden = true
    try {
      await onSubmit(accessKey)
    } catch (cause) {
      showError(unlockErrorMessage(cause))
      if (cause instanceof WrongAccessKeyError) keyInput.select()
    } finally {
      button.disabled = false
      button.textContent = 'Unlock'
    }
  })
}

/** Shown while a link that carries its Access key opens the share, before there is a tree or a file. */
export function showDecrypting(container: HTMLElement): void {
  clearCardLabel()
  container.innerHTML = `
    <div class="missing-link center">
      ${hero(true)}
      <p class="eyebrow">Encrypted share</p>
      <h1>Decrypting…</h1>
      <p class="lede">Opening this share in your browser.</p>
    </div>
  `
}

export function showMissingLink(container: HTMLElement): void {
  clearCardLabel()
  container.innerHTML = `
    <div class="missing-link center">
      ${hero(true)}
      <p class="eyebrow">Encrypted share</p>
      <h1>This link is incomplete.</h1>
      <p class="lede">Ask the sender for the full protected-share link and open it again.</p>
    </div>
  `
}

/** A link that can't be opened; `onRetry` adds a "Try again" button (for a share that isn't available yet). */
export function showLinkError(container: HTMLElement, message: string, onRetry?: () => void): void {
  clearCardLabel()
  container.innerHTML = `
    <div class="missing-link center">
      ${hero(true)}
      <p class="eyebrow">Encrypted share</p>
      <h1>This share can't be opened.</h1>
      <p class="lede" id="link-error"></p>
      ${onRetry ? '<button class="btn-primary" id="retry-btn" type="button">Try again</button>' : ''}
    </div>
  `
  ;(container.querySelector('#link-error') as HTMLParagraphElement).textContent = message
  if (onRetry) container.querySelector('#retry-btn')?.addEventListener('click', onRetry, { once: true })
}

interface ArchiveTreeNode {
  name: string
  path: string
  entry?: ProtectedEntry
  children: Map<string, ArchiveTreeNode>
}

const AUTO_OPEN_DEPTH = 1
const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'
const FOLDER_ICON = `<svg ${ICON_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>`
const FILE_ICON = `<svg ${ICON_ATTRS}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>`

function buildArchiveTree(entries: readonly ProtectedEntry[]): Map<string, ArchiveTreeNode> {
  const roots = new Map<string, ArchiveTreeNode>()
  for (const entry of entries) {
    const path = entry.directory ? entry.path.slice(0, -1) : entry.path
    const segments = path.split('/')
    let level = roots
    for (const [index, segment] of segments.entries()) {
      let node = level.get(segment)
      if (!node) {
        node = { name: segment, path: segments.slice(0, index + 1).join('/'), children: new Map() }
        level.set(segment, node)
      }
      if (index === segments.length - 1) node.entry = entry
      level = node.children
    }
  }
  return roots
}

const isDirectory = (node: ArchiveTreeNode) => node.children.size > 0 || node.entry?.directory === true

// Folders first, then files; case-insensitive
function sortNodes(nodes: Map<string, ArchiveTreeNode>): ArchiveTreeNode[] {
  return [...nodes.values()].sort(
    (left, right) =>
      Number(isDirectory(right)) - Number(isDirectory(left)) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

function createName(name: string): HTMLSpanElement {
  const label = document.createElement('span')
  label.className = 'tree-name'
  label.textContent = name
  label.title = name
  return label
}

function createFileItem(
  node: ArchiveTreeNode,
  entry: ProtectedEntry,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement
): HTMLLIElement {
  const item = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tree-file'
  button.insertAdjacentHTML('afterbegin', FILE_ICON)
  const size = document.createElement('span')
  size.className = 'tree-size'
  size.textContent = formatBytes(entry.size)
  button.append(createName(node.name), size)
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    error.hidden = true
    try {
      await onSelect(entry)
    } catch (cause) {
      error.textContent = unlockErrorMessage(cause, 'This file could not be opened.')
      error.hidden = false
    } finally {
      if (button.isConnected) button.disabled = false
    }
  })
  item.append(button)
  return item
}

function createFolderItem(
  node: ArchiveTreeNode,
  depth: number,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement,
  folderState: Map<string, boolean>
): HTMLLIElement {
  const item = document.createElement('li')
  const details = document.createElement('details')
  details.open = folderState.get(node.path) ?? depth <= AUTO_OPEN_DEPTH
  details.addEventListener('toggle', () => folderState.set(node.path, details.open))
  const summary = document.createElement('summary')
  summary.insertAdjacentHTML('afterbegin', FOLDER_ICON)
  summary.append(createName(node.name))
  details.append(summary)
  details.append(createTreeList(node.children, depth + 1, onSelect, error, folderState))
  item.append(details)
  return item
}

function createTreeList(
  nodes: Map<string, ArchiveTreeNode>,
  depth: number,
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  error: HTMLParagraphElement,
  folderState: Map<string, boolean>
): HTMLUListElement {
  const list = document.createElement('ul')
  for (const node of sortNodes(nodes)) {
    if (isDirectory(node)) list.append(createFolderItem(node, depth, onSelect, error, folderState))
    else if (node.entry) list.append(createFileItem(node, node.entry, onSelect, error))
  }
  return list
}

/**
 * Renders the share as a nested tree. `folderState` remembers which folders the user opened or
 * closed, so a caller can pass the same map again to restore the tree after leaving a file view.
 */
export function showProtectedArchive(
  container: HTMLElement,
  entries: readonly ProtectedEntry[],
  onSelect: (entry: ProtectedEntry) => Promise<void>,
  folderState: Map<string, boolean> = new Map(),
  onDownloadAll?: (onProgress: (done: number, total: number) => void) => Promise<SaveResult>
): void {
  setCardLabel('Encrypted share')
  container.classList.add('tree-card')
  container.innerHTML = `
    <div class="content-wrapper">
      ${treeHeaderMarkup(entries, Boolean(onDownloadAll) && entries.length > 0)}
      <div id="archive-tree" aria-label="Protected files"></div>
      <p class="error" id="archive-error" role="alert" hidden></p>
    </div>
  `

  const tree = container.querySelector('#archive-tree') as HTMLDivElement
  const error = container.querySelector('#archive-error') as HTMLParagraphElement
  if (entries.length === 0) {
    tree.textContent = 'This protected folder is empty.'
    return
  }
  tree.append(createTreeList(buildArchiveTree(entries), 0, onSelect, error, folderState))
  if (onDownloadAll) wireDownloadAll(container, onDownloadAll)
}

const DOWNLOAD_ICON = `<svg ${ICON_ATTRS}><path d="M12 4v11" /><path d="M7 10.5l5 5 5-5" /><path d="M5 20h14" /></svg>`

// File count on the left, compact zip action on the right. The page's <h1> is the label above the card.
function treeHeaderMarkup(entries: readonly ProtectedEntry[], withDownloadAll: boolean): string {
  const files = entries.filter((entry) => !entry.directory)
  const folders = entries.length - files.length
  const bytes = files.reduce((total, entry) => total + entry.size, 0)
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const summary =
    entries.length > 0
      ? `<p class="tree-summary">${count(folders, 'folder')} · ${count(files.length, 'file')} · ${formatBytes(bytes)}</p>`
      : ''
  const action = withDownloadAll
    ? `<button type="button" class="btn-compact" id="download-all" aria-label="Download all files as a zip">${DOWNLOAD_ICON}<span class="btn-label">Download all</span></button>`
    : ''
  return `
      <div class="tree-head">
        <div class="tree-head-row">
          ${summary}
          ${action}
        </div>
        ${withDownloadAll ? '<p class="zip-status" id="zip-status" role="status"></p>' : ''}
      </div>`
}

function wireDownloadAll(
  container: HTMLElement,
  onDownloadAll: (onProgress: (done: number, total: number) => void) => Promise<SaveResult>
): void {
  const button = container.querySelector('#download-all') as HTMLButtonElement | null
  const status = container.querySelector('#zip-status') as HTMLParagraphElement | null
  const label = button?.querySelector('.btn-label')
  if (!button || !status || !label) return
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    label.textContent = 'Preparing…'
    status.textContent = ''
    try {
      const result = await onDownloadAll((done, total) => {
        status.textContent = `Adding files: ${done} of ${total}`
      })
      status.textContent = result === 'cancelled' ? '' : 'Zip ready.'
    } catch (cause) {
      status.textContent =
        cause instanceof TooLargeError
          ? 'These files are too large to zip in this browser. Use `filecoin-pin decrypt` instead.'
          : unlockErrorMessage(cause, 'The zip could not be created. Try again.')
    } finally {
      button.disabled = false
      label.textContent = 'Download all'
    }
  })
}

/** Puts an "All files" button at the top of the current card; the caller decides what going back does. */
export function addBackButton(container: HTMLElement, onBack: () => void): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = 'back-btn'
  button.className = 'back-btn'
  button.textContent = '← All files'
  button.addEventListener('click', onBack)
  container.prepend(button)
}

// Staging only starts the download once the whole file is written, so show how far along it is
function progressText(verb: string, written: number, size: number | undefined): string {
  return size ? `${verb}… ${Math.min(100, Math.floor((written / size) * 100))}%` : `${verb}… ${formatBytes(written)}`
}

export function showSaveEntry(
  container: HTMLElement,
  entry: ProtectedEntry,
  onSave: (onProgress: (written: number) => void) => Promise<SaveResult>,
  previewFailed = false,
  detectedType: string | undefined = undefined
): void {
  const actionLabel = previewFailed ? 'Download instead' : 'Download file'
  setCardLabel('Encrypted share')
  container.innerHTML = `
    <div class="content-wrapper">
      <h1 class="file-title" id="save-entry-name"></h1>
      <p class="lede-left">${fileTypeLabel(detectedType)} · ${formatBytes(entry.size)}</p>
      ${previewFailed ? '<p class="lede-left note">Preview unavailable.</p>' : ''}
      <button class="btn-primary" id="save-entry" type="button">${actionLabel}</button>
      <p class="hint" id="save-status" role="status"></p>
      <p class="error" id="save-error" role="alert" hidden></p>
    </div>
  `

  const name = container.querySelector('#save-entry-name') as HTMLHeadingElement
  const button = container.querySelector('#save-entry') as HTMLButtonElement
  const status = container.querySelector('#save-status') as HTMLParagraphElement
  const error = container.querySelector('#save-error') as HTMLParagraphElement
  name.textContent = entry.path.split('/').at(-1) ?? entry.path
  name.title = entry.path
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    button.textContent = 'Saving…'
    error.hidden = true
    status.textContent = ''
    try {
      const result = await onSave((written) => {
        status.textContent = progressText('Decrypting', written, entry.size)
      })
      status.textContent = result === 'saved' ? 'Saved.' : ''
    } catch (cause) {
      status.textContent = ''
      error.textContent = unlockErrorMessage(cause, 'This file could not be saved.')
      error.hidden = false
    } finally {
      button.disabled = false
      button.textContent = actionLabel
    }
  })
}

/**
 * The server ignored the Range request and sent the whole encrypted file. `size` is its Content-Length, if known;
 * `onSave` saves the response body already in flight as `encrypted.fee`.
 */
export function showRangeUnsupported(
  container: HTMLElement,
  size: number | undefined,
  onSave: (onProgress: (written: number) => void) => Promise<SaveResult>
): void {
  const label = size ? `Download encrypted file (${formatBytes(size)})` : 'Download encrypted file'
  setCardLabel('Encrypted share')
  container.innerHTML = `
    <div class="content-wrapper">
      <h1 class="file-title">This share can't be opened in the browser</h1>
      <p class="lede-left">The server sent the whole encrypted file instead of the parts the Viewer asked for. You can download the encrypted file and decrypt it on your computer with your Access key.</p>
      <button class="btn-primary" id="save-encrypted" type="button">${label}</button>
      <p class="hint" id="save-status" role="status"></p>
      <p class="error" id="save-error" role="alert" hidden></p>
      <p class="lede-left note">Then run: <code>npx filecoin-pin decrypt encrypted.fee ./shared</code></p>
    </div>
  `

  const button = container.querySelector('#save-encrypted') as HTMLButtonElement
  const status = container.querySelector('#save-status') as HTMLParagraphElement
  const error = container.querySelector('#save-error') as HTMLParagraphElement
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    button.textContent = 'Saving…'
    error.hidden = true
    status.textContent = ''
    try {
      const result = await onSave((written) => {
        status.textContent = progressText('Downloading', written, size)
      })
      status.textContent = result === 'saved' ? 'Saved.' : ''
    } catch (cause) {
      status.textContent = ''
      error.textContent =
        cause instanceof TooLargeError
          ? 'This file is too large to save in this browser. Use `filecoin-pin` to fetch it instead.'
          : 'This file could not be saved.'
      error.hidden = false
    } finally {
      button.disabled = false
      button.textContent = label
    }
  })
}
