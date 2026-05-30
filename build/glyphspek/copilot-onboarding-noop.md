# GlyphSpek — Copilot onboarding wizard must no-op (fatal blank-window fix)

> **M1 branding patch (NOT a security patch).** Decision date: 2026-05-30.
> **Symptom:** the workbench rendered completely blank — a dark window with no
> activity bar, sidebar, editor, or status bar — and the markdown preview webview
> never appeared. Cold-launch renderer log showed:
> `Error: Onboarding requires a default chat agent product configuration.`

## TL;DR

GlyphSpek's M1 branding stripped the GitHub Copilot `defaultChatAgent` block from
`product.json` (GlyphSpek ships no Copilot). But the Copilot-onboarding wizard
`onboardingVariationA.ts` asserted that block's presence at **module-evaluation time**.
That assert threw the instant the module was imported, and because the contribution is
static-imported into `workbench.common.main.ts`, the throw aborted the renderer bootstrap
**before any UI painted** → blank window.

The fix makes the wizard a safe **no-op** when there is no chat agent: the module loads
without throwing, and the single public entry point (`show()`) early-returns when
`product.defaultChatAgent` is absent. The onboarding contribution stays registered (it must —
see "Why we can't just remove it" below), so dependency injection is unaffected.

## Root cause (call path)

- `src/vs/workbench/workbench.common.main.ts` static-imports
  `welcomeOnboarding/browser/welcomeOnboarding.contribution.ts`, which static-imports
  `onboardingVariationA.ts`.
- `onboardingVariationA.ts` had, at **module top level** (runs on import):
  ```ts
  assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');
  const defaultChat = product.defaultChatAgent;
  ```
- With the Copilot block stripped from `product.json`, `product.defaultChatAgent` is
  `undefined`, so `assertDefined` threw during module evaluation → renderer bootstrap aborts
  → nothing paints.

## Why we can't just remove the contribution

`src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts:98` injects
`IOnboardingService` in its constructor. That service is registered **by** the
`welcomeOnboarding` contribution (`OnboardingVariationA implements IOnboardingService`).
Removing the contribution/registration would break DI for `startupPage`. So the service must
stay registered; the wizard itself just needs to no-op.

## The fix

Both changes are in
`src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`.

1. **Module loads without throwing.** Removed the top-level `assertDefined(...)` call and the
   now-unused `assertDefined` import. The module-level `defaultChat` binding now uses a
   non-null assertion so the existing field accesses below still type-check:

   - Before:
     ```ts
     import { assertDefined } from '../../../../base/common/types.js';
     // ...
     assertDefined(product.defaultChatAgent, 'Onboarding requires a default chat agent product configuration.');
     const defaultChat = product.defaultChatAgent;
     ```
   - After (import removed; assert removed):
     ```ts
     const defaultChat = product.defaultChatAgent!;
     ```

2. **`show()` is a safe no-op with no chat agent.** Added an early return at the very top of
   the single public entry that would dereference `defaultChat`:

   ```ts
   show(): void {
       if (!product.defaultChatAgent) {
           return;
       }
       // ...existing body...
   }
   ```

   `show()` is the only public entry that touches `defaultChat`; every other reference
   (the sign-in / disclaimer / enterprise render methods) is `private` and reachable only
   after `show()` builds the overlay. With the guard, none of those paths execute when the
   Copilot block is absent, so `startupPage.tryShowOnboarding() → onboardingService.show()`
   (and the equivalent F1 path) become harmless no-ops instead of dereferencing `undefined`.

## Second crash uncovered by this fix (same root cause: stripped Copilot config)

Removing the onboarding throw revealed a *second*, structurally identical bootstrap crash
from the same stripped `defaultChatAgent` block:

```
Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'chatExtensionId')
```

- File: `src/vs/workbench/services/accounts/browser/defaultAccount.ts:91`
- `toDefaultAccountConfig(defaultChatAgent)` dereferenced `defaultChatAgent.chatExtensionId`
  unconditionally. It is called from the `DefaultAccountService` constructor
  (`defaultAccount.ts:146`) and from `DefaultAccountProviderContribution`
  (`defaultAccount.ts:1149`, registered at `WorkbenchPhase.BlockStartup`) with
  `productService.defaultChatAgent`, which is `undefined` in GlyphSpek → renderer blank.

Fix: `toDefaultAccountConfig` now accepts `IDefaultChatAgent | undefined` and returns a neutral
empty config (empty strings / empty arrays) when there is no chat agent. With no Copilot there
is no default account to configure, so the account provider simply has nothing to fetch. This
matches how the rest of the codebase treats the stripped block (optional chaining + `?? ''`).

## Third issue uncovered (stripped product config — blocks built-in extensions)

With the renderer no longer blank, the renderer console showed:

```
ERR Error scanning installed extensions:
ERR TypeError: productService.builtInExtensionsEnabledWithAutoUpdates is not iterable
```

- File: `src/vs/platform/extensionManagement/common/extensionsScannerService.ts:112`
- `getProductBuiltInExtensionsEnabledWithAutoUpdates()` did
  `for (const id of productService.builtInExtensionsEnabledWithAutoUpdates)`. GlyphSpek's
  branded `product.json` omits that field, so the value is `undefined` → "not iterable" →
  **extension scanning aborts → no built-in extensions load** (markdown-language-features, git,
  etc.). This did not blank the workbench, but it broke the user's markdown-preview repro
  because the `markdown.showPreview` command was never contributed.

Fix: iterate over `... ?? []`, matching the optional-chaining guard already used by the other
six call sites of this field.

## Files changed

- `src/vs/platform/extensionManagement/common/extensionsScannerService.ts`
  - `for (const id of productService.builtInExtensionsEnabledWithAutoUpdates ?? [])` (treat a
    missing list as empty so extension scanning doesn't throw).
- `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts`
  - Removed unused `assertDefined` import.
  - Removed the module-top-level `assertDefined(product.defaultChatAgent, ...)` throw.
  - `const defaultChat = product.defaultChatAgent!;` (non-null assertion, no runtime throw).
  - Added `if (!product.defaultChatAgent) { return; }` guard at the top of `show()`.
- `src/vs/workbench/services/accounts/browser/defaultAccount.ts`
  - `toDefaultAccountConfig` now accepts `IDefaultChatAgent | undefined` and returns an empty
    neutral config when the chat agent is absent (instead of dereferencing `undefined` at
    bootstrap).

## Verification

- `npm run compile-check-ts-native` — clean.
- Rebuilt `vscode-darwin-arm64`, relaunched `GlyphSpek.app`: the workbench now **paints**
  (activity bar, sidebar, editor area, status bar all visible — no longer a blank dark window).
- Opened a markdown file and ran "Markdown: Open Preview": the preview webview renders.
- Renderer log: no remaining uncaught bootstrap exception.
</content>
</invoke>
