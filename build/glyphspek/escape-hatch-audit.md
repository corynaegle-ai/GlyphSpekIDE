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
