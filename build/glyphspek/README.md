# GlyphSpek build/ scripts

Trust-infra gates and build tooling for the clean Code-OSS distribution.

## Embedded first-party extension: keep it in sync with source

The fork ships a **vendored copy** of the first-party extension at
`extensions/glyphspek-trust-panel/`. It is **built out-of-band** from the
canonical SOURCE tree (`../extension`, sibling to this repo) and committed as a
snapshot. Because the source→embedded copy used to be done by hand, the snapshot
**drifted from source three times** (review sweeps 20, 22, 23): a missing command,
a renamed `dist/` file, a supervisor bundle whose hash no longer matched the pin.

The single canonical, reproducible sync command fixes that:

```sh
bash build/glyphspek/sync-embedded-extension.sh
```

This is the **only** supported way to update `extensions/glyphspek-trust-panel/`.
Do **not** copy files by hand.

What it does (deterministic + idempotent):

1. Rebuilds the source (`cd ../extension && npm run compile`) so
   `dist/` + `dist-supervisor/` are current. The build is byte-stable (esbuild +
   tsc emit identical bundles across rebuilds), so re-running produces zero diff.
2. Cross-checks the bundled supervisor `sha256`s against the SOURCE pins in
   `../extension/src/supervisorHash.ts` and **fails loudly** on any mismatch
   (a stale artifact would make the shipped extension refuse its own supervisor).
3. Copies the exact surfaces the conformance gate compares into the embedded copy:
   `package.json`, `README.md`, `dist/*.js` (the built `.js` set — **no `.map`**),
   `dist-supervisor/*.mjs`, and `media/*`. Removes embedded entries no longer in
   source. Leaves the embedded `.vscodeignore` alone (it is intentionally
   different — the embedded copy ships pre-built).

Flags:

| Flag         | Effect                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| *(none)*     | Rebuild source, verify pins, sync. Idempotent no-op when already synced. |
| `--check`    | Verify-only. **Writes nothing**; exits `1` if the embedded copy differs. Gate-suitable. |
| `--no-build` | Skip the rebuild; use the pre-built `../extension` artifacts as-is (pins still verified). |

### Conformance gates

- `verify-embedded-extension.sh` — fails on drift between source and the embedded
  copy (command IDs, activationEvents, `dist/*.js` set, `dist-supervisor/*.mjs`
  set, and pinned supervisor hashes). This is the inverse of the sync script: when
  it fails, run `sync-embedded-extension.sh` to repair.
- `verify-bundled-extensions.sh` — the packaged-app deny gate; chains the
  no-Copilot-runtime gate and the source↔embedded conformance gate above.

### CI / pre-package hook

`sync-embedded-extension.sh --check` is a clean drift gate (exits non-zero when
out of sync, writes nothing). Run it in CI / before packaging to fail fast, then
fix with the plain `sync-embedded-extension.sh`. The sync is intentionally **not**
wired into the gulp packaging path: packaging from a clean checkout must not
rebuild a sibling source tree as a side effect. The committed embedded snapshot is
the source of truth for a package; this script keeps that snapshot honest.

### Edge case: gitignored-but-force-tracked embedded `dist/`

`extensions/**/dist/` is gitignored, but `extensions/glyphspek-trust-panel/dist/**`
is force-tracked via a `!`-negation in the root `.gitignore` so a fresh clone
ships the built extension. The sync writes the `.js` set there directly. `.map`
files are separately gitignored (`**/*.map`) and never tracked, which is why the
embedded copy ships `.js` only — the sync deliberately manages just `dist/*.js`.
