import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DNSLINK_NAME,
  checkCid,
  readmeCid,
  setDnslink,
  upsertReadmeRow,
  verifyDnslink,
  viewerCid,
  waitIndexed,
} from '../scripts/release.ts'

const OLD = 'bafkreignymhjvidv5bx5tvggzvob775a7avje43er4tvzyyww7af5vcksy'
const NEW = 'bafkreihjejtvtm2cjs2eyrv5nah2kauyd2a5oxis565gpj4gyoyxmhsfwa'
const README = `# Viewer

| Release | Viewer CID | Network |
|---|---|---|
| \`9b141cb\` | \`${OLD}\` | mainnet |

## Credits
`
const poll = { attempts: 3, intervalMs: 0 }
const cf = { token: 'test-token', zoneId: 'zone', recordId: 'record' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('viewerCid', () => {
  it('is the raw-codec CIDv1 of the bytes', async () => {
    // sha256 of "hello world" as a raw CIDv1, as `ipfs add --cid-version 1 --raw-leaves` prints it.
    expect(await viewerCid(new TextEncoder().encode('hello world'))).toBe(
      'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'
    )
  })
})

describe('checkCid', () => {
  it.each([OLD, 'bafybeifd567whjwnh5aoxucilqtra7mmzqfbjdxt35ytxwbt5kqqbmx7re'])('accepts %s', (cid) => {
    expect(checkCid(cid)).toBe(cid)
  })
  it.each(['', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', `${OLD} ; rm -rf /`, 'bafkreinotacid'])(
    'rejects %j',
    (cid) => {
      expect(() => checkCid(cid)).toThrow()
    }
  )
})

describe('README table', () => {
  it('appends a row for a new tag and reads it back', () => {
    const next = upsertReadmeRow(README, 'v0.2.0', NEW)
    expect(next).toBe(README.replace('mainnet |\n', `mainnet |\n| \`v0.2.0\` | \`${NEW}\` | mainnet |\n`))
    expect(readmeCid(next, 'v0.2.0')).toBe(NEW)
    expect(readmeCid(next, '9b141cb')).toBe(OLD)
  })

  it('is idempotent and replaces a changed CID in place', () => {
    const once = upsertReadmeRow(README, 'v0.2.0', OLD)
    expect(upsertReadmeRow(once, 'v0.2.0', OLD)).toBe(once)
    expect(upsertReadmeRow(once, 'v0.2.0', NEW)).toBe(upsertReadmeRow(README, 'v0.2.0', NEW))
  })

  it('rejects bad tags, bad CIDs and a missing table', () => {
    expect(() => upsertReadmeRow(README, '0.2.0', NEW)).toThrow(/release tag/)
    expect(() => upsertReadmeRow(README, 'v0.2.0', 'nope')).toThrow(/CIDv1/)
    expect(() => upsertReadmeRow('# no table', 'v0.2.0', NEW)).toThrow(/table header/)
  })
})

describe('waitIndexed', () => {
  it('retries until cid.contact lists a provider', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(json({ MultihashResults: [{ ProviderResults: [] }] }))
      .mockResolvedValueOnce(json({ MultihashResults: [{ ProviderResults: [{ Provider: { ID: 'p' } }] }] }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await waitIndexed(NEW, poll)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[0][0]).toBe(`https://cid.contact/cid/${NEW}`)
  })

  it('gives up after the last attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(waitIndexed(NEW, poll)).rejects.toThrow(/gave up after 3 attempts/)
  })
})

describe('setDnslink', () => {
  const record = { name: DNSLINK_NAME, type: 'TXT', content: `"dnslink=/ipfs/${OLD}"` }

  it('patches the record with a quoted DNSLink and returns the previous CID', async () => {
    const fetch = vi.fn(async () => json({ success: true, result: record }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await setDnslink(cf, NEW, poll)).toBe(OLD)
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.cloudflare.com/client/v4/zones/zone/dns_records/record')
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token')
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'TXT',
      name: DNSLINK_NAME,
      content: `"dnslink=/ipfs/${NEW}"`,
      ttl: 300,
    })
  })

  it('fails loudly when Cloudflare reports no success', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ success: true, result: record }))
      .mockImplementation(async () =>
        json({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] })
      )
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(setDnslink(cf, NEW, poll)).rejects.toThrow(/Invalid access token/)
  })

  it('refuses a record that is not the DNSLink TXT record', async () => {
    const fetch = vi.fn(async () => json({ success: true, result: { name: 'viewer.filecoin.cloud', type: 'A' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(setDnslink(cf, NEW, poll)).rejects.toThrow(/expected TXT/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('verifyDnslink', () => {
  it('retries until DNS-over-HTTPS returns the new CID', async () => {
    const answer = (cid: string) => json({ Answer: [{ data: `"dnslink=/ipfs/${cid}"` }] })
    const fetch = vi.fn().mockResolvedValueOnce(answer(OLD)).mockResolvedValueOnce(answer(NEW))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await verifyDnslink(NEW, poll)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
