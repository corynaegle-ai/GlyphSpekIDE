# GlyphSpek — Telemetry Posture

> Honest statement of what GlyphSpek does and does not send, what was **verified**
> vs **assumed**, and how the `verify-no-telemetry.sh` gate enforces it.
> Authored 2026-05-30 (GATE-003). See `SECURITY-PATCHES.md` → GATE-003 for the
> ledger entry and `build/glyphspek/vendored-telemetry-allowlist.json` for the
> per-file inventory.

## Claim

**GlyphSpek introduces no telemetry. Telemetry, the Microsoft Marketplace, and the
Microsoft update service are disabled at the product level. The vendored upstream
built-ins ship dormant Microsoft endpoint constants that GlyphSpek does not
activate.**

This is a security CLAIM. The static gate proves the *negative* part mechanically
(no GlyphSpek-introduced telemetry string; the only endpoint strings are an
inventoried vendored-dormant set). The *authoritative* proof that nothing phones
home is the dynamic cold-launch network capture documented in
`verify-no-telemetry.sh` — run it before signing off the claim.

## What GlyphSpek introduces — VERIFIED zero telemetry

Verified 2026-05-30 against the packaged app
(`../VSCode-darwin-arm64/GlyphSpek.app`) and `product.json`:

- **Embedded `glyphspek-trust-panel` extension:** appears in **none** of the gate's
  HARD endpoint hits. Its compiled `dist/extension.js` contains **zero** Microsoft
  telemetry/Marketplace/update endpoint hosts, **no** `TelemetryReporter` /
  `@vscode/extension-telemetry` / `sendTelemetry*` usage, and **no** outbound
  http(s) URLs beyond local/schema references. The only matches for the words
  "telemetry"/"Microsoft" in the extension are **descriptive prose negations**
  (package.json description and README/webview text: "no telemetry", "no Microsoft
  Marketplace dependency") — i.e. the extension advertises the *absence* of
  telemetry; it is not an endpoint.
- **`product.json`:** no `aiConfig`, `enableTelemetry`, `aiKey`, `tasConfig`, or
  `crashReporter` keys. So the core telemetry channel is **unconfigured** — the
  vendored telemetry SDKs are never instantiated with an instrumentation key.
- **Gallery:** `extensionsGallery.serviceUrl` = `https://open-vsx.org/vscode/gallery`
  (Open VSX), **not** `marketplace.visualstudio.com`.
- **Update service:** no `updateUrl` key → the update service has no server to poll
  (`update.code.visualstudio.com` is only a default base-URL constant, never used).
- **Issue reporter:** `reportIssueUrl` = the GlyphSpek repo
  (`github.com/corynaegle-ai/GlyphSpekIDE/issues/new`), not Microsoft's.
- **Webview CDN:** `webviewContentExternalBaseUrlTemplate` is empty (see
  `build/glyphspek/webview-cdn-removal.md`).

If any GlyphSpek-authored surface (the embedded extension, `product.json`, or new
fork code) ever introduces a telemetry/Marketplace/update endpoint string, the gate
**hard-fails** — that path is not in the vendored allowlist.

## What is vendored from upstream — DORMANT, inventoried

Code-OSS vendors Microsoft-authored material that carries hard-coded default
telemetry/Marketplace/update endpoints as **string constants**. GlyphSpek ships
these (stripping endpoint constants out of git / typescript-language-features / the
1DS SDK risks breaking those built-ins) but does **not** activate them. The packaged
app's HARD-endpoint hits resolve to **29 unique files** in three buckets, every one
inventoried in `vendored-telemetry-allowlist.json`:

| Bucket | Files | What the endpoint string is |
| --- | --- | --- |
| Microsoft built-in extensions (`extensions/<name>/dist/*`) | 9 | git, github, github-authentication, microsoft-authentication, typescript/html/json/markdown-language-features, merge-conflict — each embeds the `@vscode/extension-telemetry` / Application Insights (`dc.services.visualstudio.com`) + 1DS OneCollector default ingestion hosts as SDK constants. Dormant: a reporter transmits only with a product `aiKey` + `telemetryLevel != off`. |
| Vendored 1DS SDK (`node_modules/@microsoft/1ds-core-js/**`) | 11 | The 1DS OneCollector core SDK. `_ENDPOINT_URL = "https://browser.events.data.microsoft.com/OneCollector/…"` etc. are the SDK's **default collector hosts** (constants in `InternalConstants.js` + prebuilt bundles). Transmits only when instantiated with a real instrumentation key. |
| Core `out/` bundles | 9 | `nls.*` (a localized **doc-link description** string mentioning `marketplace.visualstudio.com` — a Dev Containers docs link, not the gallery endpoint), workbench/sessions bundles (same doc-link + the `api.github.com/repos/microsoft/vscode-distro` issue-reporter fallback), and the telemetry/shared/cli/agent-host bundles (1DS OneCollector default host + `update.code.visualstudio.com` default base URL). All are unreached defaults / description text given the product-level config above. |

### What was VERIFIED vs ASSUMED

- **VERIFIED (opened and read):** for each bucket, a representative hit was opened
  and confirmed to be a *string constant* (`const base = "https://update.code…"`,
  `_ENDPOINT_URL = "https://browser.events.data…"`, `var rs="https://dc.services…"`)
  or a *localized description* (the Dev Containers marketplace doc link), not an
  active call expression in the shipped configuration. The product-level switches
  that would activate them (`aiConfig`/`aiKey`/`enableTelemetry`, `updateUrl`,
  the MS gallery) are confirmed **absent/overridden** in `product.json`.
- **ASSUMED (not exhaustively traced):** that *no* code path in the 50 hits is
  reachable in the shipped config. The static gate cannot prove non-reachability of
  every minified branch. The standing requirement to fully close the claim is the
  **dynamic cold-launch network capture** (offline-first, watch for packets to the
  HARD hosts) documented in `verify-no-telemetry.sh`. Static = potential endpoints;
  capture = actual runtime behavior.

## How the gate enforces this

`build/glyphspek/verify-no-telemetry.sh` greps the packaged app for the HARD
endpoint set and **classifies every hit** against
`vendored-telemetry-allowlist.json`:

- hit path matches an allowlist glob → **VENDORED-DORMANT** (inventoried, expected)
  → does not fail;
- hit path matches nothing → **UNEXPECTED** → **hard FAIL** (exit 1). This catches
  GlyphSpek-introduced telemetry *and* any new vendored file not yet inventoried.

Verdict when only vendored-dormant hits remain: **PASS** with an inventoried
accounting (no longer a perpetual REVIEW). The allowlist is checked into git so the
inventory is auditable and any unexpected telemetry string trips the gate.

**Scope note:** the allowlist is scoped to the **packaged `.app`** (the shipped
artifact). The dev `./out` tree is an unbundled build intermediate (hundreds of
individual core `vs/**` modules + tests that minify into the inventoried bundles), so
a scan of `./out` may report core modules as UNEXPECTED. Scan the packaged app for
the authoritative verdict.

## Re-verify

```sh
# authoritative: scan the packaged app -> expect RESULT: PASS, exit 0
bash build/glyphspek/verify-no-telemetry.sh ../VSCode-darwin-arm64/GlyphSpek.app

# then close the claim with the dynamic capture (see the script's DYNAMIC section):
# cold, offline-first launch + tcpdump/Little Snitch on the HARD hosts -> expect zero packets
```
