# AGENTS.md

A single-file browser viewer for encrypted Filecoin uploads (`filecoin-pin add --encrypt`), opened from keysmith Share links (`#v1/<cid>&d=…[&k=fak1_…]`). See README.md for the format, behaviour and limits.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm exec biome check .
pnpm dev:share <file-or-folder>   # writes dev/share.fee and prints links, then: pnpm dev
```

All four checks must pass before work is done. `pnpm build` runs `scripts/check-dist.mjs`, which fails if the built CSP differs from `index.html` or any dev code leaks into `dist/index.html`.

## Layout

- `src/`: one module per concern:
  1. `fragment.ts` parses `#v1/<cid>&d=…[&k=…]` fragments and the `fak1_` Access key text.
  2. `range-source.ts` reads the share with Range requests (`no-store`, `206` only, never byte 0), or from memory when the head read gets the whole envelope in a `200`.
  3. `unixfs-car-layout.ts` computes the tree and every block's offset from the metadata-first CAR, within the limits in README.md "Limits".
  4. `car-archive.ts` opens the link's payload with keysmith, derives the piece key, decrypts the metadata, builds the entry list, and streams a file's ranges in batches.
  5. `errors.ts` holds the error classes the UI maps to messages.
  6. `decrypt.ts` bounds inline entry collection.
  7. `sandbox.ts` creates the locked HTML iframe.
  8. `save.ts` picks the save path (dialog, OPFS, or in-memory), and `opfs-save.ts` stages files in OPFS.
  9. `render.ts` renders bounded content and the file views.
  10. `file-type.ts` maps sniffed MIME types to friendly labels, and `format.ts` formats byte sizes.
  11. `zip.ts` streams the "Download all" ZIP from the open archive (with [`client-zip`](https://github.com/Touffy/client-zip)).
  12. `card-label.ts` manages the label above the card and the card layout per screen.
  13. `ui.ts` owns the Access key prompt (with its local checks) and retry, the folder tree, and the save, too-large, not-available and can't-be-opened states.
  14. `main.ts` connects the link, Access key, archive, entry and renderer paths, and reopens on every fragment change (`hashchange`), closing the previous share; a generation number stops its late work.
- `tests/`: vitest in the `node` environment. The fixtures in `tests/fixtures/` build real metadata-first shares (`make-share.ts`), serve them with Range (`serve-range.ts`), and fake OPFS and Web Locks (`fake-opfs.ts`).

## Testing locally

`pnpm dev:share <file-or-folder>` prints, for a plain grant and for a Delivery (valid for an hour), the link without its key, the Access key on its own line, and the link with `&k=`. The share and the keys are made from fixed dev keys (`tests/fixtures/make-share.ts`). The dev server answers the share's Range requests from `dev/share.fee` and relaxes the page CSP for Vite; neither exists in `pnpm build`, which fails if either leaks into `dist/index.html`. In dev, the console also logs `[foc-viewer dev]` timings for each unlock, file open and range request.

| State | How to trigger |
|---|---|
| Wrong Access key | Enter any other `fak1_` key, or change a character of the printed one |
| Prompt-side checks | Paste a Share link, a `fgr1_` Grant, or a key without its prefix |
| Not available | Delete `dev/share.fee`, then submit |
| Share served whole | Add `?ignore-range` before the `#` (`http://localhost:5173/?ignore-range#v1/<cid>&d=…`); the dev server then answers `200` with the whole file and its `Content-Length`, and a share up to 256 MiB opens from that one response |
| Can't be opened in the browser | Add `?ignore-range=chunked` instead; the `200` then has no `Content-Length` (as over the in-memory cap), so the viewer offers the body as `encrypted.fee` |
| Incomplete link | Use any other fragment, for example `#nope` |

The real path (the inbrowser.link service worker intercepting `https://<cid>.ipfs.inbrowser.link/` and fetching from storage providers; the host is never reached directly) can only be tested on the published Viewer.

## Rules

- **The build is one self-contained HTML file.** No external requests except Range requests to `https://*.ipfs.inbrowser.link`, which the service worker intercepts. Don't add dependencies lightly, and keep everything inline.
- **Don't change the CSP** in `index.html` without a reason recorded next to it. `'self'` in `connect-src` is required for Firefox.
- **Security invariants:**
  - every Download link is an `application/octet-stream` blob;
  - typed blobs only for previewable raster images, audio, video and PDF;
  - HTML only in the sandboxed iframe;
  - SVG and XML as text.
- **Range invariants:**
  - every request uses `cache: 'no-store'` and must get a `206`. The one exception is the head read: a `200` carrying the whole envelope, under the in-memory cap (`wholeBodyCap()`), is kept and read from memory;
  - **never request byte 0**: the gateway's service worker answers a range starting at byte 0 by downloading the whole file in the background (js-ipfs-unixfs#501). The first request is `bytes=1-327679`, and byte 0 is supplied as `0xd0`, the COSE_Encrypt0 tag every envelope starts with (see `range-source.ts`);
  - cancel the body of any response you throw away.
- **OPFS:**
  - write exactly sized buffers only (`exactBytes`), because WebKit writes a view's whole underlying buffer;
  - never delete a staged file that's locked.
- **Copied files:** `unixfs-car-layout.ts` is copied from filecoin-pin and marked with a `ponytail:` note. Keep it in step with filecoin-pin, and note any deliberate difference in the file header. Key handling is `@filoz/keysmith`; the link codec in `fragment.ts` must match filecoin-pin's `src/common/share-link.ts`.
- **Tests:** compare large byte arrays with `expectSameBytes` (`tests/fixtures/bytes.ts`), not `toEqual`, which takes seconds per MiB. Give a test its own timeout only when it does real work.
- **Style:** Biome (`biome.json`, line width 120). Small, boring code. Mark deliberate shortcuts with a `ponytail:` comment naming the limit and the upgrade path.
- **Don't commit** `dev/`, `dist/` or local test folders. They're gitignored.
