// Release helpers for the CI workflows in .github/workflows: the viewer CID, the README "Verifiable build" table,
// cid.contact, and the DNSLink TXT record behind https://viewer.filecoin.cloud/.
// Usage: node scripts/release.ts <command> [...args]; see `commands` at the bottom. Logs go to stderr, results to stdout.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as dagPb from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

export const DNSLINK_NAME = '_dnslink.viewer.filecoin.cloud'
export const VIEWER_URL = 'https://viewer.filecoin.cloud/'
const IPNS_URL = 'https://viewer-filecoin-cloud.ipns.inbrowser.link/'
const README_HEADER = '| Release | Viewer CID | Network |'
const REQUEST_TIMEOUT_MS = 15_000
// filoz-webmaster packs dist/ with @helia/unixfs: 1 MiB chunks, and a file that fits in one becomes one raw block
const MAX_RAW_BLOCK_BYTES = 1_048_576

export type Poll = { attempts: number; intervalMs: number }
export type Cloudflare = { token: string; zoneId: string; recordId: string }

/**
 * CID of the folder filoz-webmaster publishes: a UnixFS directory holding only `index.html`, a file of at most 1 MiB
 * that packs as one raw block. A bigger file becomes a multi-block UnixFS file with another CID, so it fails here
 * instead of producing a CID that the upload won't match.
 */
export async function viewerCid(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_RAW_BLOCK_BYTES) {
    throw new Error(`viewer is ${bytes.length} bytes, over 1 MiB: it no longer packs as one block; use webmaster's CID`)
  }
  const file = CID.create(1, raw.code, await sha256.digest(bytes))
  const folder = dagPb.prepare({
    Data: new UnixFS({ type: 'directory' }).marshal(),
    Links: [{ Name: 'index.html', Hash: file, Tsize: bytes.length }],
  })
  return CID.create(1, dagPb.code, await sha256.digest(dagPb.encode(folder))).toString()
}

/**
 * Accepts only a canonical base32 CIDv1 (`bafkrei…` for a raw block, `bafy…` for dag-pb); returns it unchanged. The
 * prefix fixes the version and codec, and CID.parse rejects a bad digest and non-zero padding bits.
 */
export function checkCid(input: string): string {
  if (!/^(bafkrei|bafy)[a-z2-7]+$/.test(input)) throw new Error(`not a base32 CIDv1 (bafkrei…/bafy…): "${input}"`)
  CID.parse(input)
  return input
}

function checkTag(tag: string): string {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`not a release tag (vX.Y.Z): "${tag}"`)
  return tag
}

/** Rows of the "Verifiable build" table as `[key, cid]`, where key is a release tag or, for old rows, a commit. */
export function readmeRows(readme: string): [string, string][] {
  const lines = readme.split('\n')
  const start = lines.indexOf(README_HEADER)
  if (start < 0) throw new Error(`README.md has no table header "${README_HEADER}"`)
  const rows: [string, string][] = []
  for (const line of lines.slice(start + 2)) {
    const match = line.match(/^\| `([^`]+)` \| `([^`]+)` \|/)
    if (!match) break
    rows.push([match[1], match[2]])
  }
  return rows
}

export function readmeCid(readme: string, tag: string): string | undefined {
  return readmeRows(readme).find(([key]) => key === tag)?.[1]
}

/**
 * The CID of the row just before `tag`'s, which is the previous release's (or, for the first release, the last
 * pre-release build's); '' when `tag` is the first row. A release deploys only when its CID differs from this one.
 */
export function readmePreviousCid(readme: string, tag: string): string {
  const rows = readmeRows(readme)
  const at = rows.findIndex(([key]) => key === tag)
  if (at < 0) throw new Error(`README.md has no Verifiable build row for ${tag}`)
  return at === 0 ? '' : rows[at - 1][1]
}

/** Sets the row for `tag`, replacing it in place or appending it to the table. Unchanged input when already set. */
export function upsertReadmeRow(readme: string, tag: string, cid: string): string {
  const row = `| \`${checkTag(tag)}\` | \`${checkCid(cid)}\` | mainnet |`
  const lines = readme.split('\n')
  const start = lines.indexOf(README_HEADER) + 2
  const count = readmeRows(readme).length
  const at = lines.slice(start, start + count).findIndex((line) => line.startsWith(`| \`${tag}\` |`))
  if (at >= 0) lines[start + at] = row
  else lines.splice(start + count, 0, row)
  return lines.join('\n')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function retry<T>(what: string, poll: Poll, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= poll.attempts) throw new Error(`${what}: gave up after ${poll.attempts} attempts: ${message(err)}`)
      console.error(`${what}: attempt ${attempt}/${poll.attempts} failed (${message(err)}), retrying`)
      await sleep(poll.intervalMs)
    }
  }
}

async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`${init.method ?? 'GET'} ${new URL(url).host} answered ${res.status}`)
  }
  return res.json()
}

/** Waits until cid.contact lists at least one provider for `cid`, so inbrowser.link can find it. */
export async function waitIndexed(cid: string, poll: Poll): Promise<void> {
  await retry(`cid.contact ${checkCid(cid)}`, poll, async () => {
    const body = (await getJson(`https://cid.contact/cid/${cid}`)) as {
      MultihashResults?: { ProviderResults?: unknown[] }[]
    }
    const providers = body.MultihashResults?.flatMap((result) => result.ProviderResults ?? []) ?? []
    if (providers.length === 0) throw new Error('no providers yet')
  })
  console.error(`cid.contact lists providers for ${cid}`)
}

type CloudflareResponse = {
  success?: boolean
  errors?: unknown
  result?: { name?: string; type?: string; content?: string }
}

async function cloudflare(cf: Cloudflare, init: RequestInit = {}): Promise<CloudflareResponse['result']> {
  const url = `https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records/${cf.recordId}`
  const headers = { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' }
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const body = (await res.json().catch(() => ({}))) as CloudflareResponse
  if (!res.ok || body.success !== true) {
    throw new Error(`Cloudflare ${init.method ?? 'GET'} answered ${res.status}: ${JSON.stringify(body.errors ?? body)}`)
  }
  return body.result
}

/**
 * Points the DNSLink record at `cid` and returns the CID it pointed at before (or '' if it held no DNSLink).
 * Refuses to touch a record that isn't the viewer's TXT record, so a wrong DNSLINK_RECORD_ID can't change another one.
 * Skips the PATCH when the record already names `cid` (a re-run), reading Cloudflare rather than a caching resolver.
 */
export async function setDnslink(cf: Cloudflare, cid: string, poll: Poll): Promise<string> {
  checkCid(cid)
  const current = await retry('read DNSLink record', poll, () => cloudflare(cf))
  if (current?.name !== DNSLINK_NAME || current.type !== 'TXT') {
    throw new Error(`record ${cf.recordId} is ${current?.type} ${current?.name}, expected TXT ${DNSLINK_NAME}`)
  }
  const previous = current.content?.match(/dnslink=\/ipfs\/([a-z0-9]+)/)?.[1] ?? ''
  if (previous === cid) {
    console.error(`DNSLink record already names ${cid}; not changing it`)
    return previous
  }
  const content = `"dnslink=/ipfs/${cid}"`
  const body = JSON.stringify({ type: 'TXT', name: DNSLINK_NAME, content, ttl: 300 })
  await retry('update DNSLink record', poll, () => cloudflare(cf, { method: 'PATCH', body }))
  console.error(`DNSLink record set to ${content} (was ${previous || 'empty'})`)
  return previous
}

/** The CIDs in the DNSLink's TXT answers over DNS-over-HTTPS; a failed lookup (SERVFAIL, NXDOMAIN…) throws. */
async function dnslinkCids(): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${DNSLINK_NAME}&type=TXT`
  const body = (await getJson(url, { headers: { accept: 'application/dns-json' } })) as {
    Status?: number
    Answer?: { data?: string }[]
  }
  if (body.Status !== 0) throw new Error(`DNS status ${body.Status}`)
  return (body.Answer ?? []).flatMap((answer) => answer.data?.match(/dnslink=\/ipfs\/([a-z0-9]+)/)?.[1] ?? [])
}

/**
 * Checks over DNS-over-HTTPS that the DNSLink names exactly `cid` and nothing else. Resolvers may cache the old answer
 * for the 300 s TTL.
 */
export async function verifyDnslink(cid: string, poll: Poll): Promise<void> {
  await retry(`DNS-over-HTTPS ${DNSLINK_NAME}`, poll, async () => {
    const cids = await dnslinkCids()
    if (cids.length !== 1 || cids[0] !== cid) throw new Error(`answer names ${cids.join(', ') || 'no CID'}`)
  })
  console.error(`${DNSLINK_NAME} serves ${cid}`)
}

/** Checks that the stable URL still redirects to the IPNS name that resolves the DNSLink. */
export async function verifyRedirect(poll: Poll): Promise<void> {
  await retry(`redirect ${VIEWER_URL}`, poll, async () => {
    const res = await fetch(VIEWER_URL, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const location = res.headers.get('location')
    if (res.status !== 302 || location !== IPNS_URL) throw new Error(`got ${res.status} to ${location}`)
  })
  console.error(`${VIEWER_URL} redirects to ${IPNS_URL}`)
}

function cloudflareFromEnv(): Cloudflare {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ZONE_ID: zoneId, DNSLINK_RECORD_ID: recordId } = process.env
  if (!token || !zoneId || !recordId) {
    throw new Error('set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID and DNSLINK_RECORD_ID (the "release" environment)')
  }
  return { token, zoneId, recordId }
}

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
const fewTries: Poll = { attempts: 3, intervalMs: 5_000 }

const commands: Record<string, (args: string[]) => Promise<string | undefined>> = {
  /** cid [file]: prints the viewer CID: the folder webmaster publishes for dist/index.html. */
  cid: async ([file = 'dist/index.html']) => viewerCid(readFileSync(file)),
  /** readme-get <tag>: prints the README CID recorded for a release tag; fails if there's none. */
  'readme-get': async ([tag]) => {
    const cid = readmeCid(readFileSync(readmePath, 'utf8'), checkTag(tag ?? ''))
    if (!cid) throw new Error(`README.md has no Verifiable build row for ${tag}`)
    return cid
  },
  /** readme-previous <tag>: prints the CID of the row before the tag's, or nothing for the first row. */
  'readme-previous': async ([tag]) => readmePreviousCid(readFileSync(readmePath, 'utf8'), checkTag(tag ?? '')),
  /** readme-set <tag> <cid>: records the CID for a release tag in README.md. */
  'readme-set': async ([tag, cid]) => {
    const readme = readFileSync(readmePath, 'utf8')
    const next = upsertReadmeRow(readme, tag ?? '', cid ?? '')
    if (next !== readme) writeFileSync(readmePath, next)
    return undefined
  },
  /** readme-has <cid>: fails unless the CID is in the README table (rollback only targets recorded builds). */
  'readme-has': async ([cid]) => {
    if (!readmeRows(readFileSync(readmePath, 'utf8')).some(([, row]) => row === checkCid(cid ?? ''))) {
      throw new Error(`${cid} is not in README.md's Verifiable build table`)
    }
    return undefined
  },
  /** wait-indexed <cid> [minutes=45]: waits until cid.contact lists providers for the CID. */
  'wait-indexed': async ([cid, minutes = '45']) => {
    await waitIndexed(cid ?? '', { attempts: Math.max(1, Number(minutes) * 2), intervalMs: 30_000 })
    return undefined
  },
  /** dnslink-set <cid>: points the DNSLink record at the CID and prints the CID it named before. */
  'dnslink-set': async ([cid]) => setDnslink(cloudflareFromEnv(), cid ?? '', fewTries),
  /** dnslink-verify <cid>: checks over DNS-over-HTTPS that the DNSLink names the CID, and the stable URL's redirect. */
  'dnslink-verify': async ([cid]) => {
    await verifyDnslink(checkCid(cid ?? ''), { attempts: 20, intervalMs: 30_000 })
    await verifyRedirect(fewTries)
    return undefined
  },
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name = '', ...args] = process.argv.slice(2)
  const command = commands[name]
  if (!command) {
    console.error(`usage: node scripts/release.ts <${Object.keys(commands).join('|')}> [...args]`)
    process.exit(1)
  }
  try {
    const out = await command(args)
    if (out !== undefined) console.log(out)
  } catch (err) {
    console.error(`release ${name} FAILED: ${message(err)}`)
    process.exit(1)
  }
}
