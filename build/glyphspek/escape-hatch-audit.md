# GlyphSpek — M4 Escape-Hatch Discovery & Classification

> **Deliverable:** M4 security task — enumerate every surface across the Code-OSS fork
> (`glyphspek-codeoss`, branch `glyphspek`), the first-party extension
> (`extensions/glyphspek-trust-panel/` ← source `../extension`), and the supervisor
> (`spikes/p0-supervisor`) that lets code RUN or EGRESS *outside* GlyphSpek's
> governance while a user might still believe the session is governed — or that
> otherwise undermines the trust/trace claim.
>
> **Audit posture:** READ-ONLY. No source edited, no build run, nothing committed.
> Consistent with `docs/threat-model.md` and the standing memory facts (soft egress
> is proxy-only / raw-socket-bypassable on the Docker-local plane; a hard allowlist
> requires the future Firecracker remote plane; security-load-bearing settings are
> machine-scoped specifically so a workspace cannot redirect enforcement).
>
> **Date:** 2026-05-31 · **Author:** senior-architect security review (Claude).

---

## The governance claim being defended

GlyphSpek's core claim: it GOVERNS an agent's egress (metadata-only proxy), produces
an honest, tamper-evident trace, and presents a strict trust vocabulary. The
exhaustive creation-trust set (`extension/src/runTrustBadge.ts`,
`webviewGestureGate.ts`, `media/live.js`) is:

| Posture | Product-trust-eligible? |
|---|---|
| `trusted` | yes — and ONLY after the webview Ed25519 signature gate ALSO passes |
| `sandboxed-soft-egress` | no |
| `governed-unsandboxed` | no (the v1 in-IDE Governed Terminal / Chat posture) |
| `untrusted` | no |
| `refused` | no |

**An escape hatch is anything that lets code run/egress outside this governance while
the IDE could still present the session as governed/trusted — OR that undermines the
trace/verdict integrity.** The single highest-priority class is any hatch that creates
a *false impression of governance* (an un-governed surface presented as governed).

## Where the boundary actually lives (and what is stock)

The most consequential structural fact found in this audit:

**The fork does NOT patch the stock Code-OSS execution surfaces.** Diffing the
`glyphspek` branch from its first GlyphSpek commit, the GlyphSpek-introduced changes to
`src/vs/**` are limited to: branding/getting-started, the policy-source loader
(PATCH-001: `main.ts`, `cliProcessMain.ts`, `filePolicyService.ts`,
`sovereignFilePolicyService.ts`, `multiPolicyService.ts`, `environmentService.ts`,
`argv.ts`), the agent-host Copilot/telemetry de-fang (`agentHost/**`,
`copilot*Stub.ts`), and the embedded first-party extension. **The integrated terminal,
`tasks`/`launch` runners, debug adapters, workspace-trust, the `code` CLI,
Remote-Tunnels / `serve-web`, settings sync, and the webview host are all UNMODIFIED
stock Code-OSS.** (Verified: `git diff <first-glyphspek-commit> HEAD -- src/vs/**` shows
no terminal/task/debug/tunnel/workspaceTrust files touched.)

GlyphSpek's *governance* — the egress proxy, sanitized env, trace, signed verdict —
lives ENTIRELY inside the **first-party extension + supervisor**, which govern ONLY the
runs/terminals/chat the extension itself creates (via `buildGovernedTerminalEnv` +
`startTerminalSession`). The IDE shell around it is stock. Therefore most escape hatches
below are NOT "fork bugs" — they are stock IDE capability that lives *outside* the
extension's governance envelope. The honest framing for almost all of them is:
**the GlyphSpek envelope is a per-run/per-terminal envelope inside an otherwise stock
IDE; it is not a whole-IDE confinement.** That is acceptable for P0 *only if the IDE
never presents these stock surfaces as governed/trusted* — which is the recurring
recommended hardening.

---

## Escape-hatch register

Classification legend:
- **PATCHED** — a fork change closes it (cited).
- **MITIGATED-SOFT** — reduced but soft-bypassable by design in P0.
- **KNOWN-GAP / ACCEPTED-P0** — open, accepted for the soft posture, honest reason given.
- **FUTURE-HARD-PLANE** — only closable by the Firecracker hard-egress remote plane.
- **STOCK-DEFAULT-MITIGATED** — a stock Code-OSS default/gate reduces it; not a GlyphSpek patch.

### A. Un-governed execution surfaces (the false-governance class)

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| A1 | **Normal integrated terminal** (`Terminal: Create New Terminal`, `` Ctrl+` ``) spawns an UN-governed shell with full host env + full network — no proxy vars, no env sanitization, host secrets/`SSH_AUTH_SOCK`/cloud tokens inherited. | YES | **KNOWN-GAP / ACCEPTED-P0** | This is the single most important hatch. The governed env (`buildGovernedTerminalEnv`, `strictEnv`) is applied ONLY to terminals the extension creates. A stock terminal is a fully un-governed sibling. It is *not falsely labeled* today (it has no GlyphSpek run/badge), but the product trust risk is that a user in a "GlyphSpek IDE" assumes the terminal is governed. **Top-priority product-trust item.** |
| A2 | **`tasks.json` task runner** — arbitrary process spawn with workspace-controlled `command`/`args`/`env`, including a `shell` task. Egress + exec entirely outside the proxy/sanitized env. | YES (gated) | **STOCK-DEFAULT-MITIGATED** | Stock `task.allowAutomaticTasks` defaults to `'off'` (`task.contribution.ts:545`) AND tasks "won't run in an untrusted workspace"; auto-run requires trust + explicit opt-in. So a freshly-opened untrusted repo does NOT auto-run a task. But a *manually* run task (or one in a trusted workspace with auto-tasks on) executes un-governed. Not GlyphSpek-patched; relies on stock trust gating. |
| A3 | **`launch.json` debug adapter** — `vscode.debug.startDebugging` / debug configs spawn arbitrary programs (`runtimeExecutable`, `program`, `preLaunchTask`) un-governed, with workspace-controlled args/env. | YES | **KNOWN-GAP / ACCEPTED-P0** | Stock debug. Gated by workspace trust for the config, but a trusted workspace's debug session runs fully outside the GlyphSpek envelope (own network, own env). Bundled `ms-vscode.js-debug` is shipped (`product.json builtInExtensions`). Not patched. |
| A4 | **`terminal.integrated.profiles.*` / `terminal.integrated.automationProfile`** workspace settings can define a shell profile (custom `path`/`args`) used by stock terminals/tasks. | YES (for stock terminals only) | **MITIGATED-SOFT** (extension path) / **KNOWN-GAP** (stock path) | For GlyphSpek's OWN terminals this is moot: `createTerminal({ env, strictEnv: true })` builds the COMPLETE env and does NOT merge `terminal.integrated.env.*` or inherit a profile, so a workspace profile cannot perturb the governed env. For STOCK terminals (A1) a workspace profile is honored — another un-governed path. |
| A5 | **`terminal.integrated.env.*`** workspace-scoped vars could try to clear/override `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` to defeat the governed env. | NO (against governed terminals) | **PATCHED (by design)** | The governed terminal uses `strictEnv: true` with a from-scratch allow-listed env (`governedTerminalEnv.ts` `sanitizeTerminalBaseEnv` + forced proxy vars, `NO_PROXY` cleared). VS Code's `strictEnv` makes the provided env the COMPLETE environment — `terminal.integrated.env.*` is NOT merged in. A workspace cannot inject/override the proxy vars for a governed terminal. (It still affects stock terminals — see A1/A4.) |

### B. Settings that redirect GlyphSpek's own enforcement

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| B1 | **`glyphspek.supervisorPath`** dev override — a workspace `.vscode/settings.json` redirects the spawned supervisor to attacker code (RCE + verifier-private-key exfil). | NO | **PATCHED (defense-in-depth, two layers)** | (1) `"scope": "machine"` in `extension/package.json` — VS Code refuses workspace/folder values for the key. (2) Even absent the scope, `selectSupervisorPath` (`configScope.ts`) reads via `inspect()` and accepts ONLY `globalValue ?? defaultValue`, IGNORING (and surfacing a warning for) any `workspaceValue`/`workspaceFolderValue`. A repo cannot redirect the exec path. |
| B2 | **Un-bundled / un-pinned supervisor reached by a workspace.** | NO | **PATCHED** | The dev path is only taken when a GLOBAL `supervisorPath` is set (B1). The default path spawns the BUNDLED supervisor whose sha256 is hash-pinned (`supervisorBinary.verifyBundleHash` against the tsc-compiled `BUNDLED_SUPERVISOR_SHA256`); tampering REFUSES-to-spawn. The verifier PRIVATE key is withheld from the dev supervisor unless `glyphspek.devSupervisorTrustKey` (also machine-scoped + global-only via `selectGlobalScopedBool`). |
| B3 | **`glyphspek.trustedVerifierKeys`** — a repo injects a trust root so a bundled verdict reaches AUTHORITATIVE. | NO | **PATCHED (two layers)** | `"scope": "machine"` + `selectGlobalScopedTrustKeys` accepts ONLY `defaultValue`+`globalValue`+the out-of-band keystore key; workspace scopes excluded. A key embedded in a bundle is never trusted; the built-in demo key yields the SEPARATE, clearly-labeled DEMO-AUTHORITATIVE state, never product AUTHORITATIVE. |
| B4 | **`glyphspek.runtime` / `glyphspek.runOutputRoot` / `glyphspek.supervisorMode`** — a workspace redirects execution backend, run-output location, or forces autonomous mode. | NO | **PATCHED** | All three are `"scope": "machine"` in `package.json`. A workspace cannot redirect the runtime, the run-output root, or the supervisor mode. (Confirm the machine-scope holds at runtime via the `configScope` test suite — defense-in-depth `inspect()` selection backs the scope.) |
| B5 | **`glyphspek.policyPath`** — a workspace supplies its OWN policy file. | YES (by design) | **MITIGATED-SOFT (intentional, policy-as-code)** | DELIBERATELY workspace-settable: a repo-local policy IS legitimate under policy-as-code. `classifyPolicyPath` reports the SCOPE; for `workspace`/`workspaceFolder` scopes the caller surfaces provenance (path + sha256) and requires operator confirmation before launching. Risk: a repo could supply a *permissive* policy — but the policy governs only the BROKERED/verify path, not a hard boundary, and is shown to the operator. Acceptable for P0; the honest residual is that policy permissiveness is operator-reviewed, not structurally bounded. |

### C. Extension-host arbitrary capability (third-party extension lateral surface)

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| C1 | **A third-party extension calls `child_process.spawn`, `vscode.tasks.executeTask`, `vscode.debug.startDebugging`, `workspace.fs`, raw `net`/`http`** — full host capability, entirely outside the GlyphSpek broker/proxy. | YES (Developer mode) / NO (Sovereign) | **MITIGATED-SOFT (Sovereign) / KNOWN-GAP (Developer)** | The extension host grants any enabled extension full Node capability — GlyphSpek does not (and cannot, without a deep fork) mediate the extension-host API. The ONLY structural control is the **Sovereign extension allowlist** (`AllowedExtensions` policy, stock-enforced, machine-policy, non-user-flippable — see `sovereign-profile/README.md` / PATCH-001): in Sovereign mode a non-allowlisted extension cannot load at all. In **Developer** mode arbitrary Open VSX extensions run with full capability and are explicitly OUTSIDE the trust claim (the design scopes Developer-mode trust to "the governed agent run only" + an ambient-extension warning that is **still a stub, NOT wired**). |
| C2 | **A third-party extension drives GlyphSpek's own commands** via `vscode.commands.executeCommand('glyphspek.runGovernedTask' / 'startLiveRun' / 'bridgeSupervisedRun')` to mint a TRUSTED run it initiated (caller-attribution break). | NO | **PATCHED (webview-gesture gate)** | VS Code commands carry no caller attribution, so the gate moved trusted-run creation BEHIND a first-party webview gesture: only a message posted from INSIDE the GlyphSpek Trust Panel webview (which a third party cannot post into) can `launchFromWebview` → mint+consume a single-use, short-lived `OperatorGestureRegistry` token → reach `createTrustedGovernedRun`. A bare `executeCommand` lacks a valid current gesture and is REFUSED before the keystore/private-key path (`operatorGesture.ts`, `webviewGestureGate.ts`, `extension.ts createTrustedGovernedRun`). Tokens are opaque/random/single-use/never-exported. |
| C3 | **`vscode.env.openExternal` / `asExternalUri` / port forwarding** used by any extension to exfiltrate (open an attacker URL carrying data, or forward a local port outward). | YES | **KNOWN-GAP / ACCEPTED-P0** | Stock API available to any enabled extension. GlyphSpek's own use of `openExternal` is limited to a docs link. As a generic extension-host capability it is out of the governance envelope and is contained ONLY by the Sovereign allowlist (C1). Honest residual: in Developer mode this is an open exfil channel that bypasses the metadata proxy entirely. |
| C4 | **First-party command surface auto-mints a trusted run** (regression risk on C2). | NO | **PATCHED** | The visible `glyphspek.runGovernedTask` command does NOT call a launcher directly; it asks the Trust Panel to surface the first-party "start run" affordance, and the launcher runs only after the operator clicks inside the webview. Test-pinned (`webviewGestureGate.test.mjs`, `runGovernedTaskGate.test.mjs`, `operatorGesture.test.mjs`). |

### D. Direct/raw egress bypassing the env proxy (the known soft boundary)

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| D1 | **A governed-terminal CLI strips `HTTPS_PROXY`/`HTTP_PROXY` and opens a raw socket** (or dials a direct IP), bypassing the metadata-only proxy. | YES | **MITIGATED-SOFT → FUTURE-HARD-PLANE** | This is the KNOWN, DOCUMENTED soft boundary, classified honestly. The governed terminal forces egress through the supervisor proxy via env vars only; a proxy-honoring client is confined to the allowlist + observed in the trace, but a hostile/hijacked client that strips the vars and opens a raw socket bypasses it (`governedTerminalEnv.ts` header; `terminal-session.ts` `governed-unsandboxed`). The session settles into `governed-unsandboxed` and is **NEVER product-trusted** — so the trust claim is honest. A HARD egress boundary (network-namespace default-DROP + allowlist) a raw socket cannot bypass is the **Firecracker remote plane's** job. |
| D2 | **Sandboxed (isolation) path soft egress** — the Docker-local isolation path forces egress through the proxy but the container is on the NAT bridge with a default route (no L4 DROP), so a raw socket bypasses the allowlist. | YES (isolation path) | **MITIGATED-SOFT → FUTURE-HARD-PLANE** | Matches `threat-model.md` row 4: on Docker-local the soft allowlist is application-layer only and raw-socket-bypassable; it is opt-in (`acknowledgeSoftEgress: true`) and the posture settles `sandboxed-soft-egress` — never product-trusted. The HARD default-deny (`--network none`) remains the hard posture for the deny case. Hard allowlisted egress = remote plane. |
| D3 | **Stock terminal / task / debug / extension raw egress** (A1–A3, C1) — egress entirely outside any GlyphSpek proxy. | YES | **KNOWN-GAP / ACCEPTED-P0** | Covered by A/C rows; listed here for completeness as egress vectors. These never claim to be governed, so they do not corrupt the trace; the risk is purely the false-impression-of-governance (see A1). |

### E. IDE / CLI / server entrypoints, sync, webview, lifecycle scripts

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| E1 | **`code`/`glyphspek` CLI + `--extensionDevelopmentPath`** — launch with an arbitrary dev extension that runs un-allowlisted with full capability (bypasses the Sovereign allowlist's enablement gate). | YES | **KNOWN-GAP / ACCEPTED-P0** | Stock CLI flag; a dev-extension-development-host loads the extension regardless of the allowlist. This is a local-operator capability (you must be able to run the binary with flags), not a remote/repo-reachable one, so it is accepted for P0 — BUT it means "Sovereign" is not a claim against a local operator who launches with dev flags. Should be documented in the threat model and, for true Sovereign deployments, blocked via OS/MDM launch policy. |
| E2 | **Remote-Tunnels / `code serve-web` / `glyphspek-tunnel`** — the stock CLI ships the tunnel + serve-web subsystem (`cli/src/tunnels`, `tunnelApplicationName: "glyphspek-tunnel"`, `serverApplicationName`); a tunnel exposes the IDE/host to a remote control plane and to remote extension-host execution. | YES | **KNOWN-GAP / ACCEPTED-P0** | Fully stock and present in the fork (branded but unmodified). A tunnel is an explicit operator action, but it opens a remote execution/egress path completely outside the governance envelope and could connect to a non-GlyphSpek control service. High-value to gate before any Sovereign GA. Not patched. |
| E3 | **Settings Sync** could sync down a `settings.json` that flips convenience settings. | PARTIAL | **MITIGATED-SOFT** | Security-load-bearing GlyphSpek keys are machine-scoped + policy/global-only (B1–B4), so sync cannot move a trust root or supervisor path. Sync of *other* settings (e.g. enabling auto-tasks) is possible and rides on the stock surfaces (A2). The Sovereign default-settings overlay that would turn telemetry/update off is **NOT WIRED** (`sovereign-profile/README.md` "What is NOT wired"), so a Sovereign build does not yet lock these as policy. |
| E4 | **Webview CSP / first-party webview** — a compromised webview content could post forged "start trusted run" messages or render a forged verdict. | NO (forged trust) | **PATCHED / MITIGATED-SOFT** | Trusted-run launch requires the first-party webview gesture (C2); a verdict is AUTHORITATIVE only after an in-browser Ed25519 signature check against the operator-provisioned `trustedVerifierKeys` (B3) — a forged/embedded key yields DEMO-AUTHORITATIVE, never product AUTHORITATIVE. The webview trust-root set is injected from the machine-scoped setting before `app.js` loads. Residual: the webview is the trust-DISPLAY surface, so its content integrity (CSP, no remote script) must hold; `product.json webviewContentExternalBaseUrlTemplate` is emptied (M1) removing the MS CDN dependency. |
| E5 | **Git hooks / npm lifecycle scripts auto-running on clone/open** (`postinstall`, `.git/hooks`) — code execution triggered by opening/cloning a repo. | YES | **KNOWN-GAP / ACCEPTED-P0** | This is host/tooling behavior, not IDE-mediated: GlyphSpek does not run `npm install` or git hooks on folder-open, and the stock IDE does not either (the bundled `git` extension does not execute hooks on open beyond standard git operations). The risk materializes only if the operator/agent runs `npm install`/`git commit` — inside a GOVERNED terminal those are egress-governed (soft) + traced; inside a STOCK terminal (A1) they are un-governed. Folded into A1/A2. Note `sync-embedded-extension.sh` is a BUILD-time script, not a runtime hook. |
| E6 | **Workspace-trust UX before trust is granted** — opening an untrusted folder: can any exec happen before the user grants trust? | NO (for the gated surfaces) | **STOCK-DEFAULT-MITIGATED** | Stock `security.workspace.trust.enabled` defaults to `true` (`workspace.contribution.ts:801`). Auto-tasks are gated by trust AND default `'off'` (A2); debug `restricted` configs are gated. So opening an untrusted repo does not auto-execute tasks/debug. But manual stock-terminal use (A1) and any already-enabled extension's activation (C1, in Developer mode) are NOT blocked by untrusted-folder state. |

### F. Trace / verdict integrity (does any hatch corrupt the honest trace?)

| # | Vector | Reachable today? | Classification | Rationale |
|---|--------|------------------|----------------|-----------|
| F1 | **Un-governed surfaces produce activity absent from the trace**, making the trace look complete when it is not. | YES | **KNOWN-GAP / ACCEPTED-P0 (scope honesty required)** | The trace is honest about WHAT IT GOVERNS (a run/terminal the extension created); it does not and cannot claim to be a whole-IDE audit log. Stock-terminal/task/debug/extension activity (A1–A3, C1–C3) is simply outside the trace. This is acceptable ONLY if the IDE never presents the trace as a complete record of all IDE activity. The trace + verdict integrity itself (hash-chain, Ed25519, scope-locked, redaction) is solid per `threat-model.md` rows 7–8. |
| F2 | **Forged/scope-narrowed verdict.** | NO | **PATCHED (crypto)** | Per `threat-model.md` row 8 — Ed25519 over `(verdict, traceRootHash)`, key actor-inaccessible, scope read from reviewed policy only, signature display gate in the webview. Not re-litigated here. |

---

## Summary by classification

| Classification | Count | Rows |
|---|---|---|
| **PATCHED** | 7 | A5, B1, B2, B3, B4, C2, C4, (E4 trust-forgery), (F2 crypto) → core: A5,B1,B2,B3,B4,C2,C4 |
| **MITIGATED-SOFT** | 5 | A4, B5, C1 (Sovereign), E3, E4 |
| **STOCK-DEFAULT-MITIGATED** | 3 | A2, E6 (and A2 overlaps) |
| **KNOWN-GAP / ACCEPTED-P0** | 8 | A1, A3, C1 (Developer), C3, D3, E1, E2, E5, F1 |
| **FUTURE-HARD-PLANE** | 2 | D1, D2 (raw-socket soft egress — both planes) |

(Some rows carry two classifications because the answer differs by mode/path; they are
counted under their dominant open posture. The numeric register has ~24 distinct
vectors across A–F.)

---

## Top open gaps (highest product-trust risk)

1. **A1 — the un-governed stock integrated terminal inside a "GlyphSpek IDE".** The
   governed env applies only to extension-created terminals; a normal `Create New
   Terminal` is a full-network, full-secret, un-governed shell. It is not falsely
   badged today, but the brand implies governance. **Highest priority: the IDE must
   never let a stock terminal be mistaken for a governed one** (e.g. distinct
   naming/affordance, or — for Sovereign — disabling/relabeling the stock terminal so
   "terminal" means "governed terminal").

2. **C1 / C3 (Developer mode) — arbitrary extension-host capability + `openExternal`/
   port-forward as un-governed exec/exfil channels.** In Developer mode any Open VSX
   extension runs with full Node + VS Code API capability outside the broker/proxy, and
   the ambient-extension warning that is supposed to flag this is **still a stub, not
   wired**. The only structural control is Sovereign-mode allowlisting; Developer mode's
   trust claim is "governed run only," which must be surfaced loudly.

3. **E2 — Remote-Tunnels / `serve-web` shipped unmodified.** A stock tunnel opens a
   remote control + remote-extension-host execution path entirely outside the
   governance envelope and could connect to a non-GlyphSpek service. High-value to gate
   (disable or policy-block) before any Sovereign GA. **E1 (`--extensionDevelopmentPath`)**
   is the close runner-up: it defeats the Sovereign allowlist for a local operator.

---

## CIO-level flags (escalate, do not silently accept)

These materially affect whether the governance/trust claim can be stated honestly and
are *not* closable in the P0 soft posture without a product/positioning decision:

- **CIO-FLAG-1 — "GlyphSpek IDE" is a per-run envelope inside a stock IDE, not a
  confined IDE.** The terminal/task/debug/extension/tunnel surfaces (A1–A3, C1–C3, E1–E2)
  are un-governed stock surfaces. P0 can ship honestly **only** with explicit messaging
  that GlyphSpek governs *the runs/terminals it creates*, not the whole IDE, and with the
  IDE never presenting a stock surface as governed/trusted. If marketing/positioning
  implies whole-IDE confinement, that is an overclaim that this audit cannot support in
  P0. **Escalate the positioning, not just the engineering.**

- **CIO-FLAG-2 — the Sovereign hard-confinement story is only partly wired.** The
  `AllowedExtensions` policy enforcement is genuinely stock-hard (PATCH-001 + fail-closed),
  BUT (a) the ambient-extension Developer-mode warning is a **stub, not wired**; (b) the
  Sovereign default-settings overlay (telemetry/update/auto-task lockdown) is **not wired**;
  and (c) `--extensionDevelopmentPath` and Remote-Tunnels are not blocked even in Sovereign.
  So "Sovereign = locked down" is not yet end-to-end true. Decide whether Sovereign GA
  requires closing (a)–(c) or whether P0 ships Developer-only with a scoped claim.

- **CIO-FLAG-3 (honest, NOT a regression) — raw-socket egress is a soft boundary by
  design.** D1/D2 cannot be honestly called "patched" on Docker-local; a hard egress
  allowlist requires the Firecracker remote plane. This is already the documented posture
  and the trust vocabulary handles it correctly (`governed-unsandboxed` /
  `sandboxed-soft-egress`, never product-trusted). Flagged only so it is not silently
  re-described as enforcement in any external claim.

---

## What is honestly closed (do not re-flag)

The trust-redirection class is genuinely shut: a malicious **repository** cannot redirect
the supervisor (B1/B2), inject a verifier trust root (B3), redirect runtime/output/mode
(B4), defeat the governed terminal env via `terminal.integrated.env.*` (A5/A4), or drive a
third-party extension to mint a product-trusted run (C2/C4) — each via machine-scope +
defense-in-depth `inspect()` selection + the webview-gesture gate + the hash-pinned
supervisor. The verdict/trace crypto (F2) is solid. The residual risk is overwhelmingly
**un-governed stock IDE surfaces** (false impression of governance), not a redirectable
GlyphSpek control.

---

## Addendum G — AI inner-loop + remote surfaces (added 2026-06-03)

> **Scope.** Sections A–F (2026-05-31) predate the AI inner-loop (Tab completion, code-index
> retrieval/build, Cmd-K inline edit, the governed chat participant) and the
> remote-control / APNs features. None of `ollama`, `inlineCompletion`, `index/retrieve`,
> `code-index`, `fimComplete`, `inline-edit`, `remote-gateway`, or `APNs` appears in A–F.
> This addendum audits exactly those **GlyphSpek-ADDED** surfaces under the same governance
> claim and the same classification vocabulary. (READ-ONLY audit; `ios/` app code is
> OUTSIDE-TRUST-SCOPE — owned by a separate agent.)
>
> **Why a new-surface hatch matters more than a stock one.** A–F leaned on "these are *stock*
> capabilities that never *claim* to be governed." That alibi does NOT transfer: these are
> surfaces GlyphSpek built and brands as its AI DX. An ungoverned one is a self-inflicted
> false impression of governance — worse than an un-badged stock terminal. The load-bearing
> distinction throughout is **brokered+traced** (a `model_call` breadcrumb mirrored to the
> run/event stream) **vs. raw/direct** (a bare `fetch`/transport with no trace event).

### G. AI inner-loop + remote surfaces

| id | hatch | reachable? | classification | notes |
|----|-------|------------|----------------|-------|
| **G1** | **Tab completion → loopback Ollama FIM.** `fimComplete()` POSTs the cursor window (prefix+suffix, capped 2000/1000) to `127.0.0.1:11434/api/generate` via a raw `fetch`, NOT through the broker; no `model_call` event emitted (`ollamaFimClient.ts:98-111`, `inlineCompletion.ts:612-618`). | YES (opt-in) | **MITIGATED-SOFT** | Loopback-only (no off-machine egress, works air-gapped), OFF by default (`package.json:395-397`; registered only when true `extension.ts:3208-3211`), honestly labeled + one-time "UNGOVERNED local assist" notice (`inlineCompletion.ts:58-95,566-575`). Residual: when on, an ungoverned model call disclosing the code window that never appears in the governed trace. |
| **G2** | **Repo-aware FIM injects cross-file source into the FIM prompt.** Retrieves top-k index chunks (other files' source) and prepends them to the same ungoverned loopback call. | YES (opt-in) | **MITIGATED-SOFT** | Default OFF (`package.json:405-407`); retrieval is the session-root-bound `index/retrieve` (G4) over the handshake-bound completion session (`extension.ts:3690-3732`). Same residual as G1; disclosed window now includes neighboring files (local model only, no egress). |
| **G3** | **Inline edit (Cmd-K) model call.** Sends selection + capped context to a model to rewrite. | YES | **PATCHED (governed)** | Routes through the injected governed gateway — the SAME `openChatSession`→`chat/send` path as chat (`inlineEdit.ts:28-31,218-278`; wired `extension.ts:3127`); `governed-unsandboxed` + metadata-traced, never product-trusted. Stale-buffer fixed: `isEditStillApplicable` re-validates version+URI+text, fails closed (`inlineEdit.ts:199-205,363-392`); applied as an undoable `WorkspaceEdit`. |
| **G4** | **`index/retrieve` returns raw source snippets** for @Codebase grounding. | YES (gated) | **PATCHED (session-bound)** | Two gates before any file read: completed-handshake (`bridge-server.ts:2834-2837`) + canonical session-root binding — requested `workspaceRoot` is `realpath`'d and must equal the handshake-pinned root; cross-root/non-dir/missing is refused unread (`bindSessionRoot` `:2700-2729`; enforce `:2847-2852`). Cannot read an arbitrary directory. Not separately traced (local-by-construction); snippets reach Codex only via the traced `chat/send`. |
| **G5** | **`index/build` reads + persists source-derived vectors.** | YES (gated) | **PATCHED** | Same two gates (`:2944-2957`). Persisted snapshot is **AES-256-GCM encrypted** (`index-crypto.ts:1-44,62`), per-workspace key `0600` OUTSIDE the workspace (`:24-38,114-148`), `persist` OFF by default (`package.json:448-450`). |
| **G6** | **Index embedder egress.** | NO (default) / model-download only | **MITIGATED-SOFT** | Default `OllamaEmbedder` POSTs only to loopback `/api/embed` (`embedder.ts:41,92-97`). In-process `OnnxEmbedder` touches network ONCE to download the model artifact from HF hub (model download, never code egress), cached after; constructor supports `modelPath`/`allowRemoteModels:false` for bundled-pin hardening. No source bytes egress. |
| **G7** | **Embedder-version mismatch poisons retrieval.** | NO | **PATCHED** | Persisted container records `embedderId` (format `GSI2`); `loadIndex` DISCARDS a snapshot whose `embedderId`/`dims` differ (and legacy `GSI1`) rather than serving wrong vectors (`persisted-store.ts:21-42,71-74,275-300`). |
| **G8** | **Chat LM provider as a public proxy** (another extension `selectChatModels({vendor:'glyphspek'})` → `sendRequest`). | NO | **PATCHED (fail-closed)** | `provideLanguageModelChatResponse` THROWS on every direct call (`chatParticipant.ts:1077-1096`); the model exists only to satisfy the host default-model resolver. |
| **G9** | **Chat attachments / @Codebase disclose source.** | NO (governed) | **MITIGATED-SOFT** | Secret-path denylist BEFORE bytes read (`.env`/`*.pem`/`*.key`/`id_rsa*`/`secret`/`.ssh`, `chatParticipant.ts:359-374,648-651`), size caps + max count, truncation markers; disclosure via traced `chat/send`. Residual: not redacted beyond denylist before reaching the user's own Codex (honest, same posture as chat). |
| **G10** | **Remote-control bridge unauthenticated / remote work ungoverned.** | NO | **PATCHED** | `POST /rpc` requires `Bearer <grant>` + `x-glyphspek-device` (`grants.validateGrant`); every mutating method verifies a signed action vs the pairing's TOFU-bound key + nonce replay cache (`rpc-server.ts:14-44`). Remote builds route the SAME authority gate: `build/start {approved:false}` → pending → signed `approval/respond ALLOW` (`real-supervisor-bridge.ts:67-80,147-169`). Governed + traced identically to local. |
| **G11** | **APNs push payload leaks raw failure text.** `run_failed` alert body interpolates the raw `failureMessage` (`state_changed.reason` / build `error.message`) with NO redaction or bound (`push-notifications.ts:251-263`; fed `projection-store.ts:369-380,585-587`). | YES | **PATCHED (2026-06-03, `ece1f39`)** | FIXED: the APNs `run_failed` body is now unconditionally coarse (`Run <id> failed.`); the raw `failureMessage` plumbing was removed at both the notifier (`runFailed(input:{runId})`) and `projection-store` (`setRunStatus` param dropped, both call sites updated), + a regression test asserting no path/secret substring reaches the push body and the body is length-bounded. Detailed/redacted failure text remains only on the authenticated dashboard RPC, bounded 4000 chars (`projection-store.ts:570,600,655`). Was open sweeps 62–71. |
| **G12** | **iOS app client code.** | — | **OUTSIDE-TRUST-SCOPE** | Owned by a separate agent; only the host-side gateway/bridge (G10/G11) audited. |
| **G13** | **`@Web` governed web context.** `@Web <url>` in chat fetches the public web. | YES (opt-in) | **PATCHED (2026-06-05, `50d08f2`) — traced/governed, content-hashed, untrusted-fenced** | The supervisor performs every fetch through its own governed soft-egress proxy (`web/fetch` bridge method; the extension never fetches directly — architectural test). Each reached `host:port` is recorded on the hash-chained trace as a canonical `tool:'network'`, `decision:'allow'`, `enforcement:'observe-only'` event carrying `sha256(content)` (metadata + content hash only — Option B, no raw body, no credential). Connected-IP SSRF validation pins the resolved public IP (DNS-rebinding-safe; octal/overflow normalizer fixed); fetched bytes are instruction-demoted (`provenanceLabel:'web'`, user/data channel, UNTRUSTED fence) and disclosed as sent onward to the model. Default-OFF/opt-in, machine-scoped caps. Soft/observe only — hard egress remains the Firecracker plane. NOT a new gap. |

### New top open gaps

1. **G11 — raw failure text in APNs alert bodies.** ~~The only genuinely OPEN new-surface gap.~~ **RESOLVED 2026-06-03 (`ece1f39`)** — fixed exactly as recommended: the `run_failed` push body is now coarse + bounded ("Run `<id>` failed."), the raw `failureMessage` plumbing was removed end-to-end, and detailed/redacted failure text remains only inside the authenticated dashboard/trace views. With this landed, **no new-surface gap remains open.**
2. **G1/G2 — opt-in local FIM is trace-silent.** Not a leak (loopback, no egress) but, when enabled, a model call disclosing the code window (G2: neighboring files) that never appears in the Model-Calls trace. Keep the honest framing; never let UI imply Tab completion is governed/traced.

### New CIO-level flags

- **CIO-FLAG-G1 (= G11).** A trust product that pushes raw failure text (possible local paths) to Apple push + lock screens undercuts the disclosure-discipline claim. Open since sweep 62 — explicitly accept-with-ship-date or fix before any remote-control GA.
- **CIO-FLAG-G2 (= G6).** The ONNX embedder's first-run HF model download contradicts a "fully air-gapped indexing" claim on a cold machine. Either bundle+hash-pin the model (`allowRemoteModels:false`) before that claim, or scope the claim to "no code egress" (true today).

### What is honestly closed (new surfaces — do not re-flag)

Inline edit (G3) and chat (G8/G9) route through the governed, traced gateway, fail-closed against proxy abuse, and apply a secret denylist + caps before disclosure. Code-index (G4/G5) is session-root-bound behind a handshake and AES-256-GCM encrypted at rest with the key outside the workspace; the embedder-version guard (G7) prevents stale-vector serving. Embedder egress (G6) is loopback/in-process — no code egresses. The remote bridge (G10) is authenticated and remote builds are governed by the same authority gate + signed-verdict trace as local.

### Verdict

The new AI-DX/remote surfaces do **not** materially widen the escape-hatch surface beyond the
per-run envelope — model paths are governed+traced (chat, Cmd-K) or honestly
ungoverned-local-and-opt-in (FIM), the code-index is session-root-bound and encrypted at rest,
and remote work is authenticated and governed by the same authority gate — **with one
genuinely open item: G11, raw failure text leaking into unredacted APNs push bodies, the single
highest-priority fix.**
