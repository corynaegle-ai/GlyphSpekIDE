# GlyphStudio — Sovereign vs Developer Extension Profile

> **Scope:** M1 / Core invariant #2 ("Third-party extension posture is explicit") from
> `docs/ide-build-design.md` §5.2, §6.2, §16, §18.
> **Resolves:** Open decision #1 (`docs/ide-build-design.md` §20.1) — *can stock Code-OSS
> configuration enforce a Sovereign allowlist, or is a fork patch required?*
> **Status:** Architecture decided. Scaffold is config/overlay only; nothing is wired into
> the build yet (see "What is NOT wired" at the end). No workbench source is modified by
> this scaffold.

---

## TL;DR decision

**Stock Code-OSS configuration is sufficient to *hard*-enforce a Sovereign extension
allowlist. No workbench fork patch is required for the enablement guarantee.**

Code-OSS already ships a complete, layered allowlist that GlyphStudio can drive entirely from
configuration:

- the `extensions.allowed` setting,
- delivered as a **system policy** (not a user setting) so the user cannot override it,
- enforced at **install time, gallery-query time, and enablement time**, with the disabled
  state (`DisabledByAllowlist`) made **non-user-flippable** in core.

The only fork change we may want is **narrow and optional**: make the main-process policy
loader prefer a GlyphStudio-bundled `policy.json` on macOS/Windows so the Sovereign policy
ships *with the app* instead of requiring an OS managed-preferences/registry deployment.
That is a 1-region convenience/robustness patch on the policy *source selection*, **not** a
patch to extension enablement, and it is specified (but not applied) in
`../../../SECURITY-PATCHES.md` as `PATCH-001`. If we accept "Sovereign policy is delivered
via OS managed prefs / `/etc/vscode/policy.json` / the existing `--__enable-file-policy`
flag," then **zero** fork patches are needed.

This satisfies §18 acceptance test #1 ("a malicious third-party extension cannot be enabled
in Sovereign mode unless allowlisted") with stock core behavior.

---

## Why stock config is enough — the exact mechanism (cited)

All paths key off one setting, `extensions.allowed`, resolved through one service,
`IAllowedExtensionsService.isAllowed()`.

### 1. The setting and its enforcement service

- **Config key constant:** `extensions.allowed`
  — `src/vs/platform/extensionManagement/common/extensionManagement.ts:717`
  (`export const AllowedExtensionsConfigKey = 'extensions.allowed';`).
- **Value shape:** `IStringDictionary<boolean | string | string[]>` — keys are
  `publisher.name`, bare `publisher`, or `*`; values are `true`/`false`/`"stable"` or an
  array of allowed versions (`extensionManagement.ts:685`).
- **Enforcement service:** `AllowedExtensionsService.isAllowed()`
  — `src/vs/platform/extensionManagement/common/allowedExtensionsService.ts:67-143`.
  Returns `true` or an `IMarkdownString` reason.
  - **Critical default:** if the config is unset or is exactly `{ "*": true }`, the service
    treats the allowed value as `undefined` and `isAllowed()` returns `true` for everything
    (`allowedExtensionsService.ts:55-65, 68-70`). **So the allowlist is opt-in: Sovereign
    mode must explicitly set this key.**
  - `publisherOrgs` comes from `product.json` `extensionPublisherOrgs`
    (`allowedExtensionsService.ts:45`) — lets a publisher *display name* (e.g. our verified
    org) act as an allow key.

### 2. Three enforcement points, all keyed on `isAllowed()`

| Boundary | Source | Effect when `isAllowed() !== true` |
|---|---|---|
| **Enablement** (load into ext host) | `src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts:447-449` | State set to `EnablementState.DisabledByAllowlist`; extension is **not activated**. |
| **User cannot re-enable** | `extensionEnablementService.ts:261-262` (`throwErrorIfEnablementStateCannotBeChanged`) + `canChangeEnablement()` at `:212-219` | "Cannot change enablement … because it is disallowed." The Enable button is unavailable. Same hard-block class as `DisabledByMalicious`. |
| **Install** | `src/vs/platform/extensionManagement/common/abstractExtensionManagementService.ts:75-79` (`canInstall`) | Install refused: "This extension cannot be installed because …". |
| **Gallery query / fetch** | `src/vs/platform/extensionManagement/common/extensionGalleryService.ts:956` | Disallowed gallery items are filtered/blocked. |
| **UI affordances** | `src/vs/workbench/contrib/extensions/browser/extensionsActions.ts:1087,1296-1297,1544-1552,2887` | Install/enable actions hidden or disabled; context keys `isExtensionAllowed` drive menu visibility. |

A user who already has a non-allowlisted extension installed will see it transition to
`DisabledByAllowlist` on next resolve, with a notification — and cannot turn it back on.

### 3. Making it un-overridable: deliver as **policy**, not a user setting

`extensions.allowed` is registered with **both** an application scope and a **policy
binding**:

- **Scope:** `ConfigurationScope.APPLICATION`
  (`extensionManagement.ts:742`) — not workspace- or folder-overridable; a malicious repo's
  `.vscode/settings.json` cannot relax it.
- **Policy:** registered with
  `policy: { name: 'AllowedExtensions', category: PolicyCategory.Extensions, minimumVersion: '1.96' }`
  (`extensionManagement.ts:743-753`).
- **Policy beats user settings, hard:** when a key has a policy value, the configuration
  service **refuses any write** —
  `src/vs/platform/configuration/common/configurationService.ts:123-124`:
  `throw new Error("Unable to write ${key} because it is configured in system policy.")` —
  and `getValue()` returns the policy value as highest precedence
  (`PolicyConfiguration`, wired at `configurationService.ts:50,73`). The user literally
  cannot edit `extensions.allowed` in settings.json when it is policy-set.
- Core even renders the right message: when disallowed extensions exist *and the key is
  policy-set*, the notification reads "… not allowed by your system administrator"
  (`src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts:1511-1521`).

### 4. How policy is delivered **without any Microsoft dependency**

The policy value is produced by an `IPolicyService` chosen at startup
(`src/vs/code/electron-main/main.ts:213-229`, mirrored for the CLI at
`src/vs/code/node/cliProcessMain.ts:181-193`):

- **Linux:** `FilePolicyService` reading `/etc/vscode/policy.json`
  (`LINUX_SYSTEM_POLICY_FILE_PATH` in `src/vs/base/common/policy.js:12`) — a plain JSON file,
  no MS service.
- **macOS / Windows:** `NativePolicyService` reading managed preferences / registry under
  **our own** identity (`darwinBundleIdentifier = dev.glyphstudio.app`,
  `win32RegValueName = GlyphStudio`, from `product.json`). MDM/Intune/GPO or a `defaults
  write dev.glyphstudio.app` can set it.
- **Portable / explicit file (all platforms):** passing `--__enable-file-policy` makes
  `environmentService.policyFile` resolve to `~/.glyphstudio/policy.json` (or
  `$VSCODE_PORTABLE/policy.json`) and core loads a `FilePolicyService` for it
  (`src/vs/platform/environment/common/environmentService.ts:267-274`;
  `main.ts:224-225`).

`FilePolicyService` simply reads a JSON object and keeps only keys that match a registered
policy definition (`src/vs/platform/policy/common/filePolicyService.ts:48-71`), so a file
containing `{ "AllowedExtensions": { … } }` is honored.

> **The policy *key name* is `AllowedExtensions`** (the `policy.name`), **not** the setting
> id `extensions.allowed`. In a policy file you write the policy name; in `settings.json`
> you write the setting id. See `sovereign-policy.json` in this folder for the file form.

**Net:** the hard guarantee ("non-allowlisted extensions cannot be enabled, and the user
cannot undo it") is achieved by *setting `AllowedExtensions` via policy* + *core's existing
enablement/install gates*. No workbench patch touches that path.

---

## The one residual gap → optional `PATCH-001`

The hard guarantee above assumes the Sovereign policy is actually *present* as a policy
value. On Linux that's a file we control; with `--__enable-file-policy` it's a file we
control. **But on macOS/Windows the stock loader uses `NativePolicyService` only**
(`main.ts:218-221`) and never auto-loads a bundled file — so a self-contained Sovereign
build that wants its policy to travel *inside the .app/.exe* (no MDM, no `defaults write`)
has no stock hook on those platforms.

Options, in order of preference:

1. **No patch (deployment-only):** ship the Sovereign policy via OS managed prefs (MDM/GPO)
   or document the `--__enable-file-policy` launch flag + `~/.glyphstudio/policy.json`. Fully
   stock. Acceptable for pilots where we control the launcher/MDM.
2. **`PATCH-001` (recommended for shrink-wrapped Sovereign builds):** a narrow change to the
   *policy-source selection* in `main.ts` / `cliProcessMain.ts` so that, when a
   GlyphStudio-bundled policy file exists (or `product.json` carries a sovereign flag), the
   app loads a `FilePolicyService` over that bundled file in addition to / ahead of the
   native source. This patches **which file the policy comes from**, not extension
   enablement. Specified — **not applied** — as `PATCH-001` in `../../../SECURITY-PATCHES.md`.

Either way, the enablement/install enforcement itself is 100% stock core.

---

## How Sovereign vs Developer mode is selected and surfaced

**Mode is a property of the distribution/deployment, expressed as the presence/absence of an
allowlist policy** — not a runtime toggle the user flips.

| | Sovereign (default for security buyers) | Developer (convenience) |
|---|---|---|
| `AllowedExtensions` policy | **Set** to first-party + curated allowlist (see overlay). | **Unset** (or `{ "*": true }`). |
| Third-party install/enable | Blocked unless allowlisted (stock gates). | Allowed (arbitrary Open VSX). |
| Trust claim | Whole-workspace ext egress controlled by posture. | Limited to the governed agent run only. |
| Required UI | Posture badge = "Sovereign"; disallowed-ext notification (stock). | **Ambient-extension warning** when non-first-party extensions are enabled (GlyphStudio extension; see below). |

- **Selection:** chosen at provisioning time. A Sovereign build/deployment ships the
  policy; a Developer build does not. The first-party GlyphStudio extension reads the
  effective posture and reports it to the supervisor in every run request
  (`docs/ide-build-design.md` §10.3, field `extension posture: sovereign | developer`).
- **Detecting posture from the extension:** the extension determines posture by inspecting
  whether `AllowedExtensions` is policy-set. Today there is no extension-host API that
  exposes "is this setting policy-locked." The robust, stock-only signal is: **read
  `glyphstudio.extensions.mode`** (a GlyphStudio-owned setting we also publish via the same
  policy file/overlay — see `default-settings.sovereign.json`). The supervisor must treat
  the *policy presence* (verified host-side, not the extension's word) as authoritative;
  the extension-host value is for UI only. (Marked NOT-WIRED below.)
- **Surfacing — Trust Panel:** §14 requires an "extension posture: Sovereign or Developer"
  badge and an "ambient extensions enabled in Developer mode" failure/warning state. The
  Developer-mode ambient warning behavior is scaffolded in
  `developer-mode-ambient-warning.md` and `ambient-extension-warning.contrib.md` (stub).

---

## How the curated allowlist is expressed, pinned, and signed

**Expression (stock):** the allowlist is the `AllowedExtensions` value — a dictionary keyed
by `publisher.name`, bare `publisher`, or `*`:

```jsonc
{
  // first-party: pin GlyphStudio publisher entirely
  "glyphstudio": true,
  // curated signed third-party: pin to exact reviewed versions (version-pinned per §18.14)
  "redhat.vscode-yaml": ["1.14.0"],
  "esbenp.prettier-vscode": ["10.4.0", "darwin-arm64@10.4.0"],
  // everything else: deny
  "*": false
}
```

- **Pinning:** use the **array form** (`["1.14.0"]`) to pin exact versions, optionally with
  a `platform@version` token (`darwin-arm64@10.4.0`) — parsed at
  `allowedExtensionsService.ts:107-122`. This satisfies §18.14 ("Open VSX/curated extension
  channel behavior is version-pinned and auditable"). `"stable"` forbids pre-releases
  (`:104-106`). Bare `true` allows any version of a publisher/extension — use **only** for
  our own `glyphstudio` publisher.
- **`"*": false`** is the sovereign default-deny floor. Without it, anything not explicitly
  named would fall through to "allowed" only if `"*": true`; with no `*` entry the final
  branch denies (`allowedExtensionsService.ts:138-142`). We set `"*": false` explicitly so
  the intent is auditable.

**Signing / provenance (the part stock Open VSX does *not* give us):**

- Open VSX does **not** universally sign extensions the way the MS Marketplace does, and our
  `product.json extensionsGallery.controlUrl` is intentionally empty (no MS malicious-ext
  list). So the allowlist *is* our integrity boundary: only reviewed `publisher.name@version`
  triples are allowed, and the policy that carries them is itself integrity-protected.
- **Pin/sign the allowlist file, not (only) each VSIX:** the curated allowlist
  (`sovereign-policy.json`) is generated from a reviewed source-of-truth
  (`curated-allowlist.jsonc` in this folder) and is **delivered inside the signed,
  notarized app bundle** (Sovereign build) or via signed MDM policy. Tampering with it
  requires breaking the app/MDM signature.
- **VSIX content pinning (defense-in-depth, deferred):** Code-OSS supports a signature check
  via `extensions.verifySignature` (`VerifyExtensionSignatureConfigKey` =
  `extensions.verifySignature`, `extensionManagement.ts:718`). Open VSX signature coverage is
  inconsistent, so we additionally plan to vendor curated VSIX artifacts with recorded
  SHA-256 and install from our signed channel rather than live Open VSX for Sovereign. This
  is a build/channel task, tracked NOT-WIRED below, not a workbench patch.

---

## Files in this folder

| File | Purpose | State |
|---|---|---|
| `README.md` | This decision doc. | done |
| `curated-allowlist.jsonc` | Human source-of-truth: reviewed first-party + curated third-party entries with review notes. | **stub** (only first-party + examples) |
| `sovereign-policy.json` | Generated **policy-file** form (`{ "AllowedExtensions": {…} }`) for `FilePolicyService` (`/etc/vscode/policy.json`, `~/.glyphstudio/policy.json`, or MDM-equivalent). | **stub** |
| `default-settings.sovereign.json` | Sovereign **default-settings overlay** (telemetry off, gallery = Open VSX, autoUpdate off, `glyphstudio.extensions.mode=sovereign`). For the workbench default-config overlay, NOT user settings. | **stub** |
| `default-settings.developer.json` | Developer-mode defaults (allowlist unset; ambient warning on). | **stub** |
| `developer-mode-ambient-warning.md` | Spec for the Developer-mode ambient-extension warning (first-party extension behavior). | spec |
| `ambient-extension-warning.contrib.md` | Stubbed contribution shape for the warning, marking the extension-host seam. | **stub** |
| `apply-overlay.md` | How these overlays are intended to be applied at build/package time (no build wiring done yet). | spec |

---

## What is NOT wired yet (do not assume these are live)

1. **No build/package wiring.** Nothing in `build/gulpfile*.ts` copies these overlays into a
   produced artifact. `apply-overlay.md` describes the intended injection points only.
2. **Default-settings overlay is not registered.** OSS has no `product.json
   configurationDefaults` field (`IProductConfiguration` in `src/vs/base/common/product.ts`
   has no such key), so `default-settings.sovereign.json` is not auto-applied. It must be
   wired either by (a) a tiny default-config registration in the first-party bundle, or (b)
   shipping the values *as policy* alongside `AllowedExtensions`. Decision deferred to M1
   implementation; both are stock-compatible.
3. **`glyphstudio.extensions.mode` setting is not registered** anywhere in core/extension yet.
4. **Posture detection from the extension is UI-only.** Authoritative posture must be
   verified host-side by the supervisor (policy presence), per §10.3 — not implemented here.
5. **The Developer-mode ambient-extension warning is a stub.** No extension code emits it yet.
6. **Curated VSIX signing/vendoring channel** (SHA-256 pinning, signed channel) is not built.
7. **`PATCH-001` is specified but NOT applied** (`../../../SECURITY-PATCHES.md`). The
   workbench is unmodified by this scaffold.

---

## Acceptance mapping (`docs/ide-build-design.md` §18)

- **#1** malicious third-party ext cannot be enabled in Sovereign unless allowlisted, or IDE
  visibly leaves trusted mode → **stock**: `DisabledByAllowlist` + un-flippable enablement.
- **#2** unapproved ext doing raw `fs` read of secrets is disabled by posture or clearly
  outside the trust claim → Sovereign: disabled; Developer: ambient warning + scoped claim.
- **#14** Open VSX/curated channel is version-pinned and auditable → array-form version pins
  in the allowlist; allowlist delivered in a signed artifact.
