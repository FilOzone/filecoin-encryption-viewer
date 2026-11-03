// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { NotAvailableError, ShareModifiedError, TooLargeError } from '../src/errors.js'
import { showSaveEntry } from '../src/ui.js'

const entry: ProtectedEntry = {
  path: 'sample/docs/big.bin',
  directory: false,
  size: 12_000_000,
  contentType: 'application/octet-stream',
}

it('shows the file name as the heading, with type and size, for large files', () => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => 'saved', false, 'application/pdf')
  const heading = container.querySelector('#save-entry-name') as HTMLElement
  expect(heading.tagName).toBe('H1')
  expect(heading.textContent).toBe('big.bin')
  expect(heading.title).toBe('sample/docs/big.bin')
  expect(container.textContent).toContain('PDF · 12 MB')
  expect(container.textContent).not.toContain('Preview unavailable')
  expect(container.querySelector('#save-entry')?.textContent).toBe('Download file')
})

it('keeps "Preview unavailable" as a note, not the heading', () => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => 'saved', true)
  expect(container.querySelector('#save-entry-name')?.textContent).toBe('big.bin')
  expect(container.querySelector('.note')?.textContent).toBe('Preview unavailable.')
  expect(container.textContent).toContain('Unknown file type · 12 MB')
  expect(container.querySelector('#save-entry')?.textContent).toBe('Download instead')
})

it('shows progress while saving, as a percentage of the known size', async () => {
  const container = document.createElement('div')
  let seen = ''
  showSaveEntry(container, entry, async (onProgress) => {
    onProgress(entry.size / 2)
    seen = container.querySelector('#save-status')?.textContent ?? ''
    return 'saved'
  })
  ;(container.querySelector('#save-entry') as HTMLButtonElement).click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(seen).toBe('Decrypting… 50%')
  expect(container.querySelector('#save-status')?.textContent).toBe('Saved.')
})

it('resets quietly, with no error, when the save is cancelled', async () => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => 'cancelled')
  const button = container.querySelector('#save-entry') as HTMLButtonElement
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect((container.querySelector('#save-error') as HTMLElement).hidden).toBe(true)
  expect(container.querySelector('#save-status')?.textContent).toBe('')
  expect(button.disabled).toBe(false)
  expect(button.textContent).toBe('Download file')
})

it.each([
  [new ShareModifiedError('x'), 'This share is damaged or was modified, so it was not opened.'],
  [
    new NotAvailableError('x'),
    "This share isn't available yet, or the download was interrupted. Try again in a few minutes.",
  ],
  [new TooLargeError('x'), 'This file is too large to save in this browser. Use `filecoin-pin decrypt` instead.'],
  [new Error('boom'), 'This file could not be saved.'],
])('shows the message for %s when the save fails', async (cause, message) => {
  const container = document.createElement('div')
  showSaveEntry(container, entry, async () => {
    throw cause
  })
  ;(container.querySelector('#save-entry') as HTMLButtonElement).click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const error = container.querySelector('#save-error') as HTMLElement
  expect(error.hidden).toBe(false)
  expect(error.textContent).toBe(message)
})
