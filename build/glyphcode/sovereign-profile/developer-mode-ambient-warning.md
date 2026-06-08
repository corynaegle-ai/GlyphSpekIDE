# Developer-mode Ambient-Extension Warning — Spec

> `docs/ide-build-design.md` §5.2 (Developer mode), §14 (Trust Panel required failure state
> "ambient extensions enabled in Developer mode"), §18.2.
> **Status: SPEC + STUB.** No code emits this warning yet.

## Why this exists

In **Developer mode** the user may install arbitrary Open VSX extensions. A malicious or
careless third-party extension runs in the stock extension host with normal `fs`/`net`
capability and is **not** brokered by the supervisor. The product must therefore *never*
imply whole-workspace containment in Developer mode. The ambient-extension warning makes the
reduced trust claim explicit and unmissable.

This warning is **GlyphCode's responsibility (first-party extension)** — it is not a stock
Code-OSS feature. Stock core only warns about *disallowed* extensions in Sovereign mode
(via the `DisabledByAllowlist` notification, `extensionsWorkbenchService.ts:1511-1521`); it
does not warn merely because an arbitrary-but-allowed extension is enabled.

## Trigger condition

Show the warning when **all** hold:

1. Effective posture is `developer` (no `AllowedExtensions` policy in force), AND
2. at least one **enabled** extension is **not** in the first-party set
   (`publisher === "glyphcode"`) and **not** a built-in/system extension
   (`ExtensionType.System`).

Computed from the extension host's enabled-extension list (the first-party extension already
has extension-host access; no new API needed). Re-evaluate on extension
enable/disable/install/uninstall and on posture change.

## Surfaces (all owned by the first-party extension / Trust Panel)

1. **Trust Panel posture badge:** posture = "Developer" rendered distinctly from
   "Sovereign" (§14). When ambient extensions are enabled, badge carries a warning
   affordance.
2. **Per-run trust scoping:** every run started in Developer mode records
   `extension posture: developer` in the run request (§10.3) and the Trust Panel labels the
   run's trust claim as *limited to the governed agent run*, listing the count (and on
   expand, the ids) of ambient enabled extensions.
3. **One-time status/notification:** on first detection per window session, an informational
   (not modal) notification: *"GlyphCode is in Developer mode. N third-party extension(s)
   are enabled and run outside GlyphCode's trust boundary. Governed agent runs remain
   isolated, but whole-workspace extension behavior is not controlled."* Dismissible;
   re-armed when the ambient set changes.

## Must NOT do

- Must not claim the ambient extensions are sandboxed/brokered.
- Must not be silenceable in a way that also hides the per-run trust-scope label (the run
  label is authoritative and always shown).
- Must not block the user (Developer mode is a convenience posture by design).

## Authoritative vs cosmetic

The extension-host computation drives **UI**. The **authoritative** posture for any trust
claim is the supervisor's host-side check of whether the `AllowedExtensions` policy is in
force (§10.3) — the extension's self-report is not trusted for the verdict. If posture
detection in the extension and posture verification in the supervisor disagree, the
supervisor's value wins and the run is treated as Developer (lower claim).

## Acceptance (maps to §18.2)

- With a non-allowlisted extension enabled in Developer mode: warning surfaces; run trust
  claim is labeled "governed run only"; Trust Panel shows ambient count.
- Same extension under Sovereign policy: extension is `DisabledByAllowlist` (stock), warning
  path not reached, posture badge = "Sovereign".
