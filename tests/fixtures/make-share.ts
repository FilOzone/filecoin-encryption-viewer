import {
  type PieceMetadata,
  delegateClaim,
  deriveGroupKey,
  encodeDelivery,
  encodeGrant,
  grantDescriptor,
  keyForEnvelope,
  keyForGroup,
  pieceMetadata,
  pieceNode,
  publicKeyOf,
  rootClaim,
  wrapTo,
} from '@filoz/keysmith'
import { CarWriter } from '@ipld/car'
import * as fee from 'filecoin-encryption-envelope'
import { importer } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import type { CID } from 'multiformats/cid'
import { type Hex, hexToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodeAccessKey } from '../../src/fragment.ts'
import { CAR_CONTENT_TYPE, DAG_PB_CODEC, layout } from '../../src/unixfs-car-layout.ts'
import type { MetadataNode } from '../../src/unixfs-car-layout.ts'

// Fixed dev keys: the owner's wallet, its group key, every share's salt, and T (the key a payload is wrapped to).
const OWNER = privateKeyToAccount(`0x${'11'.repeat(32)}`)
export const REF = { owner: OWNER.address, groupKeyId: `0x${'22'.repeat(16)}` } as const
export const SALT: Hex = `0x${'07'.repeat(16)}`
export const ACCESS_KEY: Hex = `0x${'33'.repeat(32)}`
const CHAIN_ID = 314159n

const { groupKey: kk } = await deriveGroupKey(OWNER, REF)

/** The envelope labels of a share: what `filecoin-pin add --encrypt` writes as FEE appMetadata, under `group` if given. */
export const shareMetadata = (salt: Hex = SALT, group?: string): PieceMetadata =>
  pieceMetadata(REF, { salt, ...(group != null && { group }) })

/** A fresh copy of T's bytes: openProtectedArchive zeroes the one it gets. */
export const accessKey = (T: Hex = ACCESS_KEY): Uint8Array => hexToBytes(T)

const pieceDescriptor = (metadata: PieceMetadata) => grantDescriptor(REF, pieceNode(metadata))
// cborg returns a pooled Buffer in Node, whose slice() is a view into the pool: copy into a plain Uint8Array
const plain = (bytes: Uint8Array) => new Uint8Array(bytes)

/** Session-key mode's payload: the piece key wrapped to T, as `encodeGrant(grant)`. */
export async function plainGrant(options: { salt?: Hex; T?: Hex; group?: string } = {}): Promise<Uint8Array> {
  const metadata = shareMetadata(options.salt, options.group)
  const pieceKey = keyForEnvelope(kk, metadata)
  return plain(encodeGrant(await wrapTo(publicKeyOf(options.T ?? ACCESS_KEY), pieceKey, pieceDescriptor(metadata))))
}

/** Owner mode's payload: a one-link claim chain from the owner to T's address, plus the wrapped key. */
export async function delivery(
  options: { salt?: Hex; T?: Hex; expires?: number; group?: string } = {}
): Promise<Uint8Array> {
  const metadata = shareMetadata(options.salt, options.group)
  const T = options.T ?? ACCESS_KEY
  const { chain, nodeKey } = await rootClaim(OWNER, {
    owner: REF.owner,
    groupKeyId: REF.groupKeyId,
    chainId: CHAIN_ID,
    groupKey: kk,
    node: pieceNode(metadata),
    bearer: privateKeyToAccount(T).address,
    maxDepth: 0,
    expires: options.expires ?? Math.floor(Date.now() / 1000) + 3600,
    // keysmith refuses to sign an already expired root, so an expired share is signed before its expiry
    ...(options.expires != null && { now: Math.min(Math.floor(Date.now() / 1000), options.expires - 3600) }),
    piece: metadata,
  })
  return plain(encodeDelivery(chain, await wrapTo(publicKeyOf(T), nodeKey, pieceDescriptor(metadata))))
}

/** A grant for the whole group key, wrapped to T: real keysmith, but not a Share link. */
export async function groupKeyGrant(): Promise<Uint8Array> {
  return plain(encodeGrant(await wrapTo(publicKeyOf(ACCESS_KEY), kk, grantDescriptor(REF, 'groupKey'))))
}

/** A grant for one group, wrapped to T: it opens every upload in that group, so it is not a Share link either. */
export async function groupGrant(group = 'team'): Promise<Uint8Array> {
  return plain(
    encodeGrant(await wrapTo(publicKeyOf(ACCESS_KEY), keyForGroup(kk, group), grantDescriptor(REF, `group:${group}`)))
  )
}

/** The default share's plain-grant payload, for tests that only need some valid link. */
export const PAYLOAD = await plainGrant()

export interface ShareFile {
  path: string
  // Omitted for an empty folder
  content?: Uint8Array
}

export interface MakeShareOptions {
  // Envelope labels in place of the keysmith ones (the content is still encrypted with the salt's piece key)
  appMetadata?: Record<string, unknown>
  salt?: Hex
  // The group the upload is written under (`add --group`)
  group?: string
  // CAR header with two roots
  twoRoots?: boolean
  // Public content_type of the envelope; defaults to the CAR type
  contentType?: string
  // Leave the blocks in the importer's order (leaves first) instead of metadata-first
  importerOrder?: boolean
}

interface Block {
  cid: CID
  bytes: Uint8Array
}

// Same shape as `filecoin-pin add --encrypt`: a wrapping directory around the shared file or folder, written
// metadata-first. Several top-level paths build a root with more than one entry (negative tests).
export async function makeShare(files: ShareFile[], options: MakeShareOptions = {}): Promise<Uint8Array> {
  return encryptCar(await buildCar(files, options), options)
}

/** Encrypts any plaintext as a share, for CARs a normal build can't produce. */
export async function encryptCar(car: Uint8Array, options: MakeShareOptions = {}): Promise<Uint8Array> {
  const metadata = shareMetadata(options.salt, options.group)
  const key = keyForEnvelope(kk, metadata)
  const appMetadata = options.appMetadata ?? metadata
  const encrypted = new Blob([car as BlobPart]).stream().pipeThrough(
    fee.encrypt({
      cek: key,
      contentLength: car.length,
      contentType: options.contentType ?? CAR_CONTENT_TYPE,
      appMetadata: appMetadata as fee.AppMetadata,
    })
  )
  return new Uint8Array(await new Response(encrypted).arrayBuffer())
}

/** The plaintext CAR, exported so layout tests can compare offsets with the real bytes. */
export async function buildCar(files: ShareFile[], options: MakeShareOptions = {}): Promise<Uint8Array> {
  const { root, blocks } = await importFiles(files)
  const ordered = options.importerOrder ? blocks : metadataFirst(root, blocks)

  const { writer, out } = CarWriter.create(options.twoRoots ? [root, root] : [root])
  const collected = (async () => {
    const parts: Uint8Array[] = []
    for await (const part of out) parts.push(part)
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
  })()
  for (const block of ordered) await writer.put(block)
  await writer.close()
  return collected
}

export async function importFiles(files: ShareFile[]): Promise<{ root: CID; blocks: Block[] }> {
  const blocks = new Map<string, Block>()
  const blockstore = {
    put(cid: CID, bytes: Uint8Array): CID {
      blocks.set(cid.toString(), { cid, bytes })
      return cid
    },
  }
  let root: CID | undefined
  for await (const result of importer(files, blockstore as never, {
    wrapWithDirectory: true,
    profile: 'unixfs-v1-2025',
  }))
    root = result.cid
  if (!root) throw new Error('empty import')
  return { root, blocks: [...blocks.values()] }
}

// Header, dag-pb nodes in layout order, then leaves in file order: the order the CLI writes.
function metadataFirst(root: CID, blocks: Block[]): Block[] {
  const byCid = new Map(blocks.map((block) => [block.cid.toString(), block]))
  const nodes = new Map<string, MetadataNode>(
    blocks.filter((block) => block.cid.code === DAG_PB_CODEC).map((block) => [block.cid.toString(), block])
  )
  const placed = layout(root, nodes)
  return [...placed.metadata, ...placed.leaves].map(({ cid }) => {
    const block = byCid.get(cid.toString())
    if (!block) throw new Error(`missing block ${cid}`)
    return block
  })
}

/** The default share's `d` and Access key, as they appear in a link. */
export const LINK_DATA = Buffer.from(PAYLOAD).toString('base64url')
export const ACCESS_KEY_TEXT = encodeAccessKey(accessKey())

/**
 * A private upload's share payload: a Delivery whose final claim names the piece (its CID as the locator) and is borne
 * by T. `delegated`: as a session key makes it, a group Grant from the owner to the session key, then a piece claim
 * from the session key to T; otherwise as the owner makes it, one root claim.
 */
export async function privateDelivery(
  pieceCid: Uint8Array,
  options: { salt?: Hex; group?: string; delegated?: boolean; expires?: number } = {}
): Promise<Uint8Array> {
  const metadata = shareMetadata(options.salt, options.group)
  const T = privateKeyToAccount(ACCESS_KEY).address
  const expires = options.expires ?? Math.floor(Date.now() / 1000) + 3600
  const root = { owner: REF.owner, groupKeyId: REF.groupKeyId, chainId: CHAIN_ID, groupKey: kk, expires }
  let issued: { chain: Parameters<typeof encodeDelivery>[0]; nodeKey: Uint8Array }
  if (options.delegated) {
    const session = privateKeyToAccount(`0x${'44'.repeat(32)}`)
    const grant = await rootClaim(OWNER, {
      ...root,
      node: `group:${options.group ?? 'team'}`,
      bearer: session.address,
      maxDepth: 1,
    })
    issued = await delegateClaim(session, grant.chain, {
      parentKey: grant.nodeKey,
      node: pieceNode(metadata),
      bearer: T,
      maxDepth: 0,
      piece: metadata,
      pieceCid,
    })
  } else {
    issued = await rootClaim(OWNER, {
      ...root,
      node: pieceNode(metadata),
      bearer: T,
      maxDepth: 0,
      piece: metadata,
      pieceCid,
      ...(options.expires != null && { now: Math.min(Math.floor(Date.now() / 1000), options.expires - 3600) }),
    })
  }
  return plain(
    encodeDelivery(issued.chain, await wrapTo(publicKeyOf(ACCESS_KEY), issued.nodeKey, pieceDescriptor(metadata)))
  )
}

/** The piece `add` stores for an envelope: a CAR of the UnixFS file encrypted.fee, rooted at the file. */
export async function outerCar(envelope: Uint8Array): Promise<{ root: CID; car: Uint8Array }> {
  const blocks: Block[] = []
  const blockstore = {
    put(cid: CID, bytes: Uint8Array): CID {
      blocks.push({ cid, bytes })
      return cid
    },
  }
  let root: CID | undefined
  // A small leaf size, so a test envelope spans several blocks under a dag-pb root, as a large upload does
  for await (const result of importer([{ content: envelope }], blockstore as never, {
    profile: 'unixfs-v1-2025',
    chunker: fixedSize({ chunkSize: 1024 }),
  }))
    root = result.cid
  if (!root) throw new Error('empty import')
  const { writer, out } = CarWriter.create([root])
  const collected = (async () => {
    const parts: Uint8Array[] = []
    for await (const part of out) parts.push(part)
    return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
  })()
  for (const block of blocks) await writer.put(block)
  await writer.close()
  return { root, car: await collected }
}
