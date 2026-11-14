import { filetypemime } from 'magic-bytes.js'
import { setCardLabel } from './card-label.js'
import { fileTypeLabel } from './file-type.js'
import { formatBytes } from './format.js'
import { createLockedHtmlFrame } from './sandbox.js'

const activeObjectUrls = new WeakMap<HTMLElement, string[]>()
// A PDF opens in a new tab that may still be loading its blob URL, so these outlive the view (revoked on pagehide).
const pdfObjectUrls = new Set<string>()

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
const hasPdfSignature = (data: Uint8Array) => PDF_SIGNATURE.every((byte, index) => data[index] === byte)

export function revokePdfObjectUrls(): void {
  for (const objectUrl of pdfObjectUrls) URL.revokeObjectURL(objectUrl)
  pdfObjectUrls.clear()
}

const PDF_ICON = `<svg class="pdf-icon" viewBox="0 0 72 72" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 8h25l15 15v37a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" /><path d="M43 8v15h15" /><rect x="22" y="40" width="28" height="15" rx="3" fill="currentColor" stroke="none" /><text x="36" y="51.5" text-anchor="middle" class="pdf-icon-label" stroke="none">PDF</text></svg>`
const EXTERNAL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>`

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function revokeRenderedObjectUrls(container: HTMLElement): void {
  for (const objectUrl of activeObjectUrls.get(container) ?? []) URL.revokeObjectURL(objectUrl)
  activeObjectUrls.delete(container)
}

export async function detectContentType(data: Uint8Array): Promise<string> {
  const mimes = filetypemime(Array.from(data.slice(0, 100)))
  if (mimes.length > 0) return mimes[0]

  const prefix = new TextDecoder().decode(data.slice(0, 15)).trimStart().toLowerCase()
  if (prefix.startsWith('<!doctype') || prefix.startsWith('<html')) return 'text/html'

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return 'text/plain'
  } catch {
    return 'application/octet-stream'
  }
}

// Blob URLs share the Viewer's origin, and a text/html or image/svg+xml blob opened in a tab runs its scripts there.
// So only these types ever get a typed blob (as a preview source); every Download link is application/octet-stream,
// and SVG and other XML are shown as source text.
const RASTER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const XML_TYPES = new Set(['image/svg+xml', 'application/xml', 'text/xml', 'application/xhtml+xml'])
const DOWNLOAD_TYPE = 'application/octet-stream'

export function isBinaryPreviewType(contentType: string): boolean {
  return (
    RASTER_IMAGE_TYPES.has(contentType) ||
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType === 'application/pdf'
  )
}

// File name (full path in the tooltip) and a "<type> · <size>" line, shared by file views. The "Encrypted share"
// label sits above the card.
function fileHeader(name: string, title: string, contentType: string, size: number): string {
  return `
      <h1 class="file-title" title="${escapeHtml(title)}">${escapeHtml(name)}</h1>
      <p class="lede-left">${fileTypeLabel(contentType)} · ${formatBytes(size)}</p>`
}

// A column: heading, the sandboxed page at card width, then the download action.
function renderHtml(container: HTMLElement, data: Uint8Array, displayName: string, title: string): void {
  const objectUrl = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: DOWNLOAD_TYPE }))
  activeObjectUrls.set(container, [objectUrl])
  container.classList.add('wide')
  container.innerHTML = `
    <div class="content-wrapper">${fileHeader(displayName, title, 'text/html', data.byteLength)}
      <div id="html-preview"></div>
      <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
    </div>
  `
  container.querySelector('#html-preview')?.replaceChildren(createLockedHtmlFrame(new TextDecoder().decode(data)))
}

export function renderContent(
  container: HTMLElement,
  data: Uint8Array,
  sniffedType: string,
  displayName = 'Decrypted file',
  title = displayName
): void {
  revokeRenderedObjectUrls(container)
  setCardLabel('Encrypted share')
  container.classList.remove('wide')
  // Never trust the sniffed type alone for PDFs: the bytes must really start with %PDF-
  let contentType =
    sniffedType === 'application/pdf' && !hasPdfSignature(data) ? 'application/octet-stream' : sniffedType
  if (XML_TYPES.has(contentType)) contentType = 'text/plain'
  if (contentType === 'text/html') {
    renderHtml(container, data, displayName, title)
    return
  }

  // Only previewable types get a typed blob, as the source of the <img>/<video>/PDF tab. Every Download link is its own
  // octet-stream blob (for a preview, a slice over the same bytes).
  const previewable = isBinaryPreviewType(contentType)
  const preview = previewable ? new Blob([data as Uint8Array<ArrayBuffer>], { type: contentType }) : undefined
  const previewUrl = preview ? URL.createObjectURL(preview) : ''
  const download = preview
    ? preview.slice(0, preview.size, DOWNLOAD_TYPE)
    : new Blob([data as Uint8Array<ArrayBuffer>], { type: DOWNLOAD_TYPE })
  const objectUrl = URL.createObjectURL(download)
  if (contentType === 'application/pdf') {
    pdfObjectUrls.add(previewUrl)
    activeObjectUrls.set(container, [objectUrl])
  } else {
    activeObjectUrls.set(container, previewUrl ? [previewUrl, objectUrl] : [objectUrl])
  }
  const header = fileHeader(displayName, title, contentType, data.byteLength)

  if (RASTER_IMAGE_TYPES.has(contentType)) {
    container.classList.add('wide')
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <img src="${previewUrl}" alt="Decrypted image" style="max-width:100%;max-height:90vh;display:block;margin:0 auto;" />
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
      </div>
    `
    return
  }

  if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
    const tag = contentType.startsWith('audio/') ? 'audio' : 'video'
    container.classList.add('wide')
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <${tag} controls preload="metadata" src="${previewUrl}"></${tag}>
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
      </div>
    `
    return
  }

  if (contentType === 'application/pdf') {
    container.innerHTML = `
      <div class="content-wrapper">
        <div class="pdf-head">
          ${PDF_ICON}
          <div>
            <h1 class="file-title" title="${escapeHtml(title)}">${escapeHtml(displayName)}</h1>
            <p class="lede-left">${fileTypeLabel(contentType)} · ${formatBytes(data.byteLength)}</p>
          </div>
        </div>
        <div class="pdf-actions">
          <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
          <a class="btn-primary pdf-open" href="${previewUrl}" target="_blank" rel="noopener noreferrer">Open in new tab ${EXTERNAL_ICON}</a>
        </div>
        <p class="pdf-note">Opens in your browser's own PDF viewer. The file was decrypted on this device and is never uploaded.</p>
      </div>
    `
    return
  }

  if (contentType === 'text/plain') {
    const text = new TextDecoder().decode(data)
    container.classList.add('wide')
    container.innerHTML = `
      <div class="content-wrapper">${header}
        <pre>${escapeHtml(text)}</pre>
        <a class="btn-secondary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download</a>
      </div>
    `
    return
  }

  container.innerHTML = `
    <div class="content-wrapper">${header}
      <a class="btn-primary" href="${objectUrl}" download="${escapeHtml(displayName)}">Download file</a>
    </div>
  `
}
