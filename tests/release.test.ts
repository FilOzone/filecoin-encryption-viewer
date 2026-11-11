import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DNSLINK_NAME,
  checkCid,
  readmeCid,
  readmePreviousCid,
  readmeRows,
  setDnslink,
  upsertReadmeRow,
  verifyDnslink,
  verifyRedirect,
  viewerCid,
  waitIndexed,
} from '../scripts/release.ts'

const OLD = 'bafkreignymhjvidv5bx5tvggzvob775a7avje43er4tvzyyww7af5vcksy'
const NEW = 'bafkreihjejtvtm2cjs2eyrv5nah2kauyd2a5oxis565gpj4gyoyxmhsfwa'
const README = `# Viewer

| Release | Viewer CID | Network |
|---|---|---|
| \`9b141cb\` | \`${OLD}\` | mainnet |

A note after the table, then another table that isn't the Verifiable build one:

| \`not-a-release\` | \`${NEW}\` | other |
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

  it('takes exactly 1 MiB and refuses one byte more, which filecoin-pin would split into a multi-block file', async () => {
    await expect(viewerCid(new Uint8Array(1_048_576))).resolves.toMatch(/^bafkrei/)
    await expect(viewerCid(new Uint8Array(1_048_577))).rejects.toThrow('over 1 MiB')
  })
})

describe('checkCid', () => {
  it.each([OLD, 'bafybeifd567whjwnh5aoxucilqtra7mmzqfbjdxt35ytxwbt5kqqbmx7re'])('accepts %s', (cid) => {
    expect(checkCid(cid)).toBe(cid)
  })
  it.each([
    '',
    'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    `${OLD} ; rm -rf /`,
    'bafkreinotacid',
    OLD.toUpperCase(),
    `B${OLD.slice(1).toUpperCase()}`,
    // Same bytes, but non-zero padding bits in the last character: not the canonical encoding.
    `${OLD.slice(0, -1)}z`,
  ])('rejects %j', (cid) => {
    expect(() => checkCid(cid)).toThrow()
  })
})

describe('README table', () => {
  it('reads only the rows right under the header, not a later row-like line', () => {
    expect(readmeRows(README)).toEqual([['9b141cb', OLD]])
  })

  it('finds the previous recorded CID: the row just before the tag, or none for the first row', () => {
    const third = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'
    const readme = upsertReadmeRow(upsertReadmeRow(README, 'v0.2.0', NEW), 'v0.3.0', third)
    expect(readmePreviousCid(readme, 'v0.2.0')).toBe(OLD)
    expect(readmePreviousCid(readme, 'v0.3.0')).toBe(NEW)
    expect(readmePreviousCid(readme, '9b141cb')).toBe('')
    expect(() => readmePreviousCid(readme, 'v9.9.9')).toThrow(/no Verifiable build row/)
  })

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
    const fetch = vi.fn(async () => new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(waitIndexed(NEW, poll)).rejects.toThrow(/gave up after 3 attempts/)
    expect(fetch).toHaveBeenCalledTimes(3)
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

  it.each([
    ['a TXT record with another name', { ...record, name: 'viewer.filecoin.cloud' }],
    ['the right name but another type', { ...record, type: 'CNAME' }],
  ])('refuses %s', async (_, result) => {
    const fetch = vi.fn(async () => json({ success: true, result }))
    vi.stubGlobal('fetch', fetch)
    await expect(setDnslink(cf, NEW, poll)).rejects.toThrow(/expected TXT/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('skips the PATCH when the record already names the CID', async () => {
    const fetch = vi.fn(async () => json({ success: true, result: record }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await setDnslink(cf, OLD, poll)).toBe(OLD)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails on an HTTP error even when the body claims success, after a capped number of tries', async () => {
    const fetch = vi.fn(async () => json({ success: true, result: record }, 500))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(setDnslink(cf, NEW, poll)).rejects.toThrow(/answered 500/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('verifyDnslink', () => {
  const doh = (body: object) => async () => json(body)
  const answer = (...cids: string[]) => ({ Status: 0, Answer: cids.map((cid) => ({ data: `"dnslink=/ipfs/${cid}"` })) })

  it('retries failed lookups and other CIDs until the answer names exactly the new CID', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(doh({ Answer: answer(NEW).Answer })) // no Status
      .mockImplementationOnce(doh({ Status: 2, Answer: answer(NEW).Answer })) // SERVFAIL
      .mockImplementationOnce(doh(answer(OLD)))
      .mockImplementationOnce(doh(answer(OLD, NEW)))
      .mockImplementationOnce(doh(answer(NEW)))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await verifyDnslink(NEW, { attempts: 5, intervalMs: 0 })
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('fails when the answer also names another CID', async () => {
    vi.stubGlobal('fetch', vi.fn(doh(answer(NEW, OLD))))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(verifyDnslink(NEW, poll)).rejects.toThrow(/names .*, /)
  })

  it('fails on NXDOMAIN', async () => {
    vi.stubGlobal('fetch', vi.fn(doh({ Status: 3 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(verifyDnslink(NEW, poll)).rejects.toThrow(/DNS status 3/)
  })
})

describe('verifyRedirect', () => {
  const redirect = (status: number, location: string) => async () =>
    new Response(null, { status, headers: { location } })
  const IPNS = 'https://viewer-filecoin-cloud.ipns.inbrowser.link/'

  it('retries a 301 and a wrong location until it gets a 302 to the IPNS name', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(redirect(301, IPNS))
      .mockImplementationOnce(redirect(302, 'https://example.com/'))
      .mockImplementationOnce(redirect(302, IPNS))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await verifyRedirect(poll)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up when the redirect stays wrong', async () => {
    vi.stubGlobal('fetch', vi.fn(redirect(302, 'https://example.com/')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(verifyRedirect(poll)).rejects.toThrow(/got 302 to https:\/\/example.com/)
  })
})
