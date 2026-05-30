# Ambient-Extension Warning — Stub Contribution Shape

> **STUB.** Pseudocode for where the Developer-mode ambient warning lives in the
> **first-party GlyphSpek extension** (NOT in the Code-OSS workbench; no fork patch).
> Lives in the extension bundle (`extension/` → IDE extension), not under `src/vs/`.
> Nothing here is wired or compiled.

```ts
// glyphspek-extension: src/posture/ambientExtensionWarning.ts  (NOT YET CREATED)
import * as vscode from 'vscode';

const FIRST_PARTY_PUBLISHER = 'glyphspek';

type Posture = 'sovereign' | 'developer';

// UI-only posture read. Authoritative posture is verified host-side by the supervisor.
function readPosture(): Posture {
  return vscode.workspace
    .getConfiguration('glyphspek.extensions')
    .get<Posture>('mode', 'developer');
}

function ambientEnabledExtensions(): vscode.Extension<unknown>[] {
  return vscode.extensions.all.filter(e =>
    e.isActive !== undefined &&                       // installed/enabled in this host
    e.id.split('.')[0].toLowerCase() !== FIRST_PARTY_PUBLISHER &&
    !e.packageJSON?.isBuiltin                          // exclude built-in/system
  );
}

export function registerAmbientExtensionWarning(ctx: vscode.ExtensionContext) {
  let warnedKey = '';

  const evaluate = () => {
    const posture = readPosture();
    const warnEnabled = vscode.workspace
      .getConfiguration('glyphspek.extensions')
      .get<boolean>('ambientWarning', true);

    if (posture !== 'developer' || !warnEnabled) {
      // Sovereign: stock DisabledByAllowlist handles enforcement. Nothing to warn.
      // TODO: still push posture='sovereign' to Trust Panel badge.
      return;
    }

    const ambient = ambientEnabledExtensions();
    // TODO(trust-panel): push { posture:'developer', ambientCount: ambient.length,
    //                          ambientIds: ambient.map(e => e.id) } to the Trust Panel.
    // TODO(supervisor): include extension posture='developer' in every run request (§10.3).

    const key = ambient.map(e => e.id.toLowerCase()).sort().join(',');
    if (ambient.length > 0 && key !== warnedKey) {
      warnedKey = key;
      vscode.window.showWarningMessage(
        `GlyphSpek is in Developer mode. ${ambient.length} third-party extension(s) ` +
        `run outside GlyphSpek's trust boundary. Governed agent runs remain isolated, ` +
        `but whole-workspace extension behavior is not controlled.`
      );
    }
  };

  ctx.subscriptions.push(
    vscode.extensions.onDidChange(evaluate),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('glyphspek.extensions')) { evaluate(); }
    }),
  );
  evaluate();
}
```

## Settings this stub depends on (NOT YET REGISTERED)

The first-party extension's `package.json` `contributes.configuration` must declare:

```jsonc
"glyphspek.extensions.mode":          { "type": "string", "enum": ["sovereign","developer"], "default": "developer" },
"glyphspek.extensions.ambientWarning":{ "type": "boolean", "default": true }
```

These are GlyphSpek-owned settings, distinct from stock `extensions.allowed`. Their default
values are also published via the Sovereign/Developer overlays in this folder.

## NOT wired

- No `glyphspek-extension` source file exists yet; this is shape-only.
- Trust Panel push (`TODO(trust-panel)`) and supervisor run-request posture field
  (`TODO(supervisor)`) are unimplemented.
- `isBuiltin`/system filtering may need refinement against the real packageJSON shape.
