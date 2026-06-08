# GlyphStudio — Clean Code‑OSS Distribution Plan

> Status: scaffold notes for the **clean distribution** approach decided 2026‑05‑29.
> This is a *thin* distribution of **Code – OSS** (`microsoft/vscode`, MIT). We build from
> upstream source and layer branding via `product.json` + build overrides. **Not** a deep
> fork; **not** stock‑extension‑only. Keep the diff to upstream minimal.

## Provenance

- Fork: `corynaegle-ai/GlyphStudioIDE` (fork of `microsoft/vscode`; repo renamed from `vscode` → `GlyphStudioIDE`).
- This working tree: shallow clone (`git clone --depth 1`) of the fork, now at `glyph-studio/glyphstudio-codeoss/` (inside the planning repo, gitignored; IDE code commits to the fork's own remote).
- **M0 status (2026-05-30):** branding applied on branch `glyphstudio` — `product.json` rebranded, Open VSX gallery wired, Copilot/telemetry blocks stripped, app icons regenerated from `resources/glyphstudio/` (macOS `.icns` + Linux `.png` done; Windows `.ico` pending ImageMagick via `build/glyphstudio/generate-icons.sh`).
- Upstream HEAD at clone time: `e4074382` — product version **1.123.0**.
- Toolchain pin: `.nvmrc` → **Node 24.15.0** (the build is version‑sensitive; the machine
  currently has Node 25.x installed — use `nvm use` / install 24.15.0 before building).

## Branding knobs — `product.json` (clone root: `./product.json`)

The single source of truth for branding is `product.json` at the repo root. It is read at
runtime through `src/vs/base/common/product.ts` (the `IProductConfiguration` interface
defines every legal field). Upstream Code‑OSS defaults these to "Code - OSS" / `code-oss`.

For the GlyphStudio distribution, override **at minimum** these fields. Use the existing
GlyphStudio naming conventions (`glyphstudio` publisher/short name, `.glyphstudio` data folder,
no Microsoft Marketplace, no telemetry) already established in `../glyph-studio/extension/`.

| `product.json` field | Upstream value | GlyphStudio distribution value | Purpose |
| --- | --- | --- | --- |
| `nameShort` | `Code - OSS` | `GlyphStudio` | Short product name (window title, About) |
| `nameLong` | `Code - OSS` | `GlyphStudio` | Long product name |
| `applicationName` | `code-oss` | `glyphstudio` | CLI binary name / `bin` entry |
| `serverApplicationName` | `code-server-oss` | `glyphstudio-server` | Remote server binary name |
| `serverDataFolderName` | `.vscode-server-oss` | `.glyphstudio-server` | Server-side data dir |
| `tunnelApplicationName` | `code-tunnel-oss` | `glyphstudio-tunnel` | Tunnel CLI name |
| `dataFolderName` | `.vscode-oss` | `.glyphstudio` | Per-user data dir (`~/.glyphstudio`) — matches extension keystore root |
| `sharedDataFolderName` | `.vscode-oss-shared` | `.glyphstudio-shared` | Shared data dir |
| `urlProtocol` | `code-oss` | `glyphstudio` | Custom URL scheme (`glyphstudio://`) |
| `darwinBundleIdentifier` | `com.visualstudio.code.oss` | `dev.glyphstudio.app` (TBD) | macOS bundle id |
| `linuxIconName` | `code-oss` | `glyphstudio` | Linux icon basename |
| `win32DirName` / `win32NameVersion` / `win32RegValueName` / `win32AppUserModelId` / `win32MutexName` / `win32ShellNameShort` | `…Code OSS…` | `GlyphStudio` variants | Windows install/registry identity (regen the `win32*AppId` GUIDs) |
| `reportIssueUrl` | `…/microsoft/vscode/issues/new` | `https://github.com/corynaegle-ai/glyph-studio/issues/new` | "Report Issue" target |
| `licenseUrl` / `serverLicenseUrl` | upstream MIT links | GlyphStudio repo `LICENSE` links | License links |

Branding **assets** (icons, app bg) live outside `product.json`, under:
- `resources/darwin/`, `resources/linux/`, `resources/win32/` — platform app icons.
- `src/vs/workbench/browser/parts/editor/media/` — empty-editor / watermark assets.

### Open VSX gallery wiring (NOT present upstream — must be added)

Code‑OSS ships **without** an `extensionsGallery` block (no marketplace by default), so this
is an *additive* edit. Add this top‑level object to `product.json` to point the in‑product
Extensions view at Open VSX (the field shape is defined by `extensionsGallery?` in
`src/vs/base/common/product.ts`, lines ~112‑119):

```jsonc
"extensionsGallery": {
  "serviceUrl": "https://open-vsx.org/vscode/gallery",
  "itemUrl": "https://open-vsx.org/vscode/item",
  "resourceUrlTemplate": "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/{path}",
  "controlUrl": "",
  "nlsBaseUrl": ""
}
```

- `serviceUrl` → `https://open-vsx.org/vscode/gallery` (search/install API).
- `itemUrl` → `https://open-vsx.org/vscode/item` ("View in Marketplace" links).
- `resourceUrlTemplate` is what Open VSX documents for web/resource assets; include it so
  webview/icon assets resolve. Leave `controlUrl`/`nlsBaseUrl` empty (no MS malicious-ext
  control list, no MS NLS CDN).

> Keep telemetry **off**: do not add `aiConfig`/`enableTelemetry`/`telemetry*` keys. The
> GlyphStudio extension already declares "no telemetry"; the distribution must not reintroduce
> Microsoft telemetry endpoints. `defaultChatAgent` / Copilot blocks can be left as-is
> (inert without the Copilot extension) or stripped for a leaner diff.

## How the override is applied (keep the diff minimal)

Two clean‑distribution options; both keep upstream source untouched except `product.json`:

1. **Edit `product.json` in place** on a `glyphstudio` branch of the fork (simplest; the file
   *is* the intended override point). This is the recommended P0 path.
2. **Overlay file + build copy** — keep a `product.glyphstudio.json` and copy it over
   `product.json` in CI before building, so the upstream file stays pristine for clean
   rebases. Adopt later if rebase churn on `product.json` becomes painful.

## Build commands

Prereqs (macOS arm64): Node **24.15.0** (`.nvmrc`), Python 3, Xcode CLT, and native build
deps. Then:

```bash
# from this clone root: /Users/cory.naegle/Projects/glyph-spek/glyphstudio-codeoss
nvm install && nvm use            # picks up .nvmrc → Node 24.15.0
npm install                       # installs deps + runs node-gyp native builds (heavy: ~10–30+ min)
```

**Dev run (fastest inner loop — no packaged app):**

```bash
npm run watch        # incremental TypeScript/extension compile (long first pass; leave running)
./scripts/code.sh    # launches the dev Electron build with current product.json branding
```

**Packaged macOS arm64 app (full build):**

```bash
npm run gulp vscode-darwin-arm64
# output: ../VSCode-darwin-arm64/<nameLong>.app  (sibling of this repo)
# (task name is generated as vscode-<platform>-<arch> in build/gulpfile.vscode.ts)
```

Other useful targets: `compile-cli`, `vscode-darwin-x64`, `vscode-linux-x64`,
`vscode-win32-x64`, plus `*-ci` / `*-min` variants. List with `npm run gulp -- --tasks`.

## Notes / open items

- Regenerate all `win32*AppId` GUIDs before shipping a Windows build (don't reuse MS GUIDs).
- Decide final `darwinBundleIdentifier` and codesigning identity.
- Confirm Open VSX `resourceUrlTemplate` against current open-vsx.org docs before relying on
  in-product asset rendering.
- Built‑in `ms-vscode.*` debug extensions in `builtInExtensions` are fetched from Microsoft
  repos at build time; acceptable for P0 (MIT-licensed, not the Marketplace) but review for
  the "no MS dependency" guardrail.
