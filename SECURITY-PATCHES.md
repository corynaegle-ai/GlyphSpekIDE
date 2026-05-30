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

- **Status:** `SPECIFIED` (NOT APPLIED).
- **Optional:** required only for a shrink-wrapped Sovereign app that must carry its allowlist
  policy *inside the signed bundle* on macOS/Windows **without** relying on OS managed
  preferences/registry or the `--__enable-file-policy` launch flag. If Sovereign deployments
  use MDM/GPO or the existing flag, **do not apply this patch**.

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
