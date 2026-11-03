// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtectedEntry } from '../src/car-archive.js'
import { NotAvailableError, ShareModifiedError, TooLargeError } from '../src/errors.js'
import { addBackButton, showProtectedArchive } from '../src/ui.js'

const dir = (path: string): ProtectedEntry => ({
  path: `${path}/`,
  directory: true,
  size: 0,
  contentType: 'inode/directory',
})
const file = (path: string, size = 10): ProtectedEntry => ({
  path,
  directory: false,
  size,
  contentType: 'application/octet-stream',
})

const entries = [
  dir('share'),
  file('share/b.txt', 2048),
  file('share/A.txt'),
  dir('share/zeta'),
  dir('share/alpha'),
  file('share/alpha/x.bin', 12_000_000),
  dir('share/alpha/one'),
  dir('share/alpha/one/two'),
  dir('share/alpha/one/two/three'),
  file('share/alpha/one/two/three/deep.txt'),
]

let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.replaceChildren(container)
})

describe('showProtectedArchive tree', () => {
  it('lists folders before files, case-insensitively, with sizes and titles', () => {
    showProtectedArchive(container, entries, async () => {})
    const rootList = container.querySelector('details ul') as HTMLElement
    const names = Array.from(rootList.children).map((item) => item.querySelector('.tree-name')?.textContent)
    expect(names).toEqual(['alpha', 'zeta', 'A.txt', 'b.txt'])
    expect(container.querySelector('.tree-name[title="A.txt"]')).not.toBeNull()
    expect(container.querySelector('button.tree-file .tree-size')?.textContent).toBeTruthy()
    expect(container.textContent).toContain('12 MB')
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThan(3)
  })

  it('opens the top folder and its subfolders, and collapses deeper ones', () => {
    showProtectedArchive(container, [dir('top'), dir('top/a'), dir('top/a/b'), file('top/a/b/c.txt')], async () => {})
    const open = (name: string) =>
      Array.from(container.querySelectorAll('details')).find((d) => d.querySelector('.tree-name')?.textContent === name)
        ?.open
    expect(open('top')).toBe(true)
    expect(open('a')).toBe(true)
    expect(open('b')).toBe(false)
  })

  it('summarizes folders, files and size, with singular forms', () => {
    const summary = () => container.querySelector('.tree-summary')?.textContent
    showProtectedArchive(
      container,
      [
        dir('top'),
        dir('top/a'),
        dir('top/a/b'),
        file('top/a/b/c.txt', 1000),
        file('top/long.txt', 30_000),
        file('top/short.txt', 6000),
      ],
      async () => {}
    )
    expect(summary()).toBe('3 folders · 3 files · 37 KB')

    showProtectedArchive(container, [dir('top'), file('top/a.txt', 5)], async () => {})
    expect(summary()).toBe('1 folder · 1 file · 5 B')
  })

  it('restores folder state passed back in', () => {
    const state = new Map<string, boolean>([['share/alpha', false]])
    showProtectedArchive(container, entries, async () => {}, state)
    const alpha = Array.from(container.querySelectorAll('details')).find(
      (d) => d.querySelector('.tree-name')?.textContent === 'alpha'
    )
    expect(alpha?.open).toBe(false)
  })

  it('calls onSelect with the entry when a file is clicked', async () => {
    const onSelect = vi.fn(async () => {})
    showProtectedArchive(container, entries, onSelect)
    ;(container.querySelector('button.tree-file') as HTMLButtonElement).click()
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it.each([
    [new ShareModifiedError('x'), 'This share is damaged or was modified, so it was not opened.'],
    [
      new NotAvailableError('x'),
      "This share isn't available yet, or the download was interrupted. Try again in a few minutes.",
    ],
    [new Error('boom'), 'This file could not be opened.'],
  ])('shows the message for %s when a file fails to open', async (cause, message) => {
    showProtectedArchive(container, entries, async () => {
      throw cause
    })
    ;(container.querySelector('button.tree-file') as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const error = container.querySelector('#archive-error') as HTMLElement
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe(message)
  })

  it.each([
    [new ShareModifiedError('x'), 'This share is damaged or was modified, so it was not opened.'],
    [
      new NotAvailableError('x'),
      "This share isn't available yet, or the download was interrupted. Try again in a few minutes.",
    ],
    [new TooLargeError('x'), 'These files are too large to zip in this browser. Use `filecoin-pin decrypt` instead.'],
    [new Error('boom'), 'The zip could not be created. Try again.'],
  ])('shows the message for %s when the zip fails', async (cause, message) => {
    showProtectedArchive(
      container,
      entries,
      async () => {},
      new Map(),
      async () => {
        throw cause
      }
    )
    ;(container.querySelector('#download-all') as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.querySelector('#zip-status')?.textContent).toBe(message)
  })

  it('adds a back button that calls the handler', () => {
    const onBack = vi.fn()
    addBackButton(container, onBack)
    const button = container.querySelector('#back-btn') as HTMLButtonElement
    expect(button.textContent).toBe('← All files')
    button.click()
    expect(onBack).toHaveBeenCalledOnce()
  })
})
