/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHSTUDIO GOVERNED TERMINAL — inline broker decision chips, PURE logic (no vscode /
 * no DOM imports — the floatingTerminalLogic.ts pure-module idiom).
 *
 * The fork renders the EXTENSION's per-command broker decision chip rows (fetched over
 * the `glyphstudio.governedTerminal.getCommandChips` command seam) as small xterm
 * decorations inline in the governed terminal's pty. This module owns the testable
 * logic: response-shape validation, chip-row matching (rows arrive NEWEST-first;
 * cross-checked via commandLine prefix match, ext-side capped at 120 chars), and the
 * decoration-model projection (glyph, kind class, hover text).
 *
 * HONESTY INVARIANTS (mirrors extension/src/terminalDecisionChips.ts):
 *   - Chip labels arrive ALREADY-honest from the extension (observe-only → 'observed';
 *     enforced decisions verbatim). This module NEVER maps a label — no euphemism, no
 *     laundering an observation into 'approved'/'blocked'.
 *   - A row whose every decision is observe-only carries observedOnly:true; its hover
 *     renders {@link OBSERVED_ONLY_MICROCOPY} VERBATIM. No enforcement is ever claimed
 *     for the soft plane.
 *   - Correlation is the extension's time-window heuristic, view-only; the matching
 *     here adds only a commandLine cross-check and confers no trust.
 */

/**
 * The governed-owned env marker (value = runId) the EXTENSION stamps into every
 * governed terminal's env — the Ctrl+Cmd+K floating terminal AND the ext-created panel
 * governed terminal/chat (uniform as of the inline-chips slice). Byte-for-byte mirror
 * of extension/src/governedFloatingTerminal.ts FLOATING_GOVERNED_TERMINAL_ENV_MARKER
 * (the fork cannot import the extension tree — the project's mirroring convention).
 */
export const GOVERNED_TERMINAL_ENV_MARKER = 'GLYPHSTUDIO_GOVERNED_FLOATING';

/**
 * The verbatim posture microcopy for a row whose EVERY correlated decision is
 * observe-only (mirror of the extension's OBSERVED_ONLY_MICROCOPY — test-pinned in
 * both realms). Rendered byte-exact; never 'approved'/'blocked' for an observation.
 */
export const OBSERVED_ONLY_MICROCOPY = 'observed (soft plane — not blocked)';

/** Ext-side command-line display cap (chars) — mirror of COMMAND_LINE_DISPLAY_CAP. */
export const CHIP_COMMAND_LINE_CAP = 120;

/** Ext-side label for a window whose command line was not surfaced (mirror). */
export const UNKNOWN_COMMAND_LABEL = '(unknown command)';

/**
 * One delayed re-fetch this long after a command finishes, to catch decisions the
 * extension correlates late (its chip store repaint debounces ~300ms). Decisions
 * arriving after this window appear only in the Trust Panel run view — an accepted,
 * honest residual of the inline surface.
 */
export const CHIPS_LATE_REFRESH_MS = 800;

/** One aggregated chip (mirror of the extension's DecisionChip). */
export interface ChipLike {
	readonly decision: string;
	readonly count: number;
}

/** One chip row (mirror of the extension's ChipRow — the RPC's row shape). */
export interface ChipRowLike {
	readonly commandLine: string;
	readonly startedAtIso: string;
	readonly exitCode?: number;
	readonly chips: readonly ChipLike[];
	readonly hosts: readonly string[];
	readonly hostOverflowCount: number;
	readonly observedOnly: boolean;
	readonly betweenCommands?: boolean;
}

/** Honest drop-oldest counters (mirror of the extension's DroppedCounts). */
export interface DroppedCountsLike {
	readonly decisions: number;
	readonly windows: number;
}

/** The `glyphstudio.governedTerminal.getCommandChips` response shape (mirror). */
export interface CommandChipsResponseLike {
	readonly rows: readonly ChipRowLike[];
	readonly dropped: DroppedCountsLike;
}

/**
 * Read the governed runId off a shell launch config env. Returns undefined unless the
 * marker is present with a non-empty string value (never guesses — an unmarked
 * terminal gets NO chips, by design).
 */
export function readGovernedRunId(env: { [key: string]: string | null | undefined } | undefined): string | undefined {
	const value = env?.[GOVERNED_TERMINAL_ENV_MARKER];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Validate the RPC response shape (the seam crosses the ext-host boundary — trust
 * nothing structurally). A malformed response yields undefined and the caller renders
 * NOTHING (degrade silently — never throws into the terminal).
 */
export function validateCommandChipsResponse(value: unknown): CommandChipsResponseLike | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const v = value as { rows?: unknown; dropped?: unknown };
	if (!Array.isArray(v.rows) || !v.dropped || typeof v.dropped !== 'object') {
		return undefined;
	}
	const dropped = v.dropped as { decisions?: unknown; windows?: unknown };
	if (typeof dropped.decisions !== 'number' || typeof dropped.windows !== 'number') {
		return undefined;
	}
	for (const row of v.rows) {
		const r = row as ChipRowLike;
		if (!r || typeof r !== 'object' || typeof r.commandLine !== 'string' || !Array.isArray(r.chips)
			|| !Array.isArray(r.hosts) || typeof r.hostOverflowCount !== 'number' || typeof r.observedOnly !== 'boolean') {
			return undefined;
		}
		for (const chip of r.chips) {
			if (!chip || typeof chip.decision !== 'string' || typeof chip.count !== 'number') {
				return undefined;
			}
		}
	}
	return value as CommandChipsResponseLike;
}

/**
 * Match a FINISHED command (the command-detection capability's command line) to its
 * chip row. Rows arrive NEWEST-first, so the first commandLine match wins — the
 * cross-check that the time-window row really is this command. Ext-side lines are
 * capped at {@link CHIP_COMMAND_LINE_CAP} chars + '…', so a truncated row matches by
 * prefix. Between-commands bucket rows never match (they are not a command).
 * No match → undefined (degrade silently; never decorate a guessed row).
 */
export function matchChipRow(rows: readonly ChipRowLike[], finishedCommandLine: string): ChipRowLike | undefined {
	const finished = (finishedCommandLine ?? '').trim();
	for (const row of rows) {
		if (row.betweenCommands) {
			continue;
		}
		const rowLine = row.commandLine.trim();
		if (rowLine === UNKNOWN_COMMAND_LABEL) {
			// The window surfaced no command line ext-side — only an equally-unknown
			// (empty) finished line may claim it; anything else would be a guess.
			if (finished.length === 0) {
				return row;
			}
			continue;
		}
		const truncated = rowLine.endsWith('…');
		const rowBase = truncated ? rowLine.slice(0, -1) : rowLine;
		if (rowBase.length === 0) {
			continue;
		}
		if (truncated ? finished.startsWith(rowBase) : finished === rowBase) {
			return row;
		}
	}
	return undefined;
}

/** Base CSS class every chip decoration element carries. */
export const CHIP_DECORATION_CLASS = 'glyphstudio-terminal-chips';

/** The kind classes (exactly one rides along with the base class). */
export const CHIP_KIND_CLASSES = {
	/** Every chip is the soft plane's 'observed' label — neutral, no posture claim. */
	observed: 'glyphstudio-terminal-chips-observed',
	/** At least one ask/deny — needs a look. */
	attention: 'glyphstudio-terminal-chips-attention',
	/** Enforced decisions without ask/deny (hard plane verbatim labels). */
	enforced: 'glyphstudio-terminal-chips-enforced',
} as const;

/** The decoration glyph — one small mark; the data lives in the hover. */
export const CHIP_GLYPH = '◆';

/** The projected decoration model the controller renders (pure data, no DOM). */
export interface ChipDecorationModel {
	readonly glyph: string;
	/** [base class, kind class]. */
	readonly classNames: readonly string[];
	/** Hover lines, top to bottom (joined with newlines for the hover body). */
	readonly hoverLines: readonly string[];
	readonly ariaLabel: string;
}

/**
 * Project one matched chip row into the decoration model. A row with NO chips
 * projects to undefined — nothing is rendered where nothing was recorded (no empty
 * badge implying a posture). Labels are passed through VERBATIM; an observedOnly row
 * appends {@link OBSERVED_ONLY_MICROCOPY} byte-exact.
 */
export function projectChipDecoration(row: ChipRowLike, dropped?: DroppedCountsLike): ChipDecorationModel | undefined {
	if (row.chips.length === 0) {
		return undefined;
	}
	const observedOnly = row.observedOnly;
	const attention = row.chips.some(c => c.decision === 'deny' || c.decision === 'ask');
	const kind = attention ? CHIP_KIND_CLASSES.attention : (observedOnly ? CHIP_KIND_CLASSES.observed : CHIP_KIND_CLASSES.enforced);

	const hoverLines: string[] = [];
	hoverLines.push(row.chips.map(c => `${c.count}× ${c.decision}`).join(' · '));
	if (row.hosts.length > 0) {
		const overflow = row.hostOverflowCount > 0 ? ` (+${row.hostOverflowCount} more)` : '';
		hoverLines.push(`hosts: ${row.hosts.join(', ')}${overflow}`);
	}
	if (observedOnly) {
		hoverLines.push(OBSERVED_ONLY_MICROCOPY);
	}
	if (dropped && (dropped.decisions > 0 || dropped.windows > 0)) {
		// Honest bound disclosure: oldest decisions/windows were dropped ext-side.
		hoverLines.push(`(oldest dropped: ${dropped.decisions} decisions, ${dropped.windows} commands)`);
	}

	return {
		glyph: CHIP_GLYPH,
		classNames: [CHIP_DECORATION_CLASS, kind],
		hoverLines,
		ariaLabel: `Broker decisions — ${hoverLines.join('; ')}`,
	};
}
