# Applying the Sovereign / Developer Overlays — Intended Wiring

> **SPEC ONLY. No build wiring is implemented.** This documents *how* the overlays in this
> folder are meant to reach a produced GlyphStudio artifact, so M1 implementation has a target.
> Constraints respected: this scaffold does not modify `product.json`, `resources/`,
> `node_modules/`, or run git mutating commands.

## Three things must be delivered, by different channels

| Thing | Channel | Why |
|---|---|---|
| **Allowlist (hard)** — `AllowedExtensions` | **Policy** (`sovereign-policy.json` → file/MDM/registry) | Must be un-overridable; only the policy layer is un-writable by the user (`configurationService.ts:123-124`). |
| **Defaults (soft)** — telemetry off, autoUpdate off, mode, ambient flag | **Default-config overlay** (`default-settings.*.json`) | Sensible boot defaults the user *may* change (except where also policy-set). |
| **Gallery** — Open VSX | **`product.json` `extensionsGallery`** | Already wired in `product.json` (do not duplicate in settings). |

## A. Allowlist policy delivery (Sovereign only)

Pick per deployment (see README "How policy is delivered"):

1. **Linux:** install `sovereign-policy.json` to `/etc/vscode/policy.json` (path =
   `LINUX_SYSTEM_POLICY_FILE_PATH`, `src/vs/base/common/policy.js:12`). Stock loader uses it
   (`main.ts:222-223`).
2. **macOS:** deliver the `AllowedExtensions` value via managed prefs for
   `dev.glyphstudio.app` (MDM, or `defaults write`). Stock `NativePolicyService`
   (`main.ts:220-221`).
3. **Windows:** deliver via registry/GPO under `GlyphStudio` (`win32RegValueName`). Stock
   `NativePolicyService` (`main.ts:218-219`).
4. **Any platform, self-contained:** launch with `--__enable-file-policy` and place the file
   at `~/.glyphstudio/policy.json` (`environmentService.ts:267-274`). For a shrink-wrapped app
   that should not require a launch flag or MDM, see **`PATCH-001`** in
   `../../../SECURITY-PATCHES.md` (optional, narrow, not yet applied).

> The policy file's top-level key is `AllowedExtensions` (policy NAME), not
> `extensions.allowed` (setting id). `sovereign-policy.json` is already in the correct form.

## B. Default-settings overlay delivery (both modes)

OSS has **no** `product.json configurationDefaults` field (`IProductConfiguration` lacks
it), so we cannot inject defaults via `product.json`. Two stock-compatible options for M1:

1. **Preferred — register defaults from the first-party extension** at activation via the
   configuration registry's defaults override
   (`IConfigurationRegistry.registerDefaultConfigurations`), seeded from the relevant
   `default-settings.<mode>.json`. Keeps the workbench source unpatched.
2. **Alternative — ship the soft defaults as policy too** (same file/MDM channel as A). This
   makes them un-overridable, which may be *too* strong for "defaults"; use only for keys we
   truly want locked (e.g. `telemetry.telemetryLevel` in high-security deployments).

Do **not** write these into a user `settings.json` in the image — that pollutes the user
profile and is editable/removable.

## C. Gallery

Already done in `product.json` (`extensionsGallery` → Open VSX). No action.

## Build-time generation (TODO)

A small generator (not yet written) should:
1. read `curated-allowlist.jsonc`,
2. emit `sovereign-policy.json` (`{ "AllowedExtensions": { …entries…, "*": false } }`),
3. validate every curated entry has reviewer/date/version/hash,
4. fail the build if a curated entry uses bare `true` for a non-`glyphstudio` publisher.

Wire that generator into `build/gulpfile*` for Sovereign artifacts. Until then, the JSON in
this folder is maintained by hand and is a STUB.
