// A fetch stub that serves `bytes` the way the gateway does: 206 with Content-Range for a Range request.
// `mode` can be changed between requests; `requests` records what was asked for.
// 'strict' answers 416 when the requested end is past the last byte, as the gateway's service worker does, instead of
// clamping. 'installer' answers like inbrowser.link's server without its service worker: 200 with an HTML page;
// `installerPages` counts them and `installerCancels` how many bodies were cancelled. 'full' answers 200 with the whole
// file and its Content-Length; 'chunked' the same without Content-Length, as a chunked response arrives.
export type StubMode = 'range' | 'full' | 'chunked' | 'truncated' | 'strict' | 'installer' | number

export interface RangeRequest {
  url: string
  offset: number
  length: number
  cache?: RequestCache
  redirect?: RequestRedirect
}

export interface RangeStub {
  fetch: typeof fetch
  mode: StubMode
  requests: RangeRequest[]
  installerPages: number
  installerCancels: number
}

export function serveRange(bytes: Uint8Array, mode: StubMode = 'range'): RangeStub {
  const stub: RangeStub = {
    mode,
    requests: [],
    installerPages: 0,
    installerCancels: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/)
      if (!range) throw new Error('serveRange: expected a bytes=a-b Range header')
      const offset = Number(range[1])
      const end = Math.min(Number(range[2]), bytes.length - 1)
      stub.requests.push({
        url: String(input),
        offset,
        length: end - offset + 1,
        cache: init?.cache,
        redirect: init?.redirect,
      })

      if (typeof stub.mode === 'number') return new Response('', { status: stub.mode })
      if (stub.mode === 'strict' && Number(range[2]) > bytes.length - 1) {
        return new Response('', { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } })
      }
      if (stub.mode === 'installer') {
        stub.installerPages++
        const page = new ReadableStream({
          pull: (controller) => controller.enqueue(new TextEncoder().encode('<!doctype html>')),
          cancel: () => void stub.installerCancels++,
        })
        return new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (stub.mode === 'full') {
        return new Response(bytes as BodyInit, { status: 200, headers: { 'content-length': String(bytes.length) } })
      }
      if (stub.mode === 'chunked') return new Response(bytes as BodyInit, { status: 200 })
      const slice = bytes.subarray(offset, end + 1)
      const body = stub.mode === 'truncated' ? slice.subarray(0, slice.length >> 1) : slice
      return new Response(body as BodyInit, {
        status: 206,
        headers: { 'content-range': `bytes ${offset}-${end}/${bytes.length}` },
      })
    }) as typeof fetch,
  }
  return stub
}
