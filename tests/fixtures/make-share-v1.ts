// Shares as filecoin-pin 2.3 and 2.4 make them: keysmith 0.1.0 (format 1), which the viewer still opens.
// ponytail: delete with the viewer's format 1 adapter once 0.1.0 links have aged out.
import * as fee from 'filecoin-encryption-envelope'
import {
  type PieceMetadata,
  encodeDelivery,
  encodeGrant,
  grantDescriptor,
  keyForEnvelope,
  keyspaceKeys,
  pieceMetadata,
  pieceNode,
  publicKeyOf,
  rootClaim,
  wrapTo,
} from 'keysmith-v1'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CAR_CONTENT_TYPE } from '../../src/unixfs-car-layout.ts'
import { ACCESS_KEY, SALT, type ShareFile, buildCar } from './make-share.ts'

const OWNER = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const REF = { owner: OWNER.address, keyspace: `0x${'22'.repeat(16)}` } as const
const CHAIN_ID = 314159n
const { kk } = await keyspaceKeys(OWNER, REF)

const metadataV1 = (salt: Hex = SALT): PieceMetadata => pieceMetadata(REF, { salt })
const plain = (bytes: Uint8Array) => new Uint8Array(bytes)

/** A format 1 session-key share's payload: the piece key wrapped to T. */
export async function plainGrantV1(options: { salt?: Hex } = {}): Promise<Uint8Array> {
  const metadata = metadataV1(options.salt)
  const key = keyForEnvelope(kk, metadata)
  return plain(encodeGrant(await wrapTo(publicKeyOf(ACCESS_KEY), key, grantDescriptor(REF, pieceNode(metadata)))))
}

/** A format 1 owner-mode share's payload: a one-link claim chain to T's address, plus the wrapped key. */
export async function deliveryV1(options: { salt?: Hex; expires?: number } = {}): Promise<Uint8Array> {
  const metadata = metadataV1(options.salt)
  const { chain, nodeKey } = await rootClaim(OWNER, {
    ...REF,
    chainId: CHAIN_ID,
    kk,
    node: pieceNode(metadata),
    bearer: privateKeyToAccount(ACCESS_KEY).address,
    maxDepth: 0,
    expires: options.expires ?? Math.floor(Date.now() / 1000) + 3600,
    piece: metadata,
  })
  return plain(
    encodeDelivery(chain, await wrapTo(publicKeyOf(ACCESS_KEY), nodeKey, grantDescriptor(REF, pieceNode(metadata))))
  )
}

/** A format 1 grant for the whole keyspace, wrapped to T: not a Share link. */
export async function keyspaceGrantV1(): Promise<Uint8Array> {
  return plain(encodeGrant(await wrapTo(publicKeyOf(ACCESS_KEY), kk, grantDescriptor(REF, 'keyspace'))))
}

/** A format 1 upload: the same inner CAR as makeShare, encrypted under format 1 labels and key. */
export async function makeShareV1(files: ShareFile[]): Promise<Uint8Array> {
  const car = await buildCar(files)
  const metadata = metadataV1()
  const encrypted = new Blob([car as BlobPart]).stream().pipeThrough(
    fee.encrypt({
      cek: keyForEnvelope(kk, metadata),
      contentLength: car.length,
      contentType: CAR_CONTENT_TYPE,
      appMetadata: metadata as fee.AppMetadata,
    })
  )
  return new Uint8Array(await new Response(encrypted).arrayBuffer())
}
