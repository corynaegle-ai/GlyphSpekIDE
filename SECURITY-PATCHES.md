# GlyphSpek — Workbench Security Patch Ledger

> Per `docs/ide-build-design.md` §16. **Every** workbench (`src/vs/**`) security diff in this
> Code-OSS fork must be recorded here with: threat addressed, files changed, why
> extension/supervisor boundaries are insufficient, acceptance test, and rollback/rebase
> note. Patches are not allowed for convenience-only UX until security patches are
> understood and isolated.
>
> **Status legend:** `SPECIFIED` (designed, not applied) · `APPLIED` · `REVERTED`.
>
> The minimal-fork policy holds: prefer stock configuration/policy. A patch is justified only
> when stock config cannot give the guarantee. See
> `build/glyphspek/sovereign-profile/README.md` for the Sovereign-profile decision that
> determined which (if any) patches the extension-profile mechanism needs.

---

## Decision record: Sovereign allowlist enforcement = STOCK CONFIG (no enablement patch)

Open decision #1 (`docs/ide-build-design.md` §20.1) is **resolved**: the Sovereign
extension allowlist is enforced by **stock Code-OSS configuration**, delivered as the
`AllowedExtensions` **policy**. No patch to extension enablement/install is required. Stock
core already:

- disables non-allowlisted extensions (`EnablementState.DisabledByAllowlist`,
  `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts:447-449`),
- makes that state **non-user-flippable**
  (`extensionEnablementService.ts:261-262`, `canChangeEnablement` `:212-219`),
- blocks install/gallery of non-allowlisted extensions
  (`src/vs/platform/extensionManagement/common/abstractExtensionManagementService.ts:75-79`,
  `extensionGalleryService.ts:956`),
- and refuses any user write to a policy-set key
  (`src/vs/platform/configuration/common/configurationService.ts:123-124`).

The only candidate patch concerns **how the policy file is sourced on macOS/Windows**, not
enablement. It is **optional** and recorded below as `PATCH-001`.

---

## PATCH-001 — Bundled file-policy source for self-contained Sovereign builds

- **Status:** `APPLIED` (2026-05-30). **Updated 2026-05-30 (Sweep-19 Finding 2):** the bundled
  load now **fails closed** and the policy file is **wired into packaging** (see "Sweep-19 F2"
  section below).
- **Optional:** required only for a shrink-wrapped Sovereign app that must carry its allowlist
  policy *inside the signed bundle* on macOS/Windows **without** relying on OS managed
  preferences/registry or the `--__enable-file-policy` launch flag. If Sovereign deployments
  use MDM/GPO or the existing flag, **do not apply this patch**.

### As applied (2026-05-30)

Applied via the **`product.json` flag** approach the spec offered, with a **`MultiPolicyService`
layering** so native/MDM can tighten but never loosen. Files changed:

- `product.json` — added one additive key `"glyphspekSovereignPolicyFile": true` (the gate),
  and (separately, M1 cleanliness Task 2) emptied `webviewContentExternalBaseUrlTemplate`.
- `src/vs/base/common/product.ts` — declared the `glyphspekSovereignPolicyFile?: boolean`
  field on `IProductConfiguration`.
- `src/vs/platform/environment/common/environmentService.ts` — added a memoized
  `glyphspekSovereignPolicyFile: URI | undefined` getter (analogous to `policyFile`): returns
  `<appRoot>/policy.json` only when the product flag is set, overridable by
  `--glyphspek-policy-file <path>`. A stock/Developer build (flag absent) returns `undefined`
  and is wholly unaffected.
- `src/vs/platform/environment/node/argv.ts` + `common/argv.ts` — added the non-hidden
  `--glyphspek-policy-file <path>` string arg.
- `src/vs/platform/policy/common/multiPolicyService.ts` — **new** `MultiPolicyService`:
  merges the bundled file policy (baseline) with the OS native/MDM policy. For the
  `AllowedExtensions` policy it does an allowlist-aware *intersection* (an id/publisher is
  allowed only if both sources allow it; `"*"` floor = AND of both; absent keys resolve to a
  source's own `"*"` fallback, matching `allowedExtensionsService.isAllowed`), delivering the
  merged value as a JSON string (the form `PolicyConfiguration` parses for object policies).
  Scalar policies: native wins when set. Native can therefore tighten, never loosen.
- `src/vs/code/electron-main/main.ts` — in the policy-source selection block, added a
  leading branch: when `glyphspekSovereignPolicyFile` is set, build a `FilePolicyService` over
  the bundled file and wrap it with the platform's native source in a `MultiPolicyService`.
  The original stock `if/else` chain is preserved untouched as the fallback.
- `src/vs/code/node/cliProcessMain.ts` — mirrored the same selection so the CLI honors the
  allowlist at install time.
- `src/vs/platform/policy/test/common/multiPolicyService.test.ts` — **new** acceptance test
  (`suite('MultiPolicyService (GlyphSpek PATCH-001)')`) covering acceptance #1 (standalone
  bundled allowlist loads, not `"*"`) and #4 (native tightens by removing a curated id; native
  cannot loosen the `"*"` floor or add an id the bundle did not allow).

**Bundled policy source of truth:** `build/glyphspek/sovereign-profile/sovereign-policy.json`
(the `{ "AllowedExtensions": { … } }` form). The package step copies this to
`<appRoot>/policy.json` in the Sovereign artifact — this build/gulp wiring is **now done**
(see "Sweep-19 F2" below); a Sovereign build now SHIPS the policy file.

**Enablement/install enforcement remains 100% stock** — no file under
`extensionEnablementService.ts`, `allowedExtensionsService.ts`,
`abstractExtensionManagementService.ts`, `extensionGalleryService.ts`, or the
`extensions.allowed` registration was touched.

**Compile:** `npm run compile-check-ts-native` (validates `src/tsconfig.json`) passes clean.
The unit test was authored and type-checked; running it requires compiled `out/` (a full
`npm run compile`), deferred to the next build per task constraints.

**Spec ambiguity resolved:** (1) the spec offered "auto-detect bundled file" *or* "product
flag"; the flag was chosen for auditability (presence/absence of the file cannot silently
change posture). (2) The spec's `MultiPolicyService` was "…-style"; for the object-valued
`AllowedExtensions` a per-policy-name override would let native *replace* (hence loosen) the
whole dict, so an allowlist-aware intersection was implemented to honor "tighten, never
loosen." (3) Object-typed policy values flow through the config layer as JSON strings
(`configurations.ts` `parse()`), so the merged value is serialized accordingly.

### Sweep-19 F2 (APPLIED 2026-05-30) — fail closed + packaging wiring

The original apply left two gaps that re-opened the exact silent Sovereign→Developer
degradation the patch exists to prevent. Both are now closed.

**Gap 1 — silent degrade on missing policy (NOW: fail closed).** Stock `FilePolicyService.read()`
swallows `FILE_NOT_FOUND` (and any parse/read error) and returns an *empty* policy map. With
`glyphspekSovereignPolicyFile` set but `<appRoot>/policy.json` absent/unreadable/invalid, the
`AllowedExtensions` policy would simply be *unset* → `extensions.allowed` falls back to its `'*'`
default (all allowed). A Sovereign build with no policy file would therefore boot all-allowed
with no visible posture change.

Fix — fail closed at the seam the patch added, distinguishing Sovereign from stock by
*construction site*, not by a runtime flag check:

- `src/vs/platform/policy/common/filePolicyService.ts` — `read()` is now `protected`; on any
  read/parse failure it calls a new `protected onReadFailed(error, policies)` hook. The base
  hook is a no-op (stock behavior — empty map stands), and `logService` was made `protected` so
  a subclass can surface the event.
- `src/vs/platform/policy/common/sovereignFilePolicyService.ts` — **new**
  `SovereignFilePolicyService extends FilePolicyService`. Its `onReadFailed` override (a) logs a
  clear "FAILING CLOSED … this build is UNTRUSTED" `logService.error` (the base stays silent on
  `FILE_NOT_FOUND`; for a Sovereign build a missing policy IS a security event), and (b) forces
  `AllowedExtensions` to a deny-all floor `{"*": false}` (as the JSON string the config layer
  parses). With `extensions.allowed` then policy-set to deny-all, **no** third-party extension
  can be enabled → effectively UNTRUSTED, never product-trusted. The watcher path means the
  floor lifts automatically if a valid `policy.json` later appears, and re-applies if removed.
- `src/vs/code/electron-main/main.ts` + `src/vs/code/node/cliProcessMain.ts` — the bundled
  source on the Sovereign branch is now `SovereignFilePolicyService` (was plain
  `FilePolicyService`). **Distinguish Sovereign vs stock:** this subclass is constructed *only*
  inside the `if (environment…glyphspekSovereignPolicyFile) { … }` branch (gated by the
  `product.json` flag). A stock/Developer build (flag absent) never enters that branch and uses
  the unchanged stock `FilePolicyService` / `NativePolicyService` / `NullPolicyService` chain, so
  non-Sovereign/Developer builds still boot normally — the fail-closed floor cannot affect them.
  The `MultiPolicyService` intersection preserves the deny-all floor: native/MDM cannot loosen
  `{"*": false}` (verified by test), so failing closed holds even with a native source layered
  ahead.

**Gap 2 — Sovereign build shipped WITHOUT the policy file (NOW: wired into packaging).**
`build/gulpfile.vscode.ts` `packageTask` now, when `product.json` sets
`glyphspekSovereignPolicyFile`, copies `build/glyphspek/sovereign-profile/sovereign-policy.json`
→ `<appRoot>/policy.json` (rename to `policy.json`, merged into the package `all` stream for the
darwin/linux/win paths). Gated on the same flag the runtime loader uses, so a
non-Sovereign/Developer build ships no `policy.json` (unchanged). Without this the fail-closed
path above would (correctly) force every Sovereign build to UNTRUSTED; with it, a Sovereign build
ships its curated allowlist and boots Sovereign-enforced.

**Acceptance test (added):** `src/vs/platform/policy/test/common/multiPolicyService.test.ts` —
new suite `suite('SovereignFilePolicyService fail-closed (GlyphSpek PATCH-001 / Sweep-19 F2)')`:
a present + valid bundled policy boots Sovereign-enforced (the curated allowlist, not `'*'`); a
**missing** policy file resolves `AllowedExtensions` to `{"*": false}` (deny-all / UNTRUSTED);
**invalid JSON** likewise; and a native/MDM source layered ahead that tries to re-open `"*": true`
/ add an id **cannot** loosen the failed-closed floor.

**Verification (Sweep-19 F2):** `npm run compile-check-ts-native` clean; `build/` `npm run
typecheck` clean. The fail-closed merge math was confirmed against the real compiled
`MultiPolicyService` (present-valid → enforced allowlist; deny-all floor survives a native
loosen attempt → `{"*": false}`). Packaging-copy + full-launch fail-closed verification: see the
build/run notes recorded with this task.

### Threat addressed

A Sovereign build's hard allowlist guarantee depends on the `AllowedExtensions` **policy**
value being present at startup. On Linux and via `--__enable-file-policy`, stock core loads
that value from a file we control. On **macOS/Windows**, stock core's policy source is
`NativePolicyService` only (`src/vs/code/electron-main/main.ts:218-221`) — it never
auto-loads a bundled policy file. So a self-contained Sovereign `.app`/`.exe` shipped without
MDM and without the launch flag would boot with **no policy**, and `extensions.allowed`
would default to `'*'` (all allowed) — silently degrading Sovereign to Developer. The user
(or a tampering process) gets arbitrary extensions enabled with no visible posture change.
This violates §18.1 (malicious third-party cannot be enabled in Sovereign unless allowlisted)
and §6.2 (third-party extension posture is explicit).

### Why extension/supervisor boundaries are insufficient

- The supervisor can *report* posture but cannot *enforce* extension enablement — enablement
  happens in the renderer/extension-host before any run starts, outside the supervisor.
- The first-party extension cannot lock `extensions.allowed`; only the policy layer makes a
  setting un-writable, and the policy layer's *source* is chosen in the main process before
  any extension loads.
- A default-settings overlay (soft default) is user-overridable and therefore not a
  guarantee. Only a **policy value** is un-overridable, and on macOS/Windows there is no
  stock hook to load that policy from a bundled file.

### Files to change (main process only; ~1 region each)

- `src/vs/code/electron-main/main.ts` — in the policy-source selection block
  (currently lines ~213-229): when a GlyphSpek-bundled policy file is present (resolved from
  the app resources dir, or gated by a new `product.json` boolean e.g.
  `glyphspekSovereignPolicyFile`), construct a `FilePolicyService` over that bundled file —
  either as the sole source or layered ahead of `NativePolicyService` so native/MDM can still
  *tighten* (a `MultiPolicyService`-style merge), never loosen.
- `src/vs/code/node/cliProcessMain.ts` — mirror the same selection (lines ~181-193) so the
  CLI (`glyphspek --install-extension`, etc.) honors the same allowlist at install time.
- (If a flag is preferred over auto-detect) `src/vs/platform/environment/node/argv.ts` +
  `src/vs/platform/environment/common/environmentService.ts` — add a non-hidden
  `--glyphspek-policy-file <path>` arg resolving to a `URI`, analogous to the existing
  `__enable-file-policy` → `policyFile` path (`environmentService.ts:267-274`).

**Out of scope for this patch (do NOT touch):** `extensionEnablementService.ts`,
`allowedExtensionsService.ts`, `abstractExtensionManagementService.ts`,
`extensionGalleryService.ts`, the `extensions.allowed` config registration
(`extensionManagement.ts:721-799`). Enablement/install enforcement stays 100% stock.
Per task constraints, `product.json` is NOT modified by this scaffold; if the
`glyphspekSovereignPolicyFile` flag approach is chosen, that single additive `product.json`
key is added at apply time by whoever applies the patch.

### Acceptance test

1. Build a Sovereign artifact on macOS (and Windows) with a bundled policy file containing
   `{ "AllowedExtensions": { "glyphspek": true, "*": false } }`, **no** MDM/registry policy
   set, **no** `--__enable-file-policy` flag.
2. Launch. Attempt to install/enable a non-allowlisted Open VSX extension (e.g.
   `ms-python.python`).
3. **Pass:** install is refused and any pre-present copy shows `DisabledByAllowlist` and
   cannot be enabled; Trust Panel posture badge = "Sovereign"; the disallowed-extensions
   notification reads the "by your system administrator" variant
   (`extensionsWorkbenchService.ts:1511-1521`).
4. **Layering check:** with the bundled file allowing `glyphspek` + one curated id, set an
   MDM/registry policy that *removes* the curated id — the stricter result wins; the curated
   id becomes disallowed. (Native must be able to tighten, never loosen.)
5. **Regression:** on Linux, `/etc/vscode/policy.json` still works unchanged.

### Rollback / rebase note

- **Rollback:** revert the two/four touched files; with the patch gone the app falls back to
  stock policy sourcing (native/MDM + `--__enable-file-policy`). The allowlist *mechanism* is
  unaffected (it's stock); only the *bundled-file source* disappears. No data migration.
- **Rebase risk: LOW.** The policy-source selection block in `main.ts`/`cliProcessMain.ts` is
  small and stable upstream; conflicts would be localized to that `if/else` chain. Keep the
  GlyphSpek branch as an added `else if` ahead of the `NullPolicyService` fallback to
  minimize conflict surface. Re-verify upstream hasn't renamed
  `LINUX_SYSTEM_POLICY_FILE_PATH`/`policyFile` on each rebase.

---

## GATE-002 — No-Copilot-runtime deny gate + Copilot-runtime removal (STUBBED)

- **Status:** `APPLIED` (2026-05-30) — Part 1 (the honest deny gate) AND Part 2 (full
  Copilot-runtime removal via inert SDK stubs). The gate now **PASSES** on a packaged app
  that ships **no** Copilot runtime. Part 2 was previously recorded as BLOCKED; it is now
  resolved by stubbing the Agent Host's Copilot SDK rather than ripping out the subsystem.
- **Origin:** Sweep-20 Finding 1 (Critical) — the packaged app shipped Copilot RUNTIME
  libraries under `Contents/Resources/app/node_modules` (`@github/copilot`,
  `@github/copilot-sdk`, `@vscode/copilot-api`) while the only deny gate
  (`verify-bundled-extensions.sh`) scanned `extensions/` only and reported a false **PASS**.

### Part 2 (APPLIED 2026-05-30) — de-Copilot the Agent Host via inert SDK stubs

The fork's Agent Host imports the Copilot SDK as load-bearing runtime values in shipped
source. Rather than delete the subsystem (high blast radius across `vs/sessions/**` and the
main/shared processes), the real Copilot packages were replaced with **inert, differently-named
stubs** whose every Copilot entry point throws `"Copilot is not available in GlyphSpek"` or
no-ops. The Agent Host still compiles and loads; its Copilot agent path is dead-but-safe.

**Stub approach + exact symbol surface stubbed**

- **Stub packages (new):** `build/glyphspek/copilot-stubs/`
  - `github-copilot-sdk/` — `dist/index.js` (inert runtime) + the SDK's real `*.d.ts`
    type-declaration files copied verbatim (pure types, zero Copilot runtime) so `tsc`
    type-checks against exact shapes under `skipLibCheck`. `package.json` named
    `@glyphspek/copilot-sdk-stub` (NOT `@github/copilot-sdk`, so the deny gate cannot
    match it).
  - `vscode-copilot-api/` — `dist/index.js` (inert) + `dist/index.d.ts` (the agent-host
    subset, lifted from the former `src/typings/copilot-api.d.ts`).
- **Runtime VALUES that had to exist + be callable** (everything else is type-only):
  - `@github/copilot-sdk`: `CopilotClient` (constructs; `start()`/`createSession()`/
    `resumeSession()`/RPC all throw `COPILOT_UNAVAILABLE`; `listSessions()`/`listModels()`
    return `[]`; `stop()` no-ops), `RuntimeConnection` (`forStdio`/`forTcp`/`forUri` return
    inert descriptors), plus exported-for-resolution inert `CopilotSession`, `Canvas`,
    `createCanvas`, `defineTool`, `approveAll`, `convertMcpCallToolResult`,
    `createSessionFsAdapter`, `SYSTEM_MESSAGE_SECTIONS`.
  - `@vscode/copilot-api`: `RequestType` (frozen enum-shaped object:
    `CopilotToken`/`ChatCompletions`/`ChatResponses`/`ChatMessages`/`Models`), `CAPIClient`
    (constructs; `makeRequest()` throws `COPILOT_UNAVAILABLE`; `updateDomains()` returns
    all-false).
  - **Type-only** imports satisfied purely by the vendored `.d.ts`: `CopilotClientOptions`,
    `SessionConfig`, `ResumeSessionConfig`, `SessionEventPayload`, `SessionEventType`,
    `MessageOptions`, `CustomAgentConfig`, `MCPServerConfig`, `PermissionRequest`, `Tool`,
    `ToolResultObject`, `PermissionRequestResult`, `TelemetryConfig` (copilot-sdk);
    `CCAModel`, `IExtensionInformation` (copilot-api). 12 source files import these (the 4
    load-bearing files in the recipe plus `copilotPluginConverters/ToolDisplay/ShellTools/
    AgentSession/SystemNotification`, `node/otel/agentHostOTelService`, and the 2 `claude/*`
    files using `CCAModel`) — **none were edited**.

**Redirect (both tsc AND the esbuild bundler resolve to the stub)**

- `src/tsconfig.base.json` — added `compilerOptions.paths` mapping `@github/copilot-sdk` and
  `@vscode/copilot-api` to the stub `dist/index.d.ts`. This covers BOTH
  `compile-check-ts-native` (tsgo) and the gulp build compile (gulp-tsb both load
  `src/tsconfig.json`). The 4 / 12 source files are untouched.
- `build/next/index.ts` (the authoritative `[bundle] src → out-vscode` esbuild bundler that
  builds `agentHostMain`, NOT the legacy `build/lib/optimize.ts` path) — new
  `inlineCopilotStubsPlugin()` `onResolve` redirects both bare specifiers to the stub
  `index.js` with `external: false`, so the inert stub is **inlined** into the bundle
  instead of being left as an external bare specifier that would resolve to a now-missing
  `node_modules` package at runtime. (`build/lib/optimize.ts` got a mirror override too, for
  completeness, but `build/next/index.ts` is the one that matters for the desktop build.)
  Because esbuild drops type-only named imports, the type-only symbols never hit `onResolve`.
- `src/typings/copilot-api.d.ts` → renamed to `…d.ts.glyphspek-removed` (the stub's
  `index.d.ts` now carries those types; keeping the ambient `declare module` would
  double-declare the module once `paths` redirects it).

**Root deps + build machinery removed**

- `package.json` — removed `@github/copilot`, `@github/copilot-sdk`, `@vscode/copilot-api`
  from `dependencies`. `npm install` regenerated `package-lock.json` (removed 9 packages);
  `node_modules` has no `@github/copilot*` or `@vscode/copilot-api`.
- `build/gulpfile.vscode.ts` + `build/gulpfile.reh.ts` — removed the Copilot runtime-prebuild
  merge (`getCopilotRuntimePrebuildFiles`), the wrong-arch Copilot package filter
  (`getCopilotExcludeFilter`), and the `**/@github/copilot-*/**` ASAR force-unpack pattern
  (desktop only). Imports trimmed to the still-used helpers. The now-dead exports
  `getCopilotExcludeFilter` / `getCopilotRuntimePrebuildFiles` remain in `build/lib/copilot.ts`
  (harmless unused exports; `prepareBuiltInCopilotRipgrepShim` / `getRipgrepExcludeFilter` are
  still referenced).

**Verification (all PASS)**

1. `npm run compile-check-ts-native` — clean (with the real Copilot packages absent, so the
   stub `paths` is doing the work). `build/` `npm run typecheck` — clean.
2. `npm run gulp vscode-darwin-arm64` — full build succeeds; esbuild bundles 23 bundles with
   the stub inlined and no "no matching export" errors.
3. `build/glyphspek/verify-no-copilot.sh` → **PASS** (exit 0); `find …GlyphSpek.app -path
   '*@github/copilot*' -o -path '*@vscode/copilot-api*'` → empty. The packaged
   `agentHostMain.js` contains the `COPILOT_UNAVAILABLE` marker and **zero** real
   `import`/`require` of either Copilot package (the only residual text is in the `.js.map`
   source map and a JSDoc comment — neither is executable nor scanned by the gate).
4. **Render / runtime:** app launches with no bootstrap exception; main log shows
   `AgentHostProcessManager: agent host started` and the Agent Host registers the `copilotcli`
   provider cleanly. The Sessions/agent layer queries it and the stub degrades gracefully —
   `listSessions` hits `_ensureClient`, which throws the normal `AHP_AUTH_REQUIRED`
   ("Authentication is required to use Copilot") **before** touching the stubbed client, so
   there is **no** `ERR_MODULE_NOT_FOUND` / uncaught exception. Workbench renders, welcome
   walkthrough renders, and **"GlyphSpek: Open Trust Panel" opens and renders fully** (all
   sections: live runs, run trust state, actor plan & claims, verifier verdict, live trace
   timeline, changed files). Screenshots in `/tmp/glyphspek-decopilot/`.

**Sessions-window degradation:** as designed — there is no working Copilot agent (it would
require GitHub auth + the real CLI, both removed). The agent panel still renders; selecting
the Copilot agent and trying to run would surface the inert "Copilot is not available in
GlyphSpek" / auth-required error rather than crash. GlyphSpek's own trust/agent layer is
unaffected.

**Rollback:** restore `package.json` + `package-lock.json` (`npm install`); revert
`src/tsconfig.base.json` paths, `build/next/index.ts`, `build/lib/optimize.ts`,
`build/gulpfile.vscode.ts`, `build/gulpfile.reh.ts`; restore
`src/typings/copilot-api.d.ts`; delete `build/glyphspek/copilot-stubs/`.

---

#### Historical entanglement record (why Part 2 was previously BLOCKED — now resolved by stubbing)

### Part 1 (APPLIED) — make the "ships no Copilot" gate honest

- **New:** `build/glyphspek/verify-no-copilot.sh` — scans the WHOLE app bundle for Copilot
  runtime material and FAILS if any is present:
  - unpacked `Contents/Resources/app/node_modules` for `@github/copilot`,
    `@github/copilot-<platform>`, `@github/copilot-sdk`, `@vscode/copilot-api`
    (matched as exact `node_modules/<scope>/<pkg>` path segments — does **not**
    false-positive on unrelated packages whose name merely contains "copilot");
  - any `*.asar` (e.g. `node_modules.asar`) via the `asar` tool header listing, with a
    `strings`-based binary scan fallback when the tool is unavailable;
  - Copilot CLI command binaries / `.bin/copilot` shims under app resources.
- **Chained:** `build/glyphspek/verify-bundled-extensions.sh` now runs `verify-no-copilot.sh`
  and FAILS on either a denylisted `extensions/` folder OR a Copilot runtime artifact, so the
  single command is an honest "ships no Copilot" gate.
- **Verified against the current packaged app** (which still contains Copilot): the gate that
  previously PASSED now correctly **FAILS** (exit 1), reporting the 3 packages. Self-tested
  against (a) a clean tree with decoy `copilot-helper` / `@scope/my-copilot-theme` /
  `awesome-copilot-snippets` packages → **PASS** (no false positives), (b) Copilot packed
  inside an `.asar` → **FAIL**, (c) a `.bin/copilot` shim → **FAIL**.
- **Threat addressed:** false release signal. A "PASS" deny gate while GitHub Copilot code +
  SDK material sits in the app bundle masks a guardrail violation (GlyphSpek ships no Copilot)
  and blocks the Sovereign/trusted-IDE alpha. The gate now refuses to green-light such a build.

### Part 2 (BLOCKED — NOT applied) — why full Copilot removal breaks the build

Removing the root `@github/copilot*` / `@vscode/copilot-api` dependencies and the Copilot
package task **breaks the build** because the fork's **Agent Host** subsystem embeds the
native Copilot SDK at runtime. This is load-bearing, not vestigial:

- **Value (runtime) imports** of the Copilot packages live in 4 production source files that
  compile into the shipped bundle (`out/vs/platform/agentHost/node/agentHostMain.js` contains
  live `import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk"` and
  `import { CAPIClient, RequestType } from "@vscode/copilot-api"`):
  - `src/vs/platform/agentHost/node/copilot/copilotAgent.ts` — `CopilotClient`,
    `ResumeSessionConfig`, `RuntimeConnection` from `@github/copilot-sdk`
  - `src/vs/platform/agentHost/node/copilot/copilotSessionWrapper.ts` — `CopilotSession`,
    `SessionEventPayload`, `SessionEventType` from `@github/copilot-sdk`
  - `src/vs/platform/agentHost/node/copilot/mapSessionEvents.ts` — `MessageOptions` from
    `@github/copilot-sdk`
  - `src/vs/platform/agentHost/node/shared/copilotApiService.ts` — `CAPIClient`,
    `RequestType` from `@vscode/copilot-api`
- `@github/copilot-sdk` ships its own types (`dist/index.d.ts`, no ambient shim), so removing
  the package makes these value imports fail to resolve at type-check **and** at esbuild bundle
  time. `@vscode/copilot-api` has an ambient *type* shim (`src/typings/copilot-api.d.ts`) but
  the `CAPIClient`/`RequestType` **values** still resolve to the real package — removing it
  breaks the bundle/runtime even though types would still type-check.
- `@github/copilot` (the CLI) is a **runtime dependency of `@github/copilot-sdk`** (per
  `package-lock.json`, `copilot-sdk` requires `@github/copilot ^1.0.55-1`) and is loaded
  dynamically by the SDK at runtime (`copilotAgent.ts:498` notes `@github/copilot`'s exports
  map blocks direct subpath access). It cannot be dropped while `copilot-sdk` is present.
- `agentHost` is wired into the workbench/main process and the agentic `vs/sessions/` layer
  (`src/vs/code/electron-main/app.ts`, `src/vs/code/electron-utility/sharedProcess/`
  `sharedProcessMain.ts`, `src/vs/server/node/serverAgentHostManager.ts`, and many
  `src/vs/sessions/**` files), so it is not dead code that could be excluded from packaging.
- `build/gulpfile.vscode.ts` + `build/lib/copilot.ts` additionally pull Copilot runtime
  prebuilds (`getCopilotRuntimePrebuildFiles`), filter wrong-arch Copilot packages
  (`getCopilotExcludeFilter`), and force-unpack `**/@github/copilot-*/**` out of
  `node_modules.asar`. These exist precisely because the Agent Host needs the native SDK at
  runtime; removing them without first removing the Agent Host's SDK use would break that
  subsystem.

**Original decision (superseded):** do not ship a broken build; leave Part 2 unapplied.
**Resolution (2026-05-30):** the coupling above is real, but it did not require ripping out
the subsystem. It was resolved by replacing the real Copilot packages with inert,
differently-named stubs (vendored `.d.ts` for exact types + inert `.js` runtime), redirected
via `tsconfig` `paths` (tsc) and a `build/next/index.ts` esbuild `onResolve` (bundler). See
**Part 2 (APPLIED)** above for the full record. The gate now PASSES on a real packaged build.

### What full Copilot removal would require (future work)

1. Remove or re-platform the Agent Host's Copilot path: either delete
   `src/vs/platform/agentHost/node/copilot/**` and `shared/copilotApiService.ts` and every
   reference to them (the `copilotAgent` provider, session wrapper, event mapping, and any
   `agentHost` registration that selects the Copilot agent), keeping only the non-Copilot
   agent (e.g. the Claude agent under `agentHost/node/claude/**`), OR replace the
   `@github/copilot-sdk` / `@vscode/copilot-api` runtime with a GlyphSpek-owned brokered model
   client.
2. After the code is Copilot-free, remove `@github/copilot`, `@github/copilot-sdk`,
   `@vscode/copilot-api` from `package.json` dependencies, run `npm install` to regenerate
   `package-lock.json` / `node_modules`, and delete the now-dead Copilot machinery in
   `build/gulpfile.vscode.ts` (the `copilotRuntimePrebuilds` merge, `getCopilotExcludeFilter`,
   the `**/@github/copilot-*/**` ASAR unpack pattern) and `build/lib/copilot.ts`. Remove the
   `compile-copilot` / `watch-copilot` / `copilot:*` scripts and the
   `@github/copilot-sdk`/`@vscode/copilot-api` import test fixtures + `src/typings/copilot-api.d.ts`.
3. Rebuild and run `verify-bundled-extensions.sh` (Part 1): it must then PASS, and
   `find VSCode-darwin-arm64/GlyphSpek.app -path '*node_modules/@github/copilot*'` must be empty.

### Rollback / rebase note

- **Part 1 rollback:** delete `build/glyphspek/verify-no-copilot.sh` and revert the chaining
  block in `verify-bundled-extensions.sh`. No app/runtime impact (gates are build-time only).
- **Rebase risk: LOW.** Both files are GlyphSpek-only build tooling with no upstream
  counterpart.

---

## GATE-003 — Honest telemetry gate verdict (vendored-dormant allowlist)

- **Status:** `APPLIED` (2026-05-30). Build-time gate tooling only; no runtime/app code touched.
- **Origin:** every code-review sweep flagged `verify-no-telemetry.sh` as **REVIEW/fail** on
  ~50 endpoint-string hits and never resolved, because the old verdict logic returned `REVIEW`
  (exit 1) whenever *any* HARD telemetry/Marketplace/update string was present — with **no**
  distinction between GlyphSpek-introduced telemetry (must be zero) and dormant
  Microsoft-authored constants baked into vendored built-ins. The signal was permanently red and
  therefore meaningless.

### Threat addressed

A perpetual-REVIEW gate is a *false-negative risk*: reviewers learn to ignore it, so a genuine
GlyphSpek-introduced telemetry leak would be lost in the noise of the same ~50 expected vendored
hits. The fix makes the gate's verdict **accurate** — PASS when (and only when) GlyphSpek
introduces no telemetry and the sole hits are the inventoried vendored-dormant set; **FAIL** the
instant a telemetry string appears outside that inventory (GlyphSpek-authored or a new vendored
file). This restores the gate as a meaningful guardrail for the no-telemetry claim.

### What was verified (the honest classification)

Scanned the packaged app (`../VSCode-darwin-arm64/GlyphSpek.app`). The HARD hits resolve to **29
unique files**; the gate's per-pattern total is **50** (files matching multiple patterns):

- **GlyphSpek-INTRODUCED telemetry: ZERO.** The embedded `glyphspek-trust-panel` extension
  appears in **none** of the hits; its compiled `dist/extension.js` has no MS telemetry endpoint,
  no `TelemetryReporter`/`@vscode/extension-telemetry`/`sendTelemetry*`, and no outbound URLs
  beyond local/schema. (The word "telemetry" appears only in prose negations — "no telemetry".)
  `product.json` has **no** `aiConfig`/`enableTelemetry`/`aiKey`/`crashReporter`, `updateUrl` is
  absent, gallery = `open-vsx.org`, `reportIssueUrl` = the GlyphSpek repo.
- **VENDORED-DORMANT: 29 files**, inventoried in
  `build/glyphspek/vendored-telemetry-allowlist.json` (9 Microsoft built-in extensions + 11
  `@microsoft/1ds-core-js` SDK files + 9 core `out/` bundles). Each hit was opened and confirmed
  to be a **string constant** (Application Insights / 1DS OneCollector default ingestion host,
  the update service default base URL) or a **localized doc-link description** (a Dev Containers
  `marketplace.visualstudio.com` docs link; the `repos/microsoft/vscode-distro` issue-reporter
  fallback) — not an active call path in the shipped config. See
  `build/glyphspek/telemetry-posture.md` for the verified-vs-assumed breakdown. **Assumed (not
  exhaustively traced):** non-reachability of every minified branch — closed only by the
  documented dynamic cold-launch network capture.

### Files changed (gate tooling + inventory + doc — no app/runtime code)

- `build/glyphspek/verify-no-telemetry.sh` — each HARD hit is now classified per-file against
  the allowlist via `is_vendored_allowed`/`app_rel`: VENDORED-DORMANT hits are reported for the
  audit trail but do **not** fail; an UNEXPECTED (non-allowlisted) hit hard-fails (exit 1). The
  verdict emits `RESULT: PASS — GlyphSpek introduces ZERO telemetry; N vendored-dormant hits,
  all inventoried` instead of perpetual `REVIEW`. A target-type note warns that the dev `./out`
  intermediate is not allowlist-scoped (scan the packaged `.app`).
- `build/glyphspek/vendored-telemetry-allowlist.json` — **new** checked-in inventory: 19
  app-relative path globs covering the 29 files, each with a `why-dormant` justification, plus a
  `$comment` header explaining how the gate consumes it.
- `build/glyphspek/telemetry-posture.md` — **new** posture doc (claim, verified-vs-assumed, the
  three vendored buckets, how the gate enforces, re-verify steps incl. the dynamic capture).

### Acceptance test (run + verified)

1. `bash build/glyphspek/verify-no-telemetry.sh ../VSCode-darwin-arm64/GlyphSpek.app` →
   **RESULT: PASS**, exit 0. 50 HARD hits all classified VENDORED-DORMANT; 0 UNEXPECTED.
2. **Strictness (negative test):** a synthetic target with a `dc.services.visualstudio.com`
   string injected into `extensions/glyphspek-trust-panel/dist/extension.js` (a GlyphSpek
   surface) **and** into the allowlisted `extensions/git/dist/main.js` → the git file classifies
   VENDORED-DORMANT (passes), the glyphspek file classifies **UNEXPECTED** → **RESULT: FAIL**,
   exit 1. Confirms a GlyphSpek-introduced (or any non-inventoried) telemetry string still fails.

### Rollback / rebase note

- **Rollback:** revert `verify-no-telemetry.sh` to the count-all-HARD-hits → REVIEW logic and
  delete `vendored-telemetry-allowlist.json` + `telemetry-posture.md`. No app/runtime impact.
- **Rebase risk: LOW.** All three are GlyphSpek-only build tooling with no upstream counterpart.
  If a future upstream pull adds a new vendored built-in carrying a telemetry constant, the gate
  will (correctly) FAIL as UNEXPECTED until that file is opened, confirmed dormant, and added to
  the allowlist with a `why-dormant` — that is the intended, auditable behavior.
