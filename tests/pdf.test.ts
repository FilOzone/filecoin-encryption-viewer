import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderContent, revokePdfObjectUrls, revokeRenderedObjectUrls } from '../src/render.js'

const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')

function setup() {
  const blobs: Blob[] = []
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:test-${blobs.length}`
    }),
    revokeObjectURL,
  })
  const container = { classList: { add: vi.fn(), remove: vi.fn() }, innerHTML: '' } as unknown as HTMLElement
  return { blobs, revokeObjectURL, container }
}

afterEach(() => {
  revokePdfObjectUrls()
  vi.unstubAllGlobals()
})

describe('PDF view', () => {
  it('has a new-tab link and no embedded content', () => {
    const { container, blobs } = setup()
    renderContent(container, pdfBytes, 'application/pdf', 'report.pdf', 'docs/report.pdf')
    const html = container.innerHTML

    expect(html).not.toMatch(/<(embed|object|iframe)\b/i)
    const link = /<a class="btn-primary pdf-open" href="(blob:[^"]+)" target="_blank" rel="([^"]+)">/.exec(html)
    expect(link?.[1]).toBe('blob:test-1')
    expect(link?.[2]).toContain('noopener')
    expect(link?.[2]).toContain('noreferrer')
    expect(html).toContain('Open in new tab')
    expect(html).toContain('PDF · 29 B')
    expect(html).toContain('<h1 class="file-title" title="docs/report.pdf">report.pdf</h1>')
    expect(html).not.toContain('pdf-panel')
    expect(html).not.toContain('eyebrow')
    expect(html).toContain('>Download</a>')
    expect(blobs[0].type).toBe('application/pdf')
    // the Download link is a separate octet-stream blob
    expect(html).toContain('href="blob:test-2" download="report.pdf"')
    expect(blobs[1].type).toBe('application/octet-stream')
  })

  it('falls back to the unknown-type card when the bytes are not a PDF', () => {
    const { container } = setup()
    renderContent(container, new TextEncoder().encode('not really a pdf'), 'application/pdf', 'fake.pdf')

    expect(container.innerHTML).not.toContain('pdf-panel')
    expect(container.innerHTML).toContain('Unknown file type')
    expect(container.innerHTML).toContain('Download file')
  })

  it('keeps the PDF object URL alive when leaving the view, and revokes it on pagehide', () => {
    const { container, revokeObjectURL } = setup()
    renderContent(container, pdfBytes, 'application/pdf', 'report.pdf')

    revokeRenderedObjectUrls(container) // what "← All files" does
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:test-1')

    revokePdfObjectUrls() // what pagehide does
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
  })

  it('still revokes other object URLs when leaving the view', () => {
    const { container, revokeObjectURL } = setup()
    renderContent(container, new TextEncoder().encode('hello'), 'text/plain', 'a.txt')
    revokeRenderedObjectUrls(container)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
  })
})

describe('page CSP', () => {
  it("forbids plugins with object-src 'none' and still has no frame or other loosening", () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).not.toContain('object-src blob:')
    expect(csp).toContain("default-src 'none'")
  })
})
