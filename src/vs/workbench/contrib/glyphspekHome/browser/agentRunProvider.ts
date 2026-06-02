/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GlyphSpek AGENT-RUN PROVIDER — the desktop (native Code-OSS workbench) side of the
 * Agent View seam (docs/glyphspek-agent-view-design.md §2). This is Part B of Slice 1.
 *
 * The workbench CANNOT import the extension tree (layer boundary — see the header of
 * extension/src/agentRunSnapshot.ts and runTrustBadge.ts). So:
 *   - It reaches the run set through the READ-ONLY VS Code command
 *     `glyphspek.runs.snapshot` (Part A contract), which returns an AgentRunSnapshot.
 *   - It polls `glyphspek.runs.revision` (a monotonic number that advances on every
 *     run-set change AND every webview signature flip) to know WHEN to re-fetch — a
 *     command cannot push into the workbench, so the change-signal is pulled.
 *   - It REDECLARES the Slice-1 trust primitives locally (the established honesty
 *     mirror pattern) so it can fold a row into a card state WITHOUT re-deciding trust.
 *
 * HONESTY: this module never invents a run and never re-decides trust. It drops a
 * snapshot whose `rev` it does not recognize (fail-closed), and it treats the command
 * being unregistered (extension not active) as an empty run set + an honest flag.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IntervalTimer } from '../../../../base/common/async.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

/* ============================================================== *
 * LOCAL TRUST MIRROR (no `any`; faithful to the cited extension files)
 * ============================================================== */

/**
 * The honest CREATION-trust posture. MIRRORS `RunTrust` (extension/src/bridgeProtocol.ts,
 * canonical spikes/p0-contracts/bridge.ts) PLUS the pre-RunOpened 'unknown' sentinel from
 * `CreationTrustPosture` (extension/src/runTrustBadge.ts). We cannot import the extension
 * tree (layer boundary), so we redeclare the exact union here.
 */
export type CreationTrustPosture =
	| 'trusted'
	| 'sandboxed-soft-egress'
	| 'governed-unsandboxed'
	| 'untrusted'
	| 'refused'
	| 'unknown';

/**
 * Posture → product-trust eligibility. MIRRORS `RUN_TRUST_BADGE[*].productTrustEligible`
 * and `UNKNOWN_TRUST_BADGE` (extension/src/runTrustBadge.ts): ONLY 'trusted' is eligible,
 * and even then a webview Ed25519 signature gate is a further necessary condition. Every
 * soft/failure/unknown posture is false — so a SOFT run can NEVER reach 'verified'.
 */
const PRODUCT_TRUST_ELIGIBLE: Readonly<Record<CreationTrustPosture, boolean>> = {
	trusted: true,
	'sandboxed-soft-egress': false,
	'governed-unsandboxed': false,
	untrusted: false,
	refused: false,
	unknown: false
};

export function productTrustEligible(posture: CreationTrustPosture): boolean {
	return PRODUCT_TRUST_ELIGIBLE[posture] === true;
}

/**
 * Run statuses that are a REAL terminal denial/failure (BLOCKED). MIRRORS the
 * `BLOCKED_STATUS_RE` in extension/src/governedRunsCard.ts — substring-insensitive so a
 * final state like 'closed_error' or 'egress_denied' reads as blocked without enumerating
 * every supervisor string. Kept byte-for-byte identical to the source so the desktop row
 * state can never disagree with the host card.
 */
const BLOCKED_STATUS_RE = /(bridge_mismatch|tamper|denied|blocked|refused|error|fail)/i;

/** The three trust-axis row states. MIRRORS `RunCardState` (governedRunsCard.ts). */
export type RunCardState = 'acting' | 'verified' | 'blocked';

/**
 * Trust-axis colors. MIRRORS `RUN_CARD_COLORS` (governedRunsCard.ts) — which in turn
 * matches the status-bar/halo authority hues (statusBarSegments.ts AUTHORITY_LABEL color
 * semantics: amber=claimed/acting, blue/green=verified, red=denied). Used only as a
 * fallback; the CSS class is the primary styling channel.
 */
export const RUN_CARD_COLORS: Readonly<Record<RunCardState, string>> = {
	acting: '#d9a441', // amber  — claimed / acting / unverified
	verified: '#5b9cf0', // verdict-blue — signature-verified product-trusted run
	blocked: '#e0544b' // red   — a real denial / failure
};

/**
 * The Slice-1 subset of the design §1 `AgentRun` (identity, lifecycle status, the
 * creation posture, the webview-confirmed signature fact, and the actor label). Evidence
 * fields (changedFiles/diff/verdict/traceRootHash/assurance) are Slice 2 and deliberately
 * absent. `title` is intent if the projection carried one, else id-derived (the Part A
 * AgentRunProjection does not yet carry intent, so Slice 1 derives a short title).
 */
export interface AgentRun {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly closed: boolean;
	readonly posture: CreationTrustPosture;
	readonly webviewVerified: boolean;
	readonly actorType: string;
}

/**
 * THE ROW-STATE GATE. A faithful mirror of `deriveRunCardState` (governedRunsCard.ts):
 *   1. BLOCKED wins first — a real denial/failure is never dressed as acting/verified.
 *   2. VERIFIED only when the posture is product-trust ELIGIBLE AND the webview confirmed
 *      a verified authority. SOFT postures are ineligible, so they can NEVER be verified
 *      (honesty rule §3.3 — the cap is enforced HERE, in state, not in styling).
 *   3. ACTING otherwise (the amber default — honesty rule §3.1: claims are never green).
 *
 * `isBlocked` mirrors governedRunsCard.isBlocked: a failure posture (untrusted/refused) OR
 * a denial/failure lifecycle status (honesty rule §3.4 — denied/failed wins, red).
 */
export function deriveRunCardState(run: AgentRun): RunCardState {
	if (run.posture === 'untrusted' || run.posture === 'refused' || BLOCKED_STATUS_RE.test(run.status || '')) {
		return 'blocked';
	}
	if (productTrustEligible(run.posture) && run.webviewVerified === true) {
		return 'verified';
	}
	return 'acting';
}

/* -------------------------------------------------------------------------- *
 * AUTHORITY / ASSURANCE AXIS (Slice 4 — the halo binding)
 * -------------------------------------------------------------------------- *
 * The earned-authority axis the Slice-4 Authority Halo binds to. We cannot import
 * the extension tree (layer boundary), so we REDECLARE the union + its label/color
 * semantics here, exactly like the deriveRunCardState mirror above. */

/**
 * The earned assurance axis. MIRRORS `AssuranceLevel` (extension/src/statusBarSegments.ts
 * line 47): `read | claimed | soft | verified | denied`. The detail's `authorityLevel`
 * carries this verbatim from the canonical status-bar computation — already capped
 * honestly (SOFT→'soft', denied/failed honest, just-opened→'read'). We render it; we
 * never re-derive or inflate it.
 */
export type AssuranceLevel = 'read' | 'claimed' | 'soft' | 'verified' | 'denied';

/**
 * The honest, non-color-redundant label per level. MIRRORS `AUTHORITY_LABEL`
 * (extension/src/statusBarSegments.ts lines 86–92) — kept faithful so the pane's
 * `authority:` reflection can never disagree with the status bar's segment text.
 */
const AUTHORITY_LABEL: Readonly<Record<AssuranceLevel, string>> = {
	read: 'read · no authority',
	claimed: 'claimed · unverified',
	soft: 'SOFT · governed-unsandboxed',
	verified: 'verified · signed',
	denied: 'UNTRUSTED · denied'
};

/**
 * The trust-axis hue per level. MIRRORS `HALO_COLOR` (extension/src/haloChrome.ts lines
 * 36–42) AND the fork's whole-workbench halo ring
 * (src/vs/workbench/browser/parts/media/glyphspekAuthorityHalo.css §"assurance → ring
 * color") — slate / amber / violet / blue / red. The pane reflects the SAME hue the ring
 * paints so the edge-tint never disagrees with the chrome. (These also equal the
 * `--gsh-*` trust-axis tokens in glyphspekHome.css; the colorVar field names the matching
 * token so styling can prefer the CSS var when one applies.)
 */
const AUTHORITY_COLOR: Readonly<Record<AssuranceLevel, string>> = {
	read: '#8aa0bd', // slate — read-only, no authority (--gsh-human)
	claimed: '#d9a441', // amber — acted, unverified (--gsh-claim)
	soft: '#a98bff', // violet — governed-unsandboxed / SOFT (--gsh-soft)
	verified: '#5b9cf0', // blue — signature-verified, signed (--gsh-verdict)
	denied: '#e0544b' // red — denied / tampered / untrusted (--gsh-fail)
};

/** The honest authority label for a level (status-bar AUTHORITY_LABEL text). */
export function authorityLabel(level: AssuranceLevel): string {
	return AUTHORITY_LABEL[level] ?? AUTHORITY_LABEL.read;
}

/** The trust-axis hue for a level (halo HALO_COLOR / ring color). */
export function authorityColor(level: AssuranceLevel): string {
	return AUTHORITY_COLOR[level] ?? AUTHORITY_COLOR.read;
}

/** Coerce a wire authority value to a known level; an unknown string fails closed to 'read'. */
function normalizeAuthorityLevel(value: unknown): AssuranceLevel {
	if (value === 'read' || value === 'claimed' || value === 'soft' || value === 'verified' || value === 'denied') {
		return value;
	}
	// A future/foreign level string is treated as 'read' — the neutral floor, never an
	// inflated tint. (Honesty over optimism: never upgrade past what the verifier proved.)
	return 'read';
}

/** A short, honest runtime label from the posture. MIRRORS governedRunsCard.runtimeLabel. */
export function runtimeLabel(posture: CreationTrustPosture): string {
	switch (posture) {
		case 'trusted': return 'sandbox';
		case 'sandboxed-soft-egress': return 'sandbox (soft egress)';
		case 'governed-unsandboxed': return 'worktree (unsandboxed)';
		case 'untrusted': return 'dev runtime';
		case 'refused': return 'refused';
		default: return 'starting…';
	}
}

/** A short actor label. MIRRORS runTrustBadge.actorLabel. */
export function actorLabel(actorType: string): string {
	switch (actorType) {
		case 'claude-code-cli': return 'claude-code-cli';
		case 'codex-cli': return 'codex-cli';
		case 'native': return 'native';
		default: return actorType || 'unknown';
	}
}

/** Trim a run id to a compact header form ('run · <short>'). MIRRORS governedRunsCard.shortRunId. */
export function shortRunId(runId: string): string {
	const id = runId.length > 18 ? runId.slice(0, 17) + '…' : runId;
	return `run · ${id}`;
}

/* ============================================================== *
 * PART A CONTRACT (the snapshot shape, redeclared as the wire type we VALIDATE)
 * ============================================================== */

/**
 * The protocol revision this provider understands. MUST match
 * `AGENT_RUN_SNAPSHOT_REV` in extension/src/agentRunSnapshot.ts. A snapshot whose `rev`
 * is anything else is DROPPED (fail-closed — never mis-render a foreign/future projection).
 */
const SUPPORTED_SNAPSHOT_REV = 1;

/** The read-only command Part A registers to return the run snapshot. */
const SNAPSHOT_COMMAND_ID = 'glyphspek.runs.snapshot';

/**
 * The governed-run command (extension: "GlyphSpek: Build This (Governed Run)"). This is the
 * SAME command today's composer already invokes; `startRun` dispatches it. It is NOT a
 * read-only query — it MUTATES (creates a run) — so it lives here only as the Slice-3 write
 * seam. Kept in lockstep with BUILD_COMMAND_ID in glyphspekHome.ts.
 */
const BUILD_COMMAND_ID = 'glyphspek.promoteChatToBuild';

/** The read-only command Part A registers to return the monotonic change-revision. */
const REVISION_COMMAND_ID = 'glyphspek.runs.revision';

/**
 * The read-only command Part A (Slice 2) registers to return one run's EVIDENCE detail.
 * Takes a runId, returns AgentRunDetail | undefined. Reached the SAME way as the snapshot
 * (the workbench cannot import the extension tree — layer boundary).
 */
const DETAIL_COMMAND_ID = 'glyphspek.runs.detail';

/**
 * The detail protocol revision this provider understands. MUST match
 * `AGENT_RUN_DETAIL_REV` in extension/src/agentRunDetail.ts (independent of the snapshot
 * rev). A detail whose `rev` is anything else is DROPPED (fail-closed — never mis-render a
 * foreign/future projection).
 *
 * REV 2 (Agent View Slices 3 & 4): the detail gained `intent` (Slice-3 composer read-only
 * intent) and `authorityLevel` (Slice-4 halo binding). Bumped in LOCKSTEP with Part A
 * (both rebuilt together — a clean bump, not a back-compat negotiation). A rev-1 detail is
 * now ALSO dropped (fail-closed): an old projection lacks `authorityLevel`, and we will not
 * fabricate one. Unknown/future revs stay fail-closed for the same reason.
 */
const SUPPORTED_DETAIL_REV = 2;

/** How often we poll the revision command (ms). Modest — the snapshot is cheap and pulled. */
const POLL_INTERVAL_MS = 2000;

/**
 * Narrow an unknown command result to the Slice-1 projection shape WITHOUT an `any` cast.
 * Returns the validated AgentRun list, or null when the snapshot is missing/foreign/
 * future-rev (so the caller fails closed to an empty list rather than mis-rendering).
 */
function readSnapshot(raw: unknown): AgentRun[] | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const snapshot = raw as { rev?: unknown; runs?: unknown };
	if (snapshot.rev !== SUPPORTED_SNAPSHOT_REV) {
		return null; // unknown/foreign/future rev — fail-closed.
	}
	if (!Array.isArray(snapshot.runs)) {
		return null;
	}
	const runs: AgentRun[] = [];
	for (const entry of snapshot.runs) {
		if (!entry || typeof entry !== 'object') {
			continue; // never fabricate a row from a malformed entry.
		}
		const row = entry as {
			id?: unknown;
			actorType?: unknown;
			status?: unknown;
			closed?: unknown;
			posture?: unknown;
			webviewVerified?: unknown;
		};
		if (typeof row.id !== 'string' || row.id.length === 0) {
			continue;
		}
		runs.push({
			id: row.id,
			// Part A's AgentRunProjection carries no intent yet, so Slice 1 derives the
			// title from the id (design §1: "title/intent if available else id-derived").
			title: shortRunId(row.id),
			status: typeof row.status === 'string' ? row.status : 'unknown',
			closed: row.closed === true,
			posture: normalizePosture(row.posture),
			webviewVerified: row.webviewVerified === true,
			actorType: typeof row.actorType === 'string' ? row.actorType : 'unknown'
		});
	}
	return runs;
}

/** Coerce a wire posture to a known CreationTrustPosture; an unknown string fails closed to 'unknown'. */
function normalizePosture(value: unknown): CreationTrustPosture {
	if (value === 'trusted' || value === 'sandboxed-soft-egress' || value === 'governed-unsandboxed'
		|| value === 'untrusted' || value === 'refused' || value === 'unknown') {
		return value;
	}
	// A future/foreign posture string is treated as 'unknown' — productTrustEligible:false,
	// so it can never gate a 'verified' row. (Honesty over optimism.)
	return 'unknown';
}

/* ============================================================== *
 * PART A DETAIL CONTRACT (Slice 2 — the per-run EVIDENCE shape, redeclared)
 * ============================================================== *
 * The workbench cannot import extension/src/agentRunDetail.ts (layer boundary — the same
 * reason AgentRun above is redeclared). So we REDECLARE the AgentRunDetail shape locally
 * and shape-narrow the command's `unknown` result against it. The view renders THIS shape;
 * it never re-decides trust. A detail whose rev/shape we don't recognize is DROPPED. */

/** One file the run touched. MIRRORS AgentRunChangedFile (agentRunDetail.ts). */
export interface AgentRunChangedFile {
	readonly path: string;
	readonly status: 'added' | 'modified' | 'deleted';
	readonly additions?: number;
	readonly deletions?: number;
}

/** One verifier check result. MIRRORS AgentRunCheck (agentRunDetail.ts). */
export interface AgentRunCheck {
	readonly name: string;
	readonly status: 'pass' | 'fail' | 'error' | 'skipped';
}

/**
 * The projected verifier verdict — the SIGNED facts, copied verbatim by Part A. MIRRORS
 * AgentRunVerdict (agentRunDetail.ts). sweep-46 (`traceRootHash`) and sweep-47
 * (`verifierIsolation` / `verifyCommandSource`) fields are OPTIONAL — present on real
 * builds, absent in view-layer fixtures and pre-sweep verdicts; the pane handles absence.
 * `signaturePresent` is presence ONLY — never the signature value/keyId. It is NOT the
 * trust gate (the canonical `verified` boolean on AgentRunDetail is).
 */
export interface AgentRunVerdict {
	readonly overall: 'pass' | 'fail' | 'error';
	readonly assurance: 'full' | 'degraded';
	readonly verifierIsolation?: 'inline-unsandboxed' | 'independent-sandboxed';
	readonly verifyCommandSource?: 'override' | 'swiftpm' | 'xcode' | 'npm' | 'node' | 'none';
	readonly checks: readonly AgentRunCheck[];
	readonly traceRootHash?: string;
	readonly signaturePresent: boolean;
}

/**
 * The per-run EVIDENCE the right pane binds to. MIRRORS AgentRunDetail (agentRunDetail.ts).
 * `verified` is the CANONICAL webview Ed25519 signature gate, COPIED by Part A — the ONLY
 * trust gate. `verdict` is absent until a verifier verdict arrived (the honest "no verdict"
 * state); `changedFiles`/`diff` are empty until a review was retained.
 */
export interface AgentRunDetail {
	readonly id: string;
	/**
	 * The run's INTENT text (Slice-3 composer read-only view). MIRRORS AgentRunDetail.intent
	 * (agentRunDetail.ts) — OPTIONAL: OMITTED for a run with no intent yet (never fabricated).
	 * When absent the composer shows an honest neutral label, NOT a synthesized title.
	 */
	readonly intent?: string;
	readonly actorType: string;
	readonly status: string;
	readonly closed: boolean;
	readonly posture: CreationTrustPosture;
	readonly verified: boolean;
	/**
	 * The run's EARNED assurance level (Slice-4 halo binding). MIRRORS
	 * AgentRunDetail.authorityLevel (agentRunDetail.ts) — the canonical, pre-capped status-bar
	 * computation, COPIED verbatim. Always present (a just-opened/unknown run reads 'read').
	 * The halo reflects THIS only — never more than the verifier proved.
	 */
	readonly authorityLevel: AssuranceLevel;
	readonly changedFiles: readonly AgentRunChangedFile[];
	readonly diff: string;
	readonly verdict?: AgentRunVerdict;
}

/** Narrow one unknown check entry, dropping a malformed one (never fabricate a check row). */
function readCheck(raw: unknown): AgentRunCheck | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const c = raw as { name?: unknown; status?: unknown };
	if (typeof c.name !== 'string') {
		return null;
	}
	if (c.status !== 'pass' && c.status !== 'fail' && c.status !== 'error' && c.status !== 'skipped') {
		return null;
	}
	return { name: c.name, status: c.status };
}

/** Narrow one unknown changed-file entry, dropping a malformed one. */
function readChangedFile(raw: unknown): AgentRunChangedFile | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const f = raw as { path?: unknown; status?: unknown; additions?: unknown; deletions?: unknown };
	if (typeof f.path !== 'string' || f.path.length === 0) {
		return null;
	}
	if (f.status !== 'added' && f.status !== 'modified' && f.status !== 'deleted') {
		return null;
	}
	return {
		path: f.path,
		status: f.status,
		...(typeof f.additions === 'number' ? { additions: f.additions } : {}),
		...(typeof f.deletions === 'number' ? { deletions: f.deletions } : {})
	};
}

/** Narrow the verdict sub-shape, or null when absent/malformed (→ honest "no verdict"). */
function readVerdict(raw: unknown): AgentRunVerdict | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const v = raw as {
		overall?: unknown;
		assurance?: unknown;
		verifierIsolation?: unknown;
		verifyCommandSource?: unknown;
		checks?: unknown;
		traceRootHash?: unknown;
		signaturePresent?: unknown;
	};
	if (v.overall !== 'pass' && v.overall !== 'fail' && v.overall !== 'error') {
		return null;
	}
	// An unrecognized assurance fails CLOSED to 'degraded' (never silently upgrade to 'full').
	const assurance: 'full' | 'degraded' = v.assurance === 'full' ? 'full' : 'degraded';
	const checks: AgentRunCheck[] = [];
	if (Array.isArray(v.checks)) {
		for (const entry of v.checks) {
			const check = readCheck(entry);
			if (check) {
				checks.push(check);
			}
		}
	}
	const isolation = v.verifierIsolation === 'inline-unsandboxed' || v.verifierIsolation === 'independent-sandboxed'
		? v.verifierIsolation
		: undefined;
	const cmdSource = v.verifyCommandSource === 'override' || v.verifyCommandSource === 'swiftpm'
		|| v.verifyCommandSource === 'xcode' || v.verifyCommandSource === 'npm'
		|| v.verifyCommandSource === 'node' || v.verifyCommandSource === 'none'
		? v.verifyCommandSource
		: undefined;
	return {
		overall: v.overall,
		assurance,
		...(isolation ? { verifierIsolation: isolation } : {}),
		...(cmdSource ? { verifyCommandSource: cmdSource } : {}),
		checks,
		...(typeof v.traceRootHash === 'string' && v.traceRootHash.length > 0 ? { traceRootHash: v.traceRootHash } : {}),
		signaturePresent: v.signaturePresent === true
	};
}

/**
 * Narrow an unknown `glyphspek.runs.detail` result to AgentRunDetail WITHOUT an `any` cast.
 * Returns the validated detail, or null when it is missing / foreign / future-rev / malformed
 * (so the caller fails closed to "no evidence" rather than mis-rendering). The verified flag
 * is coerced with `=== true` (fail-closed: a loose/truthy gate can never promote a run).
 */
function readDetail(raw: unknown): AgentRunDetail | null {
	if (!raw || typeof raw !== 'object') {
		return null; // includes `undefined` — the contract's unknown-run sentinel.
	}
	const d = raw as {
		rev?: unknown;
		id?: unknown;
		intent?: unknown;
		actorType?: unknown;
		status?: unknown;
		closed?: unknown;
		posture?: unknown;
		verified?: unknown;
		authorityLevel?: unknown;
		changedFiles?: unknown;
		diff?: unknown;
		verdict?: unknown;
	};
	if (d.rev !== SUPPORTED_DETAIL_REV) {
		return null; // unknown/foreign/future rev (incl. the now-superseded rev 1) — fail-closed.
	}
	if (typeof d.id !== 'string' || d.id.length === 0) {
		return null;
	}
	const changedFiles: AgentRunChangedFile[] = [];
	if (Array.isArray(d.changedFiles)) {
		for (const entry of d.changedFiles) {
			const file = readChangedFile(entry);
			if (file) {
				changedFiles.push(file);
			}
		}
	}
	const verdict = readVerdict(d.verdict);
	return {
		id: d.id,
		// OMIT a missing/blank intent (never fabricate one) — Part A already trims + caps it.
		...(typeof d.intent === 'string' && d.intent.length > 0 ? { intent: d.intent } : {}),
		actorType: typeof d.actorType === 'string' ? d.actorType : 'unknown',
		status: typeof d.status === 'string' ? d.status : 'unknown',
		closed: d.closed === true,
		posture: normalizePosture(d.posture),
		verified: d.verified === true,
		// COPY the canonical assurance; an absent/foreign level fails closed to 'read' (the
		// neutral floor) — we never invent an inflated tint the verifier didn't prove.
		authorityLevel: normalizeAuthorityLevel(d.authorityLevel),
		changedFiles,
		diff: typeof d.diff === 'string' ? d.diff : '',
		...(verdict ? { verdict } : {})
	};
}

/* ============================================================== *
 * THE PROVIDER SEAM (design §2 — ONE provider, NO registry)
 * ============================================================== */

/**
 * The Slice-1 backend seam for the Agent View. Deliberately the minimal subset of design
 * §2's IAgentRunProvider that the LEFT pane needs: list runs + observe changes. (getRun,
 * startRun are Slice 2/3.) One provider today; a remote provider could implement the same
 * shape later (§5) — we keep it single-provider, no registry (§4 non-goal).
 */
export interface IAgentRunProvider extends IDisposable {
	/** Snapshot of known runs, newest-first (mirrors GovernedRunsModel.list()). */
	listRuns(): readonly AgentRun[];

	/**
	 * Fetch one run's EVIDENCE detail (Slice 2) via the read-only `glyphspek.runs.detail`
	 * command. Resolves to the validated AgentRunDetail, or `undefined` when the run is
	 * unknown to the backend, the extension is inactive (command unregistered), or the
	 * detail's rev/shape is unrecognized (fail-closed — never mis-render a foreign detail).
	 */
	getRunDetail(runId: string): Promise<AgentRunDetail | undefined>;

	/**
	 * Start a governed run from the composer's intent (Slice 3, design §2 `startRun`).
	 * Backed by the existing governed-run command `glyphspek.promoteChatToBuild` (the SAME
	 * command today's composer already invokes) — a blank/whitespace title lets that command
	 * prompt for one itself (its quick-input), so an empty submit is never a silent no-op.
	 *
	 * Unlike design §2's signature we do NOT return the minted runId: the new run surfaces
	 * via the existing snapshot/revision change signal (onDidChangeRuns), so a synchronous
	 * runId is unnecessary and would invite a second seam. The provider NEVER confers trust;
	 * the backend settles it and it arrives via onDidChangeRuns. Resolves once the command
	 * has been dispatched; rejects/swallows nothing the caller must handle — when the command
	 * is unregistered the caller must already be guarding (see isExtensionActive), exactly as
	 * today's composer does.
	 */
	startRun(intent: { title: string; workspace?: string }): Promise<void>;

	/** Fires when the run set or any run's verified flag changes (pulled via the revision). */
	readonly onDidChangeRuns: Event<void>;

	/**
	 * True when the snapshot command is unregistered (the GlyphSpek extension is not active
	 * in this window). The view shows an honest "extension not active" hint instead of an
	 * empty-runs state. False once a snapshot has been fetched successfully.
	 */
	isExtensionActive(): boolean;
}

/**
 * The desktop provider. Polls `glyphspek.runs.revision`; on an advance, re-fetches
 * `glyphspek.runs.snapshot`, validates it, and fires onDidChangeRuns. Pure of DOM.
 */
export class DesktopAgentRunProvider extends Disposable implements IAgentRunProvider {

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns: Event<void> = this._onDidChangeRuns.event;

	private runs: readonly AgentRun[] = [];
	/** Last revision we successfully fetched against; -1 forces the first fetch. */
	private lastRevision = -1;
	/** Whether the most recent poll saw the snapshot command registered. */
	private extensionActive = false;
	/** Guards against overlapping async polls. */
	private polling = false;

	constructor(
		@ICommandService private readonly commandService: ICommandService
	) {
		super();

		const timer = this._register(new IntervalTimer());
		// Kick an immediate poll so the list populates without waiting a full interval,
		// then poll on a modest cadence. Errors are swallowed (extension-not-active path).
		void this.poll();
		timer.cancelAndSet(() => void this.poll(), POLL_INTERVAL_MS);
		this._register(toDisposable(() => { this.polling = false; }));
	}

	listRuns(): readonly AgentRun[] {
		return this.runs;
	}

	isExtensionActive(): boolean {
		return this.extensionActive;
	}

	/**
	 * Fetch one run's evidence detail. Consumes the Part A `glyphspek.runs.detail` command,
	 * which returns AgentRunDetail | undefined. Handled gracefully:
	 *   - command unregistered (extension inactive) → executeCommand throws → undefined.
	 *   - backend returned undefined (unknown run) / a foreign/future-rev / malformed shape →
	 *     readDetail returns null → undefined (fail-closed; the pane shows "no evidence").
	 * It never throws; the caller renders the honest empty state on undefined.
	 */
	async getRunDetail(runId: string): Promise<AgentRunDetail | undefined> {
		let raw: unknown;
		try {
			raw = await this.commandService.executeCommand(DETAIL_COMMAND_ID, runId);
		} catch {
			// Command unregistered → extension not active in this window. No evidence.
			return undefined;
		}
		if (this._store.isDisposed) {
			return undefined;
		}
		return readDetail(raw) ?? undefined;
	}

	/**
	 * Start a governed run (Slice 3). Dispatches the existing `glyphspek.promoteChatToBuild`
	 * command with the typed task as the build-intent arg. A blank/whitespace title is passed
	 * as `undefined` so the command prompts for its own intent (never a silent no-op). We do
	 * NOT await the run's creation or return its id — the new run surfaces via the snapshot/
	 * revision pull (onDidChangeRuns). Errors (e.g. command unregistered) are swallowed: the
	 * caller already gates on isExtensionActive before enabling the composer, mirroring the
	 * existing startGovernedRun behavior.
	 */
	async startRun(intent: { title: string; workspace?: string }): Promise<void> {
		const title = intent.title.trim();
		try {
			await this.commandService.executeCommand(BUILD_COMMAND_ID, title.length > 0 ? title : undefined);
		} catch {
			// Command unregistered → extension not active. The composer is already disabled in
			// that state; swallow so a stale dispatch never throws into the UI.
		}
	}

	/**
	 * Poll the revision; re-fetch the snapshot only when it advanced (or on first run).
	 * Handles both commands being unregistered (extension not active) gracefully: the run
	 * list goes empty and isExtensionActive() reports false. A foreign/future-rev snapshot
	 * is dropped (empty list) but does NOT clear the extension-active flag — the extension
	 * is present, it just spoke a protocol we won't render.
	 */
	private async poll(): Promise<void> {
		if (this.polling || this._store.isDisposed) {
			return;
		}
		this.polling = true;
		try {
			let revision: unknown;
			try {
				revision = await this.commandService.executeCommand(REVISION_COMMAND_ID);
			} catch {
				// Command unregistered → extension not active. Reflect honestly + clear runs.
				this.onExtensionInactive();
				return;
			}
			if (this._store.isDisposed) {
				return;
			}
			if (typeof revision !== 'number') {
				// Present but unreadable: treat as active (the command exists) but do not
				// advance — we never fabricate a run set from a malformed signal.
				this.extensionActive = true;
				return;
			}
			this.extensionActive = true;
			if (revision === this.lastRevision) {
				return; // no change — skip the re-fetch.
			}

			let snapshotRaw: unknown;
			try {
				snapshotRaw = await this.commandService.executeCommand(SNAPSHOT_COMMAND_ID);
			} catch {
				this.onExtensionInactive();
				return;
			}
			if (this._store.isDisposed) {
				return;
			}
			const next = readSnapshot(snapshotRaw);
			// Advance our revision marker regardless: even a dropped (foreign-rev) snapshot
			// means we've reconciled against this revision, so we don't busy-refetch it.
			this.lastRevision = revision;
			// Fail-closed: an unrecognized snapshot renders as no runs (honest empty state),
			// never a fabricated placeholder.
			this.setRuns(next ?? []);
		} finally {
			this.polling = false;
		}
	}

	/** Reflect the extension being inactive: empty runs, flag false, reset revision marker. */
	private onExtensionInactive(): void {
		this.extensionActive = false;
		this.lastRevision = -1;
		this.setRuns([]);
	}

	/** Replace the run set and fire onDidChangeRuns only when it actually changed. */
	private setRuns(next: readonly AgentRun[]): void {
		if (!runsEqual(this.runs, next)) {
			this.runs = next;
			this._onDidChangeRuns.fire();
		}
	}
}

/** Shallow structural equality so a no-op poll never fires a spurious change event. */
function runsEqual(a: readonly AgentRun[], b: readonly AgentRun[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.id !== y.id || x.status !== y.status || x.closed !== y.closed
			|| x.posture !== y.posture || x.webviewVerified !== y.webviewVerified
			|| x.actorType !== y.actorType) {
			return false;
		}
	}
	return true;
}
