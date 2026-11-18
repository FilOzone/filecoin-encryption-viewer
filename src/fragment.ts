// #v1/<encryptedRootCid>&d=<payload>[&s=<providers>][&k=<access key>], exactly as filecoin-pin's formatShareLink writes
// it. `s` (a private upload's link only) lists the providers that hold the piece: comma-separated, URI-encoded URLs.
// ponytail: `d`, `s`, `k`, in that order only; parse the parameters as a set if another writer ever orders them differently
const FRAGMENT_PATTERN =
  /^v1\/(b[a-z2-7]{20,120})&d=([A-Za-z0-9_-]{1,8192})(?:&s=([A-Za-z0-9%._~-]{1,4096}(?:,[A-Za-z0-9%._~-]{1,4096}){0,7}))?(?:&k=(fak1_[A-Za-z0-9_-]{43}))?$/
const ACCESS_KEY_PREFIX = 'fak1_'
const KEY_BYTES = 32

export interface FragmentParams {
  cid: string
  /** The keysmith payload: a Delivery (CBOR array) or a plain piece grant (CBOR map). Not checked here. */
  payload: Uint8Array<ArrayBuffer>
  /** The Access key, when the link carries it: the 32-byte secp256k1 private key the payload is wrapped to. */
  key?: Uint8Array<ArrayBuffer>
  /** A private upload's providers (`s`): the http(s) service URLs its piece is fetched from. */
  providers?: string[]
}

/** A provider from `s`: an http(s) URL with no credentials, without a trailing slash; null otherwise. */
function providerUrl(text: string): string | null {
  try {
    const url = new URL(decodeURIComponent(text))
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

// Null for anything that isn't exactly what encodeBase64Url writes (re-encoding rejects stray bits in the last character)
function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))
    return encodeBase64Url(bytes) === text ? bytes : null
  } catch {
    return null
  }
}

/** `fak1_` + base64url without padding of the 32-byte private key. */
export function encodeAccessKey(key: Uint8Array): string {
  return ACCESS_KEY_PREFIX + encodeBase64Url(key)
}

/** The 32 key bytes, or null for anything that isn't exactly what encodeAccessKey writes. */
export function decodeAccessKey(text: string): Uint8Array<ArrayBuffer> | null {
  if (!text.startsWith(ACCESS_KEY_PREFIX)) return null
  const key = decodeBase64Url(text.slice(ACCESS_KEY_PREFIX.length))
  return key?.length === KEY_BYTES ? key : null
}

/** Parse the share link fragment; anything outside the codec above (unknown parameters, a bad `d` or `k`) is null. */
export function parseFragment(hash: string): FragmentParams | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const match = FRAGMENT_PATTERN.exec(raw)
  if (!match) return null
  const [, cid, data, servers, accessKey] = match
  const payload = decodeBase64Url(data)
  if (!payload) return null
  const providers = servers?.split(',').map(providerUrl)
  if (providers?.some((provider) => provider === null)) return null
  const share = { cid, payload, ...(providers && { providers: providers as string[] }) }
  if (accessKey === undefined) return share
  const key = decodeAccessKey(accessKey)
  return key ? { ...share, key } : null
}
