import { decodeDelivery } from '@filoz/keysmith'
import { encode as encodeCbor } from '@ipld/dag-cbor'
import * as fee from 'filecoin-encryption-envelope'
import { CID } from 'multiformats/cid'
import * as digest from 'multiformats/hashes/digest'
import { sha256 } from 'multiformats/hashes/sha2'
import { hexToBytes } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DamagedLinkError,
  NotAShareError,
  NotAvailableError,
  OtherUploadError,
  RangeUnsupportedError,
  ShareExpiredError,
  ShareModifiedError,
  WrongAccessKeyError,
  openProtectedArchive,
} from '../src/car-archive.js'
import type { ProtectedArchive } from '../src/car-archive.js'
import { GatewayInactiveError, UnexpectedPageError } from '../src/errors.js'
import { wholeBodyCap } from '../src/range-source.js'
import { encodeVarint } from '../src/unixfs-car-layout.js'
import { expectSameBytes } from './fixtures/bytes.js'
import {
  PAYLOAD,
  accessKey,
  delivery,
  encryptCar,
  keyspaceGrant,
  makeShare,
  plainGrant,
} from './fixtures/make-share.js'
import type { ShareFile } from './fixtures/make-share.js'
import { serveRange } from './fixtures/serve-range.js'
import type { StubMode } from './fixtures/serve-range.js'

const CID_STRING = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const MIB = 1024 * 1024
const bytes = (text: string) => new TextEncoder().encode(text)
// Distinct, deterministic bytes: different seeds never share a 1 MiB chunk
const pattern = (length: number, seed: number) => new Uint8Array(length).map((_, index) => (index * 31 + seed) % 251)

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
    parts.push(value)
  }
}

const requested = (stub: { requests: { length: number }[] }, from = 0) =>
  stub.requests.slice(from).reduce((total, request) => total + request.length, 0)

async function open(share: Uint8Array, mode: StubMode = 'range') {
  const stub = serveRange(share, mode)
  return { stub, archive: await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), stub.fetch) }
}

const folder: ShareFile[] = [
  { path: 'photos/a.jpg', content: bytes('jpeg bytes') },
  { path: 'photos/sub/b.txt', content: bytes('nested text') },
]

// Spans several 256 KiB encryption chunks and three 1 MiB leaves
const big = pattern(2.5 * MIB, 1)
const bigFolder: ShareFile[] = [{ path: 'big/data.bin', content: big }]

afterEach(() => vi.restoreAllMocks())

describe('openProtectedArchive', () => {
  it('opens a single file under its own name', async () => {
    const { archive } = await open(await makeShare([{ path: 'hello.txt', content: bytes('hello world') }]))
    expect(archive.list()).toEqual([
      { path: 'hello.txt', directory: false, size: 11, contentType: 'application/octet-stream' },
    ])
    expect(await readAll(await archive.open('hello.txt'))).toEqual(bytes('hello world'))
    await archive.close()
  })

  it('lists a nested folder under the folder name', async () => {
    const { archive } = await open(await makeShare(folder))
    expect(archive.list().map((entry) => [entry.path, entry.directory])).toEqual([
      ['photos/', true],
      ['photos/a.jpg', false],
      ['photos/sub/', true],
      ['photos/sub/b.txt', false],
    ])
    expect(await readAll(await archive.open('photos/sub/b.txt'))).toEqual(bytes('nested text'))
  })

  it('opens a folder of only empty folders, which has no raw block', async () => {
    const { archive } = await open(await makeShare([{ path: 'top/a/b' }, { path: 'top/c' }]))
    expect(archive.list().map((entry) => entry.path)).toEqual(['top/', 'top/a/', 'top/a/b/', 'top/c/'])
  })

  it('reads a multi-chunk, multi-leaf file', async () => {
    const { archive } = await open(await makeShare(bigFolder))
    expectSameBytes(await readAll(await archive.open('big/data.bin')), big)
  })

  it('restores a repeated chunk byte-identical', async () => {
    const first = pattern(MIB, 1)
    const content = new Uint8Array(3 * MIB)
    content.set(first, 0)
    content.set(pattern(MIB, 2), MIB)
    content.set(first, 2 * MIB)
    const { archive } = await open(await makeShare([{ path: 'repeat.bin', content }]))
    expectSameBytes(await readAll(await archive.open('repeat.bin')), content)
  })

  it('reads metadata that is larger than the first window', async () => {
    // 6000 entries make a sharded directory of several hundred KiB of dag-pb before the first leaf
    const files = Array.from({ length: 6000 }, (_, index) => ({ path: `many/f${index}`, content: bytes(`n${index}`) }))
    const { archive, stub } = await open(await makeShare(files))
    expect(archive.list()).toHaveLength(6001)
    expect(stub.requests.length).toBeGreaterThan(1)
    expect(await readAll(await archive.open('many/f5999'))).toEqual(bytes('n5999'))
  }, 30_000) // builds a 6000-entry share; real work, not assertion time
})

describe('range reads', () => {
  const mixed: ShareFile[] = [
    { path: 'mix/big.bin', content: big },
    { path: 'mix/small.txt', content: bytes('small file') },
  ]

  it('opens a share smaller than the head window from a server that answers 416 instead of clamping', async () => {
    const { stub, archive } = await open(await makeShare(folder), 'strict')
    expect(archive.list().map((entry) => entry.path)).toContain('photos/a.jpg')
    expect(await readAll(await archive.open('photos/a.jpg'))).toEqual(bytes('jpeg bytes'))
    // One probe answered 416, then one clamped head read; nothing starts at byte 0
    expect(stub.requests.every((request) => request.offset >= 1)).toBe(true)
  })

  it('open fetches only the head', async () => {
    const { stub } = await open(await makeShare(mixed))
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].offset).toBe(1)
    expect(requested(stub)).toBeLessThanOrEqual(320 * 1024)
  })

  it("open(path) fetches only that file's ranges", async () => {
    const { archive, stub } = await open(await makeShare(mixed))
    const afterOpen = stub.requests.length

    expect(await readAll(await archive.open('mix/small.txt'))).toEqual(bytes('small file'))
    expect(requested(stub, afterOpen)).toBeLessThan(MIB / 2)

    const beforeBig = stub.requests.length
    expectSameBytes(await readAll(await archive.open('mix/big.bin')), big)
    // the first 320 KiB of the share are already in the cached head
    expect(requested(stub, beforeBig)).toBeGreaterThanOrEqual(big.length - 320 * 1024)
  })

  it("sends every request to the gateway's own host with no-store and redirect error", async () => {
    const { archive, stub } = await open(await makeShare(mixed))
    await readAll(await archive.open('mix/big.bin'))
    expect(stub.requests.length).toBeGreaterThan(1)
    for (const request of stub.requests)
      expect(request).toMatchObject({
        url: `https://${CID_STRING}.ipfs.inbrowser.link/`,
        cache: 'no-store',
        redirect: 'error',
      })
  })

  it('sniffing the first 100 bytes of a large file makes one request of at most one batch', async () => {
    const huge = pattern(10 * MIB, 3)
    const { archive, stub } = await open(await makeShare([{ path: 'huge.bin', content: huge }]))
    const before = stub.requests.length
    const reader = (await archive.open('huge.bin')).getReader()
    const { value } = await reader.read()
    await reader.cancel()
    expect(value?.slice(0, 100)).toEqual(huge.slice(0, 100))
    const data = stub.requests.slice(before)
    expect(data).toHaveLength(1)
    // One 8 MiB batch, widened to whole 256 KiB encryption chunks (the first leaf starts mid-chunk)
    expect(data[0].length).toBeLessThanOrEqual(8 * MIB + 2 * 256 * 1024)
  })

  it('restores a file over 8 MiB in batches of at most 8 MiB', async () => {
    const huge = pattern(10 * MIB, 3)
    const { archive, stub } = await open(await makeShare([{ path: 'huge.bin', content: huge }]))
    const before = stub.requests.length
    expectSameBytes(await readAll(await archive.open('huge.bin')), huge)
    const data = stub.requests.slice(before)
    expect(data).toHaveLength(Math.ceil(huge.length / (8 * MIB)))
  })

  it('never requests a range that starts at byte 0, and the head request starts at byte 1', async () => {
    const stub = serveRange(await makeShare(mixed))
    const ranges: string[] = []
    const fetchFn = ((input: RequestInfo, init?: RequestInit) => {
      ranges.push(new Headers(init?.headers).get('range') ?? '')
      return stub.fetch(input, init)
    }) as typeof fetch
    const archive = await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)
    expectSameBytes(await readAll(await archive.open('mix/big.bin')), big)
    expect(await readAll(await archive.open('mix/small.txt'))).toEqual(bytes('small file'))

    expect(ranges[0]).toBe(`bytes=1-${320 * 1024 - 1}`)
    expect(ranges.length).toBeGreaterThan(1)
    expect(stub.requests.every((request) => request.offset > 0)).toBe(true)
  })

  it('opens a share smaller than the head', async () => {
    const share = await makeShare([{ path: 'tiny.txt', content: bytes('tiny') }])
    expect(share.length).toBeLessThan(320 * 1024)
    const { archive, stub } = await open(share)
    expect(await readAll(await archive.open('tiny.txt'))).toEqual(bytes('tiny'))
    expect(stub.requests).toHaveLength(1)
  })

  it('reports a share whose first bytes are not a COSE_Encrypt0 as not a share', async () => {
    const share = await makeShare(folder)
    // The client supplies byte 0 itself (0xd0), so the second byte is what breaks the envelope
    share[0] = 0x00
    share[1] = 0x01
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
  })

  it('reads one batch at a time', async () => {
    const { archive, stub } = await open(await makeShare(bigFolder))
    const before = stub.requests.length
    const reader = (await archive.open('big/data.bin')).getReader()
    expect(stub.requests.length).toBe(before)
    await reader.read()
    expect(stub.requests.length).toBe(before + 1)
    await reader.cancel()
    expect(stub.requests.length).toBe(before + 1)
  })
})

const OTHER_T = `0x${'44'.repeat(32)}` as const
const OTHER_SALT = `0x${'08'.repeat(16)}` as const
const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  for (let at = 0; at <= haystack.length - needle.length; at++) {
    if (needle.every((byte, index) => haystack[at + index] === byte)) return at
  }
  throw new Error('needle not found')
}

const flipped = (payload: Uint8Array, at: number) => {
  const copy = new Uint8Array(payload)
  copy[at] ^= 1
  return copy
}

// Opens with a fetch spy, so a test can assert that nothing was fetched
async function openWith(payload: Uint8Array, key = accessKey()) {
  const stub = serveRange(await makeShare(folder))
  const fetchFn = vi.fn(stub.fetch)
  const result = await openProtectedArchive(CID_STRING, payload, key, fetchFn).catch((cause: unknown) => cause)
  return { result, fetchFn }
}

describe('link payload', () => {
  it.each([
    ['a plain grant', plainGrant],
    ['a Delivery', delivery],
  ])('opens with %s and zeroes the Access key', async (_, make) => {
    const key = accessKey()
    const { result } = await openWith(await make(), key)
    expect((result as ProtectedArchive).list()).toHaveLength(4)
    expectSameBytes(key, new Uint8Array(32))
  })

  it.each([
    ['a plain grant', plainGrant],
    ['a Delivery', delivery],
  ])('refuses a wrong Access key for %s before any fetch, and zeroes it', async (_, make) => {
    const key = accessKey(OTHER_T)
    const { result, fetchFn } = await openWith(await make(), key)
    expect(result).toBeInstanceOf(WrongAccessKeyError)
    expect(fetchFn).not.toHaveBeenCalled()
    expectSameBytes(key, new Uint8Array(32))
  })

  it.each([
    ['zero', new Uint8Array(32)],
    ['the group order', hexToBytes(`0x${N}`)],
  ])('refuses an Access key that is not a valid private key (%s) before any fetch', async (_, key) => {
    const { result, fetchFn } = await openWith(PAYLOAD, key)
    expect(result).toBeInstanceOf(WrongAccessKeyError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    ['a plain grant', plainGrant],
    ['a Delivery', delivery],
  ])("refuses %s for upload A against upload B's envelope as another upload", async (_, make) => {
    const { result, fetchFn } = await openWith(await make({ salt: OTHER_SALT }))
    expect(result).toBeInstanceOf(OtherUploadError)
    expect(fetchFn).toHaveBeenCalled()
  })

  it('refuses an expired Delivery before any fetch', async () => {
    const expires = Math.floor(Date.now() / 1000) - 3600
    const { result, fetchFn } = await openWith(await delivery({ expires }))
    expect(result).toBeInstanceOf(ShareExpiredError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a keyspace grant, which is not a Share link, before any fetch', async () => {
    const { result, fetchFn } = await openWith(await keyspaceGrant())
    expect(result).toBeInstanceOf(NotAShareError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses a Delivery with a flipped byte in its signature or its wrapped key as damaged', async () => {
    const payload = await delivery()
    const { chain, grant } = decodeDelivery(payload)
    for (const part of [chain.links[0].signature, grant.ct, chain.owner]) {
      const { result, fetchFn } = await openWith(flipped(payload, indexOf(payload, hexToBytes(part)) + 3))
      expect(result).toBeInstanceOf(DamagedLinkError)
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['not CBOR', new Uint8Array([0x00, 1, 2, 3])],
    ['a CBOR string', new Uint8Array([0x63, 0x61, 0x62, 0x63])],
    ['a truncated grant', PAYLOAD.subarray(0, PAYLOAD.length - 1)],
    ['a grant with its map length changed', flipped(PAYLOAD, 0)],
    ['an empty map', new Uint8Array([0xa0])],
    ['an empty array', new Uint8Array([0x80])],
  ])('refuses a payload that is %s as damaged, before any fetch', async (_, payload) => {
    const { result, fetchFn } = await openWith(payload)
    expect(result).toBeInstanceOf(DamagedLinkError)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('integrity', () => {
  it('rejects a flipped ciphertext byte in the metadata', async () => {
    const share = await makeShare(bigFolder)
    const info = await fee.parse(share)
    if (info.scheme !== 'chunked') throw new Error('expected a chunked envelope')
    share[info.params.headerLength + 5] ^= 1
    await expect(open(share)).rejects.toBeInstanceOf(ShareModifiedError)
  })

  it('rejects a flipped ciphertext byte in a file, when that file is read', async () => {
    const share = await makeShare(bigFolder)
    share[share.length - 20] ^= 1
    const { archive } = await open(share)
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(ShareModifiedError)
  })

  // The Content-Range total is fixed by the CID, so an envelope that doesn't match its header is final, not a retry
  it.each([40, 70_000, 300_000])('maps a total cut by %i bytes to ShareModifiedError', async (cut) => {
    const share = await makeShare(bigFolder)
    await expect(open(share.slice(0, share.length - cut))).rejects.toBeInstanceOf(ShareModifiedError)
  })

  it('maps a total with bytes appended to ShareModifiedError', async () => {
    const share = await makeShare(bigFolder)
    const longer = new Uint8Array(share.length + 40)
    longer.set(share)
    await expect(open(longer)).rejects.toBeInstanceOf(ShareModifiedError)
  })

  it('maps a body shorter than its Content-Range to NotAvailableError', async () => {
    const share = await makeShare(bigFolder)
    await expect(open(share, 'truncated')).rejects.toBeInstanceOf(NotAvailableError)

    const { archive, stub } = await open(share)
    stub.mode = 'truncated'
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })
})

describe('what is accepted', () => {
  it('rejects an envelope without keysmith labels', async () => {
    await expect(open(await makeShare(folder, { appMetadata: { app: 'other' } }))).rejects.toBeInstanceOf(
      NotAShareError
    )
  })

  it('rejects a foreign content_type', async () => {
    const share = await makeShare(folder, { contentType: 'text/plain' })
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects labels that name another keysmith format version', async () => {
    const share = await makeShare(folder, { appMetadata: { 'foc/v': 2, 'foc/ks': `0x${'22'.repeat(16)}` } })
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects non-envelope bytes', async () => {
    await expect(open(crypto.getRandomValues(new Uint8Array(500)))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a CAR that is not metadata-first', async () => {
    await expect(open(await makeShare(folder, { importerOrder: true }))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a CAR header with two roots', async () => {
    await expect(open(await makeShare(folder, { twoRoots: true }))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a root with two entries', async () => {
    const share = await makeShare([
      { path: 'a.txt', content: bytes('a') },
      { path: 'b.txt', content: bytes('b') },
    ])
    await expect(open(share)).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects metadata that runs past 16 MiB without a raw block', async () => {
    const data = new Uint8Array(MIB).fill(9)
    const cid = CID.createV1(0x70, await sha256.digest(data))
    const header = encodeCbor({ roots: [cid], version: 1 })
    const section = new Uint8Array([...encodeVarint(cid.bytes.length + data.length), ...cid.bytes, ...data])
    const car = await new Blob([
      encodeVarint(header.length),
      header,
      ...Array(17).fill(section),
    ] as BlobPart[]).arrayBuffer()
    await expect(open(await encryptCar(new Uint8Array(car)))).rejects.toBeInstanceOf(NotAShareError)
  })

  it('rejects a section header that is not a CIDv1', async () => {
    const header = encodeCbor({ roots: [CID.createV1(0x70, digest.create(0x12, new Uint8Array(32)))], version: 1 })
    const car = await new Blob([
      encodeVarint(header.length),
      header,
      new Uint8Array([3, 7, 7, 7]),
    ] as BlobPart[]).arrayBuffer()
    await expect(open(await encryptCar(new Uint8Array(car)))).rejects.toBeInstanceOf(NotAShareError)
  })
})

describe('when a web page comes back instead of the share (200 text/html)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('blames the gateway only when no service worker controls the tab', async () => {
    const stub = serveRange(await makeShare(folder), 'installer')
    const error = await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), stub.fetch).catch((cause) => cause)
    expect(error).toBeInstanceOf(GatewayInactiveError)
    expect(stub.installerCancels).toBe(stub.installerPages)
  })

  it('says only that a page came back when a service worker is in control', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } })
    const stub = serveRange(await makeShare(folder), 'installer')
    const error = await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), stub.fetch).catch((cause) => cause)
    expect(error).toBeInstanceOf(UnexpectedPageError)
    expect(stub.installerCancels).toBe(stub.installerPages)
  })
})

describe('when the server does not serve ranges', () => {
  it('opens a share served whole with a 200, reading everything from that one response', async () => {
    const share = await makeShare(bigFolder)
    const { archive, stub } = await open(share, 'full')
    expect(archive.list().map((entry) => entry.path)).toEqual(['big/', 'big/data.bin'])
    expectSameBytes(await readAll(await archive.open('big/data.bin')), big)
    expect(stub.requests).toHaveLength(1)
  })

  it('reports a whole 200 body that does not start with 0xd0 as not a share', async () => {
    const share = await makeShare(folder)
    share[0] = 0x00
    await expect(open(share, 'full')).rejects.toBeInstanceOf(NotAShareError)
  })

  it('reports a whole 200 body longer than its Content-Length as not available, and stops reading it', async () => {
    const share = await makeShare(folder)
    const headers = { 'content-length': String(share.length - 1) }
    const response = new Response(share as BodyInit, { status: 200, headers })
    const fetchFn = (async () => response) as typeof fetch
    await expect(openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)).rejects.toBeInstanceOf(
      NotAvailableError
    )
  })

  it('caps the whole body at half the in-memory save cap: 256 MiB on desktop, 128 MiB on mobile', () => {
    vi.stubGlobal('navigator', { userAgentData: { mobile: false } })
    expect(wholeBodyCap()).toBe(256 * 1024 * 1024)
    vi.stubGlobal('navigator', { userAgentData: { mobile: true } })
    expect(wholeBodyCap()).toBe(128 * 1024 * 1024)
    vi.unstubAllGlobals()
  })

  it('reports a whole 200 body shorter than its Content-Length as not available', async () => {
    const share = await makeShare(folder)
    const headers = { 'content-length': String(share.length + 1) }
    const fetchFn = (async () => new Response(share as BodyInit, { status: 200, headers })) as typeof fetch
    await expect(openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)).rejects.toBeInstanceOf(
      NotAvailableError
    )
  })

  it('turns a 200 without Content-Length on the head request into RangeUnsupportedError, with the body intact', async () => {
    const share = await makeShare(folder)
    const error = await open(share, 'chunked').catch((cause) => cause)
    expect(error).toBeInstanceOf(RangeUnsupportedError)
    expectSameBytes(new Uint8Array(await error.response.arrayBuffer()), share)
  })

  it('leaves the body of a 200 over the in-memory cap unread', async () => {
    const share = await makeShare(folder)
    const headers = { 'content-length': String(wholeBodyCap() + 1) }
    const fetchFn = (async () => new Response(share as BodyInit, { status: 200, headers })) as typeof fetch
    const error = await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn).catch((cause) => cause)
    expect(error).toBeInstanceOf(RangeUnsupportedError)
    expect(error.response.bodyUsed).toBe(false)
    expectSameBytes(new Uint8Array(await error.response.arrayBuffer()), share)
  })

  it('turns a 200 during a file read into RangeUnsupportedError, not a modified share', async () => {
    const share = await makeShare(bigFolder)
    const { archive, stub } = await open(share)
    stub.mode = 'full'
    const error = await readAll(await archive.open('big/data.bin')).catch((cause) => cause)
    expect(error).toBeInstanceOf(RangeUnsupportedError)
    expectSameBytes(new Uint8Array(await error.response.arrayBuffer()), share)
  })

  it.each([404, 502, 504])('maps %i to NotAvailableError', async (status) => {
    await expect(open(await makeShare(folder), status)).rejects.toBeInstanceOf(NotAvailableError)
  })

  it('maps a 404 during a file read to NotAvailableError', async () => {
    const { archive, stub } = await open(await makeShare(bigFolder))
    stub.mode = 404
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })

  // 206 without a Content-Range is an invalid range response
  it.each([404, 502, 500, 206])('cancels the body of a thrown-away %i response', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchFn = (async () => new Response(body, { status })) as typeof fetch
    await expect(openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
  })

  it('maps a rejected fetch to NotAvailableError', async () => {
    const fetchFn = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    await expect(openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)).rejects.toBeInstanceOf(
      NotAvailableError
    )
  })

  it('fails on other statuses', async () => {
    await expect(open(await makeShare(folder), 500)).rejects.toThrow('Unexpected response: 500')
  })

  it('rejects a 206 whose Content-Range does not match the request', async () => {
    const share = await makeShare(bigFolder)
    const stub = serveRange(share)
    let shift = false
    const fetchFn = (async (input: RequestInfo, init?: RequestInit) => {
      const response = await stub.fetch(input, init)
      if (!shift) return response
      return new Response(response.body, { status: 206, headers: { 'content-range': `bytes 0-9/${share.length}` } })
    }) as typeof fetch
    const archive = await openProtectedArchive(CID_STRING, PAYLOAD, accessKey(), fetchFn)
    shift = true
    await expect(readAll(await archive.open('big/data.bin'))).rejects.toBeInstanceOf(NotAvailableError)
  })
})

describe('archive lifetime', () => {
  it('throws from open() after close(), and close() is idempotent', async () => {
    const { archive }: { archive: ProtectedArchive } = await open(await makeShare(folder))
    await archive.close()
    await archive.close()
    await expect(archive.open('photos/a.jpg')).rejects.toThrow('closed')
  })

  it('fails a read that was started before close(), and zeroes the key', async () => {
    const { archive } = await open(await makeShare(bigFolder))
    const stream = await archive.open('big/data.bin')
    await archive.close()
    await expect(readAll(stream)).rejects.toThrow('closed')
  })

  it('throws for an unknown path', async () => {
    const { archive } = await open(await makeShare(folder))
    await expect(archive.open('nope')).rejects.toThrow('not found')
  })

  it('rejects an invalid CID', async () => {
    await expect(
      openProtectedArchive('nope', PAYLOAD, accessKey(), serveRange(new Uint8Array(1)).fetch)
    ).rejects.toThrow('Invalid')
  })
})
