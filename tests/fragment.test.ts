import { describe, expect, it } from 'vitest'
import { decodeAccessKey, encodeAccessKey, parseFragment } from '../src/fragment.js'
import { expectSameBytes } from './fixtures/bytes.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3udhvy6o2x4i5woy4vgr3vnz4'
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index)
const KEY = 'fak1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const PAYLOAD = Uint8Array.from({ length: 200 }, (_, index) => (index * 7) % 256)
// What filecoin-pin's formatShareLink writes: Buffer base64url, no padding
const D = Buffer.from(PAYLOAD).toString('base64url')

describe('parseFragment', () => {
  it('parses a link without its Access key, with and without the leading #', () => {
    for (const hash of [`#v1/${CID}&d=${D}`, `v1/${CID}&d=${D}`]) {
      const parsed = parseFragment(hash)
      expect(parsed?.cid).toBe(CID)
      expect(parsed?.key).toBeUndefined()
      expectSameBytes(parsed?.payload as Uint8Array, PAYLOAD)
    }
  })

  it('parses a link that carries its Access key', () => {
    const parsed = parseFragment(`#v1/${CID}&d=${D}&k=${KEY}`)
    expect(parsed?.cid).toBe(CID)
    expectSameBytes(parsed?.payload as Uint8Array, PAYLOAD)
    expectSameBytes(parsed?.key as Uint8Array, KEY_BYTES)
  })

  it('accepts every payload length the CLI can write', () => {
    for (let length = 1; length <= 40; length++) {
      const payload = crypto.getRandomValues(new Uint8Array(length))
      const parsed = parseFragment(`#v1/${CID}&d=${Buffer.from(payload).toString('base64url')}`)
      expectSameBytes(parsed?.payload as Uint8Array, payload)
    }
  })

  it('accepts a d of up to 8192 characters', () => {
    const at = (length: number) => Buffer.from(new Uint8Array(length).fill(0xab)).toString('base64url')
    expect(at(6144)).toHaveLength(8192)
    expect(parseFragment(`#v1/${CID}&d=${at(6144)}`)).not.toBeNull()
    expect(parseFragment(`#v1/${CID}&d=${at(6145)}`)).toBeNull()
  })

  it.each([
    '',
    '#',
    '#v1/',
    '#v1/bafy',
    `#v1/${CID}`,
    `#v1/${CID}&d=`,
    `#v1/${CID}&d`,
    `#v1/${CID}&k=${KEY}`,
    `#v1/${CID}&k=${KEY}&d=${D}`,
    `#cid=${CID}&d=${D}`,
    `#v1/${CID}?pw=secret`,
    `#v1/${CID}/&d=${D}`,
    `#v2/${CID}&d=${D}`,
    `#V1/${CID}&d=${D}`,
    `#v1/${CID.toUpperCase()}&d=${D}`,
    `#v1%2F${CID}&d=${D}`,
    ` #v1/${CID}&d=${D}`,
    `#v1/${CID}&d=${D} `,
    `#v1/${CID}&d=${D}\n`,
    `#v1/../${CID}&d=${D}`,
    `#v1/${CID}?p=`,
    `#v1/${CID}?p=12&d=${D}`,
    `#v1/${CID}&d=${D}?p=4`,
    `#v1/${CID}?d=${D}`,
    `#v1/${CID}&p=4&d=${D}`,
    `#v1/${CID}&d=${D}&p=4`,
    `#v1/${CID}&d=${D}&d=${D}`,
    `#v1/${CID}&d=${D}&k=${KEY}&k=${KEY}`,
    `#v1/${CID}&d=${D}&k=${KEY}&extra=1`,
    `#v1/${CID}&d=${D}=`,
    `#v1/${CID}&d=${Buffer.from(PAYLOAD).toString('base64')}`,
    `#v1/${CID}&d=${D.slice(0, -1)}`,
    `#v1/${CID}&d=A`,
    `#v1/${CID}&d=AB`,
    `#v1/${CID}&d=${D}%20`,
    `#v1/${CID}&d=${D}&k=${KEY.replace('fak1_', 'fak2_')}`,
    `#v1/${CID}&d=${D}&k=${encodeAccessKey(new Uint8Array(31))}`,
    `#v1/${CID}&d=${D}&k=${encodeAccessKey(new Uint8Array(33))}`,
    `#v1/${CID}&d=${D}&k=${KEY}=`,
    `#v1/${CID}&d=${D}&k=${KEY.slice(0, -1)}+`,
    `#v1/${CID}&d=${D}&k=${KEY.slice(0, -1)}B`,
    `#v1/${CID}&d=${D}&k=`,
    `#v1/${CID}&d=${D}&k=fak1_`,
    `#v1/${CID}&d=${D}&k=secret`,
  ])('rejects malformed or unsupported fragment %j', (hash) => {
    expect(parseFragment(hash)).toBeNull()
  })
})

describe("a private upload's providers (s)", () => {
  const S = ['https://sp1.example/pdp', 'http://localhost:5711'].map(encodeURIComponent).join(',')

  it('parses s between d and k, as filecoin-pin writes it', () => {
    const parsed = parseFragment(`#v1/${CID}&d=${D}&s=${S}&k=${KEY}`)
    expect(parsed?.providers).toEqual(['https://sp1.example/pdp', 'http://localhost:5711'])
    expectSameBytes(parsed?.key as Uint8Array, KEY_BYTES)
  })

  it('refuses a provider that is not an http(s) URL, or one with credentials', () => {
    for (const bad of ['javascript:alert(1)', 'https://user:pass@sp.example', 'ftp://sp.example']) {
      expect(parseFragment(`#v1/${CID}&d=${D}&s=${encodeURIComponent(bad)}`)).toBeNull()
    }
  })
})

describe('access key encoding', () => {
  it('matches a known answer', () => {
    expect(encodeAccessKey(KEY_BYTES)).toBe(KEY)
  })

  it('round-trips random keys, with no padding and only base64url characters', () => {
    for (let round = 0; round < 50; round++) {
      const key = crypto.getRandomValues(new Uint8Array(32))
      const text = encodeAccessKey(key)
      expect(text).toMatch(/^fak1_[A-Za-z0-9_-]{43}$/)
      expect(text).toBe(`fak1_${Buffer.from(key).toString('base64url')}`)
      expectSameBytes(decodeAccessKey(text) as Uint8Array, key)
    }
  })
})
