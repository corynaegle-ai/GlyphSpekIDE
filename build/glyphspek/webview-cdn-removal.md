# GlyphSpek — Removing the Microsoft-CDN webview dependency

> **M1 cleanliness item.** Decision date: 2026-05-30.
> **Change:** `product.json` `webviewContentExternalBaseUrlTemplate` set from
> `https://{{uuid}}.vscode-cdn.net/insider/<commit>/out/vs/workbench/contrib/webview/browser/pre/`
> to `""` (empty).

## TL;DR

**Removing/emptying `webviewContentExternalBaseUrlTemplate` is safe for the GlyphSpek desktop
Electron build.** The desktop build never reads that field; it serves webview content locally
from the app bundle over the `vscode-webview://` protocol. The field is only consumed by the
**web/browser** workbench build, which GlyphSpek does not ship. We emptied the field (rather
than deleting the key) to match the already-emptied MS endpoints in `product.json`
(`extensionsGallery.controlUrl`, `nlsBaseUrl`).

**Runtime verification at M5 (Trust Panel):** the Trust Panel is the first webview to render in
the branded app. We could not exercise a live webview without a package build (out of scope for
this task), so webview rendering MUST be confirmed at the next build / Trust Panel milestone.
Confidence is high based on the source paths below; this is a confirm-not-discover check.

## Why it is safe on desktop (source evidence)

The webview endpoint is resolved per-build by `IWorkbenchEnvironmentService.webviewExternalEndpoint`:

- **Desktop (Electron):**
  `src/vs/workbench/services/environment/electron-browser/environmentService.ts:112`
  ```ts
  get webviewExternalEndpoint(): string { return `${Schemas.vscodeWebview}://{{uuid}}`; }
  ```
  This is a hardcoded **local** scheme (`vscode-webview://`). It does **not** reference
  `product.webviewContentExternalBaseUrlTemplate` at all. Emptying the product field cannot
  affect it.

- **Web/browser:**
  `src/vs/workbench/services/environment/browser/environmentService.ts:228-237` is the **only**
  non-test consumer of `webviewContentExternalBaseUrlTemplate`. It uses, in order:
  `options.webviewEndpoint` → `product.webviewContentExternalBaseUrlTemplate` →
  a hardcoded `https://{{uuid}}.vscode-cdn.net/...` fallback baked into the source. So in a web
  build, emptying the product field would just fall through to that hardcoded CDN fallback
  anyway — emptying the field does not, by itself, remove the CDN from a web build. GlyphSpek
  ships desktop, not web, so this path is not exercised.

`webviewElement.webviewContentEndpoint()`
(`src/vs/workbench/contrib/webview/browser/webviewElement.ts:571-582`) consumes
`webviewExternalEndpoint` and throws if it is empty. On desktop it is the non-empty
`vscode-webview://{{uuid}}`, so the empty product field does not trip that guard.

### Where the desktop content actually comes from (no network)

Desktop webview HTML/JS is served from inside the signed app bundle by a local Electron protocol
handler — there is no CDN fetch:

- `src/vs/platform/webview/electron-main/webviewProtocolProvider.ts` registers
  `protocol.handle('vscode-webview', …)` and serves `/index.html`, `/fake.html`,
  `/service-worker.js` from `vs/workbench/contrib/webview/browser/pre/...` via
  `FileAccess.asFileUri(...)` (local app resources).
- `src/vs/code/electron-main/app.ts` only treats `vscode-webview://` frames as webview origins;
  nothing routes webview content to `vscode-cdn.net`.

## Decision

- Set `webviewContentExternalBaseUrlTemplate` to `""` in `product.json`. This removes the last
  genuine `vscode-cdn.net` runtime endpoint string from the GlyphSpek product config without
  touching workbench source.
- We intentionally did **not** delete the key, to keep `product.json` shape stable and mirror
  the other emptied MS endpoints.

## Follow-ups / caveats

1. **M5 runtime check (required):** load the Trust Panel webview in the packaged branded app and
   confirm it renders from `vscode-webview://` with **no** request to `*.vscode-cdn.net`
   (DevTools Network tab / a network-deny run). This is the first webview in the product.
2. **If GlyphSpek ever ships a web/server build:** the empty product field will fall back to the
   hardcoded `vscode-cdn.net` source string in `browser/environmentService.ts:231`. To make a web
   build CDN-free we would additionally need to set `options.webviewEndpoint` (self-hosted) or
   patch that hardcoded fallback. Out of scope for the desktop M1 cleanliness item; noted so the
   web path is not assumed clean.
