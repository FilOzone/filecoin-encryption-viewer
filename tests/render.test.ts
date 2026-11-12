import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectContentType, isBinaryPreviewType, renderContent } from '../src/render.js'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('detectContentType', () => {
  it('detects PNG from magic bytes', async () => {
    const data = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)
    expect(await detectContentType(data)).toBe('image/png')
  })

  it('detects JPEG from magic bytes', async () => {
    const data = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46)
    expect(await detectContentType(data)).toBe('image/jpeg')
  })

  it('detects GIF from magic bytes', async () => {
    const data = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00)
    expect(await detectContentType(data)).toBe('image/gif')
  })

  it('detects WebP from magic bytes', async () => {
    // RIFF....WEBP
    const data = bytes(
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // file size (placeholder)
      0x57,
      0x45,
      0x42,
      0x50 // WEBP
    )
    expect(await detectContentType(data)).toBe('image/webp')
  })

  it('detects PDF from magic bytes', async () => {
    const data = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e) // %PDF-1.
    expect(await detectContentType(data)).toBe('application/pdf')
  })

  it('detects HTML with <!DOCTYPE prefix', async () => {
    const html = '<!DOCTYPE html><html><body>hi</body></html>'
    const data = new TextEncoder().encode(html)
    expect(await detectContentType(data)).toBe('text/html')
  })

  it('detects HTML with <html prefix', async () => {
    const html = '<html><body>hello</body></html>'
    const data = new TextEncoder().encode(html)
    expect(await detectContentType(data)).toBe('text/html')
  })

  it('detects plain text for valid UTF-8 text', async () => {
    const data = new TextEncoder().encode('Hello, world! This is plain text.')
    expect(await detectContentType(data)).toBe('text/plain')
  })

  it('falls back to application/octet-stream for binary data', async () => {
    // Bytes that are not valid UTF-8 and not a known format
    const data = bytes(0x00, 0x01, 0x02, 0xfe, 0xff, 0x80, 0x81, 0x82, 0x83)
    expect(await detectContentType(data)).toBe('application/octet-stream')
  })
})

describe('isBinaryPreviewType', () => {
  it('allows only browser-preview binary formats above the document cap', () => {
    expect(isBinaryPreviewType('image/jpeg')).toBe(true)
    expect(isBinaryPreviewType('audio/mpeg')).toBe(true)
    expect(isBinaryPreviewType('video/mp4')).toBe(true)
    expect(isBinaryPreviewType('application/pdf')).toBe(true)
    expect(isBinaryPreviewType('text/html')).toBe(false)
    expect(isBinaryPreviewType('text/plain')).toBe(false)
    expect(isBinaryPreviewType('application/octet-stream')).toBe(false)
  })
})

describe('renderContent', () => {
  it.each([
    ['image', bytes(0x89, 0x50, 0x4e, 0x47), 'image/png', '假期 照片.png'],
    ['video', bytes(0x00, 0x00, 0x00, 0x18), 'video/mp4', 'clip.mp4'],
    ['text', new TextEncoder().encode('hello'), 'text/plain', 'notes'],
    ['SVG shown as text', new TextEncoder().encode('<svg/>'), 'image/svg+xml', 'logo.svg'],
    ['unknown', new Uint8Array(4), 'application/octet-stream', 'data "v2".bin'],
  ])('downloads %s with its original name', (_kind, data, type, name) => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    const container = { classList: { add: vi.fn(), remove: vi.fn() }, innerHTML: '' } as unknown as HTMLElement

    renderContent(container, data, type, name)

    const download = /download="([^"]*)"/.exec(container.innerHTML)?.[1]
    expect(download).toBe(name.replace(/"/g, '&quot;'))
  })

  it('renders buffered video with playback controls and a download link', () => {
    const createObjectURL = vi.fn(() => 'blob:video')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const container = {
      classList: { add: vi.fn(), remove: vi.fn() },
      innerHTML: '',
    } as unknown as HTMLElement

    renderContent(container, bytes(0x00, 0x00, 0x00, 0x18), 'video/mp4')

    expect(createObjectURL).toHaveBeenCalledTimes(2) // the preview source and the Download link
    expect(container.innerHTML).toContain('<video controls preload="metadata" src="blob:video"></video>')
    expect(container.innerHTML).toContain('>Download</a>')
  })

  it('renders text wide, and a following view clears the width', () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:text'), revokeObjectURL: vi.fn() })
    const add = vi.fn()
    const remove = vi.fn()
    const container = { classList: { add, remove }, innerHTML: '' } as unknown as HTMLElement

    renderContent(container, new TextEncoder().encode('hello'), 'text/plain', 'a.txt')

    expect(remove).toHaveBeenCalledWith('wide')
    expect(add).toHaveBeenCalledWith('wide')
    expect(container.innerHTML).toContain('<pre>hello</pre>')
  })

  it('renders unknown binary data as a titled download card without the raw MIME type', () => {
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:bin'), revokeObjectURL: vi.fn() })
    const container = {
      classList: { add: vi.fn(), remove: vi.fn() },
      innerHTML: '',
    } as unknown as HTMLElement

    renderContent(container, new Uint8Array(2_000_000), 'application/octet-stream', 'small.bin')

    expect(container.innerHTML).toContain('<h1 class="file-title" title="small.bin">small.bin</h1>')
    expect(container.innerHTML).toContain('Unknown file type · 2.0 MB')
    expect(container.innerHTML).toContain('Download file')
    expect(container.innerHTML).not.toContain('application/octet-stream')
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})
