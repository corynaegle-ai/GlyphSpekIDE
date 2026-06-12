# GlyphStudio Trust Panel — IDE extension (Workstream 4)

The GlyphStudio **Trust Panel** hosted as a **plain VS Code / Code-OSS extension**.
This is the charter's review surface (Workstream 4; W1-19 / W1-27 / W1-28) turned
from a standalone prototype into an editor integration — the actual IDE surface a
reviewer uses to decide whether to trust a governed agent run.

It is a regular extension, **not a fork**:

- **No deep fork** of the editor — it activates via a few commands and renders the
  panel in a `WebviewPanel`.
- **Open-VSX-distributable. No Microsoft Marketplace dependency**, no proprietary
  Microsoft extensions, and **no telemetry**.
- The only dependencies are dev typings/compiler: `@types/vscode`, `@types/node`,
  and `typescript` — all MIT, and `@types/vscode` is the open API typings.

This demonstrates the trust-review surface works as a plain extension (no deep
fork, no Marketplace lock-in) — distribution-decision evidence.

## What it shows (the load-bearing behavior is intact)

The webview is the same trust surface as `prototypes/trust-panel`, with its two
non-negotiable properties preserved:

1. **Claims ≠ verdict.** The agent's **actor claims** (amber, dashed, *self-reported
   · NOT authoritative*) are kept visually and structurally distinct from the
   independent **verifier verdict** (blue, solid, *independent · signed ·
   authoritative*). A self-reported "all tests pass" never substitutes for a
   signed verdict.
2. **Signature-before-display gate, against an out-of-band trust root.** A verifier
   verdict is presented as **product AUTHORITATIVE only after** its Ed25519 detached
   signature is verified **in-browser with Web Crypto** over
   `canonicalJson({ traceRootHash, verdict })` **AND** the signing key is one the
   panel trusts **out-of-band** — provisioned through the extension trust-root path
   (the `glyphstudio.trustedVerifierKeys` machine-scoped setting, or the extension
   keystore at `~/.glyphstudio/verifier/`), **never** a key carried inside the run
   bundle. A `verifier-public-key.pem` shipped in a bundle is evidence/transport
   only: a signature that verifies against a *bundle-supplied* (non-trusted) key
   renders as **valid-but-untrusted-key**, not authoritative. The built-in demo key
   is its own tier and renders as **DEMO-AUTHORITATIVE**, never product authoritative.
   A bad/missing signature, a tampered verdict/chain, a signing key that is not an
   out-of-band trust root, or a runtime lacking Web Crypto Ed25519 all keep the
   verdict out of product-authoritative — never silently "verified".
3. **Assurance is earned, not asserted.** A product-AUTHORITATIVE banner carries an
   honest **assurance qualifier** derived from the bundle's persisted isolation
   evidence, and the full-trust presentation is **reserved**:
   - **"AUTHORITATIVE — independently verified (sandboxed)"** (full-trust blue)
     **only** when `verifierIsolation` is `independent-sandboxed` — the verify
     targets really re-ran in the verifier's **own fresh `network:deny` container**,
     separate from the actor, and the verdict was signed over the trace root by the
     actor-inaccessible key. This is the shipped product path (not a demo label)
     whenever an isolation runtime is present: the machine-scoped
     `glyphstudio.verifierRuntime` setting selects it (`auto` default — Docker is
     **detected, never required**; `docker` / `firecracker` explicit; `off` never
     isolates).
   - **"AUTHORITATIVE (signature) — degraded assurance: inline check"** (amber)
     for an inline or unknown-isolation verdict. No isolation runtime → the build
     still completes and the verdict is still signed, but it is honestly `degraded`
     with a visible structured reason (e.g. "docker daemon not running",
     "runtime preference 'off'…") — never `full`, never blocked.
   - The banner also shows a **fingerprint badge** ("Verified by key
     `xxxx:xxxx:xxxx:xxxx`") naming the verdict's signing key, for comparison with
     a fingerprint exchanged out-of-band: **GlyphStudio: Export Verifier Public
     Key** (`glyphstudio.exportVerifierKey`) on the sender side and **GlyphStudio:
     Trust a Verifier Key…** (`glyphstudio.trustVerifierKey`) on the reviewer
     side.

   Recorded real-runtime evidence for both postures (full twin over a real Docker
   container + degraded twin with the runtime preference off):
   `docs/verifier-authoritative-evidence-2026-06-11.md`.

### Trust division (host vs webview)

The extension **host** (`src/extension.ts`, Node) only reads run-bundle files off
disk with `node:fs` and posts their **raw bytes** to the webview. It does not
parse, judge, or vouch for them. All parsing, the claims/verdict split, and the
Ed25519 verification happen **inside the webview** (`media/app.js`) where Web
Crypto runs — so the gate cannot be bypassed by the host. The webview runs under
a strict CSP (`default-src 'none'`, nonce'd scripts, styles only from the
extension's media dir, no remote origins).

## Commands

- **GlyphStudio: Open Trust Panel** (`glyphstudio.openTrustPanel`) — opens the panel.
  On open it loads and **verifies** the embedded signed sample bundle in-browser.
- **GlyphStudio: Load Run Bundle…** (`glyphstudio.loadRunBundle`) — pick a run-bundle
  **directory**; the host reads `trace.jsonl`, `verdict.json`,
  `verifier-public-key.pem`, and (if present) `actor-claims.json`, then posts them
  to the webview, which renders and verifies them.
- **GlyphStudio: Run Governed Task…** (`glyphstudio.runGovernedTask`) — **development
  bridge, not yet a packaged product feature.** Runs a governed task end-to-end by
  spawning the companion supervisor, then loads the produced bundle into the panel,
  verified against the verifier key pinned out-of-band from `~/.glyphstudio/verifier/`.
  ⚠️ The supervisor is **not yet bundled, signed, or hash-pinned into the VSIX**: it
  is launched as an external TypeScript tree via `node --import tsx`, so this command
  currently requires a local spikes checkout (set `glyphstudio.supervisorPath` in
  **user/global** settings — it is `machine`-scoped so a workspace cannot redirect it)
  plus a reachable Docker daemon. Bundling/pinning the supervisor into the extension
  artifact is the planned step that turns this into a distributable, sovereignty-grade
  feature. Until then, treat it as dev-only.

## How to run

### F5 (Extension Development Host)

1. Open this folder (`extension/`) in VS Code or Code-OSS (VSCodium etc.).
2. `npm install`
3. `npm run compile` (runs `tsc -p .`, emitting `dist/extension.js`).
4. Press **F5** to launch the Extension Development Host.
5. Run **GlyphStudio: Open Trust Panel** from the Command Palette. It opens with the
   signed sample already verified. Use **Tamper sample (demo)** to watch the gate
   flip the verdict to UNTRUSTED.
6. Run **GlyphStudio: Load Run Bundle…** and pick a real bundle directory — see
   below.

### Loading the real demo-output bundles produced by the spike

The spike's capstones produce matching real bundles. Point **Load Run Bundle…**
at either directory:

```
../demo-output/capstone/             # trace.jsonl + verdict.json + verifier-public-key.pem + actor-claims.json
../demo-output/autonomous-capstone/
```

Each contains a hash-chained `trace.jsonl`, a signed `verdict.json`
(`VerifierVerdict`), the SPKI `verifier-public-key.pem` (**evidence/transport — the
bundle's own copy of the verifier key, NOT a product trust root**), and
`actor-claims.json` (the actor's non-authoritative self-report). The panel parses
the trace, renders the run, and separates claims from verdict. A verifying signature
proves the bundle is internally consistent; the panel shows full product
**AUTHORITATIVE** only when the signing key also matches an **out-of-band** trust
root (the extension keystore or `glyphstudio.trustedVerifierKeys`). A bundle whose key
is only its own embedded copy renders as **valid-but-untrusted-key**. (The shipped
demo sample is signed by the built-in demo key → **DEMO-AUTHORITATIVE** — that tier
is permanent and correct for demo-key bundles, independent of the product
AUTHORITATIVE path.) Within product-AUTHORITATIVE, the full-trust qualifier follows
the bundle's isolation evidence as described above: independent-sandboxed → full;
inline/unknown → degraded (amber).

### Packaging a VSIX for Open VSX (no Microsoft Marketplace)

```
npx @vscode/vsce package          # produces glyphstudio-0.0.1.vsix
npx ovsx publish glyphstudio-0.0.1.vsix --pat <OPEN_VSX_TOKEN>
```

`vsce package` only builds the VSIX; publishing targets **Open VSX** via `ovsx`.
There is no dependency on the Microsoft Marketplace.

## Layout

```
extension/
  package.json            # name "glyphstudio", two commands, no Marketplace deps
  tsconfig.json           # commonjs, ES2021, strict, outDir dist
  src/extension.ts        # host: registers commands, hosts the webview, reads bundles via node:fs
  media/
    index.html            # CSP-locked webview shell (nonce + cspSource tokens filled by the host)
    styles.css            # panel styles (from the prototype, unchanged)
    app.js                # the trust surface + Ed25519 verify + host bridge
    sample-bundle.js      # embedded, really-signed sample (verifies on open)
```
