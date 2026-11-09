import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const DEV_SHARE_PATH = '/__dev-share'
const DEV_SHARE_FILE = resolve(import.meta.dirname, 'dev/share.fee')

// Dev server only: relax the CSP enough for Vite's scripts, HMR and fonts, and serve the local test share.
// apply: 'serve' keeps all of it out of `vite build`; scripts/check-dist.mjs enforces that.
function devHarness(): Plugin {
  return {
    name: 'dev-harness',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        (_match, open, csp, close) => {
          const extra: Record<string, string> = {
            'script-src': "'self'",
            'font-src': "'self'",
            'img-src': "'self'",
            'connect-src': 'ws:',
          }
          const relaxed = Object.entries(extra).reduce(
            (policy, [directive, sources]) => policy.replace(new RegExp(`${directive} `), `${directive} ${sources} `),
            csp
          )
          return `${open}${relaxed}${close}`
        }
      )
    },
    configureServer(server) {
      server.middlewares.use(DEV_SHARE_PATH, async (req, res) => {
        try {
          const body = await readFile(DEV_SHARE_FILE)
          res.setHeader('Content-Type', 'application/octet-stream')
          // ?ignore-range answers 200 with the whole file, like a server that ignores Range;
          // ?ignore-range=chunked also leaves out Content-Length, so the viewer can't keep the body in memory
          const ignoreRange = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ignore-range')
          const range = ignoreRange === null ? req.headers.range : undefined
          if (ignoreRange === 'chunked') {
            res.write(body)
            res.end()
            return
          }
          if (range === undefined) {
            res.setHeader('Content-Length', body.length)
            res.end(body)
            return
          }
          const match = /^bytes=(\d+)-(\d*)$/.exec(range)
          const start = Number(match?.[1])
          const end = Math.min(match?.[2] ? Number(match[2]) : body.length - 1, body.length - 1)
          if (!match || start >= body.length || end < start) {
            res.statusCode = 416
            res.setHeader('Content-Range', `bytes */${body.length}`)
            res.end()
            return
          }
          res.statusCode = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`)
          res.setHeader('Content-Length', end - start + 1)
          res.end(body.subarray(start, end + 1))
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [viteSingleFile(), devHarness()],
  build: {
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    outDir: 'dist',
    rollupOptions: {
      input: 'index.html',
    },
  },
})
