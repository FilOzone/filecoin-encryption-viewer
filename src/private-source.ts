/**
 * A private upload's envelope (filecoin-pin `add --private`), fetched on the authenticated path.
 *
 * A private upload is not served on open paths, so the gateway can't fetch it. Its share link carries a keysmith
 * Delivery whose final claim names the piece (its CID as the claim's locator) and is borne by the link's key T, plus
 * the providers that hold it (`s=`). The viewer signs one read request with T (keysmith `authorizationHeader`) and
 * fetches `<provider>/download/<pieceCid>?foc_grant=<token>`: the query form, not an `Authorization` header, keeps the
 * request a simple one, with no CORS preflight.
 *
 * The piece is the outer CAR `add` uploaded: one UnixFS file, `encrypted.fee`, under the link's root CID. Providers
 * expose no `Content-Range` to scripts, so the piece is fetched whole (up to the in-memory cap), every block is checked
 * against its CID, and the file's bytes are reassembled from the root. They are then served from memory, like a whole
 * body from the gateway. FEE authenticates the envelope with the key in any case.
 */
import { decode as decodeCbor } from '@ipld/dag-cbor'
import * as dagPb from '@ipld/dag-pb'
import type { RandomAccessSource } from 'filecoin-encryption-envelope'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { NotAShareError, NotAvailableError, TooLargeError } from './errors.js'
import { wholeBodyCap } from './range-source.js'
import { DAG_PB_CODEC, RAW_CODEC, decodeVarint } from './unixfs-car-layout.js'

/** A UnixFS file is at most a few levels deep; this bounds a hostile one. */
const MAX_DEPTH = 8

/**
 * The envelope of the private upload at `rootCid`, from the first of `providers` that serves its piece to `token` (a
 * base64url presentation). Throws NotAvailableError when none does.
 */
export async function openPrivateSource(
  rootCid: CID,
  pieceCid: CID,
  providers: readonly string[],
  token: string,
  fetchFn: typeof fetch
): Promise<RandomAccessSource> {
  const failures: string[] = []
  for (const provider of providers) {
    let car: Uint8Array
    try {
      car = await fetchPiece(`${provider}/download/${pieceCid}?foc_grant=${token}`, fetchFn)
    } catch (error) {
      if (error instanceof TooLargeError) throw error
      failures.push(`${new URL(provider).host}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const envelope = await envelopeOf(car, rootCid)
    return {
      size: envelope.length,
      openRange: async (offset, length) => streamOf(envelope.subarray(offset, offset + length)),
    }
  }
  throw new NotAvailableError(`No provider served the private share (${failures.join('; ') || 'no provider named'})`)
}

async function fetchPiece(url: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  const response = await fetchFn(url, { cache: 'no-store' })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }
  const tooLarge = () => new TooLargeError('The private share is too large to open in the browser')
  if (Number(response.headers.get('content-length') ?? 0) > wholeBodyCap()) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > wholeBodyCap()) throw tooLarge()
  return bytes
}

/** The bytes of the UnixFS file at `root` in `car`, every block checked against its CID. */
async function envelopeOf(car: Uint8Array, root: CID): Promise<Uint8Array> {
  const blocks = await readCar(car, root)
  const parts: Uint8Array[] = []
  const walk = (cid: CID, depth: number): void => {
    if (depth > MAX_DEPTH) throw new NotAShareError()
    const bytes = blocks.get(cid.toString())
    if (!bytes) throw new NotAShareError()
    if (cid.code === RAW_CODEC) {
      parts.push(bytes)
      return
    }
    if (cid.code !== DAG_PB_CODEC) throw new NotAShareError()
    const node = dagPb.decode(bytes)
    const unixfs = node.Data ? UnixFS.unmarshal(node.Data) : undefined
    if (!unixfs || (unixfs.type !== 'file' && unixfs.type !== 'raw')) throw new NotAShareError()
    if (unixfs.data && unixfs.data.length > 0) parts.push(unixfs.data)
    // dag-pb's multiformats may be another major than ours; cross by bytes
    for (const link of node.Links) walk(CID.decode(link.Hash.bytes), depth + 1)
  }
  walk(root, 0)
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A CARv1's blocks by CID, each checked against its CID (sha2-256, or identity), whose single root must be `root`. */
async function readCar(car: Uint8Array, root: CID): Promise<Map<string, Uint8Array>> {
  const header = decodeVarint(car, 0)
  if (!header) throw new NotAShareError()
  const [headerLength, headerVarint] = header
  const headerStart = headerVarint
  const { roots } = decodeCbor(car.subarray(headerStart, headerStart + headerLength)) as { roots?: unknown[] }
  if (roots?.length !== 1 || !CID.asCID(roots[0])?.equals(root)) throw new NotAShareError()
  const blocks = new Map<string, Uint8Array>()
  let at = headerStart + headerLength
  while (at < car.length) {
    const section = decodeVarint(car, at)
    if (!section) throw new NotAShareError()
    const [length, varintBytes] = section
    const start = at + varintBytes
    const end = start + length
    if (end > car.length) throw new NotAShareError()
    const [cid, rest] = CID.decodeFirst(car.subarray(start, end))
    if (cid.multihash.code === sha256.code) {
      const digest = await sha256.digest(rest)
      if (!equal(digest.digest, cid.multihash.digest)) throw new NotAShareError()
    } else if (cid.multihash.code !== 0x00 || !equal(cid.multihash.digest, rest)) {
      throw new NotAShareError()
    }
    blocks.set(cid.toString(), rest)
    at = end
  }
  return blocks
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
