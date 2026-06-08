"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectGlobalScopedTrustKeys = selectGlobalScopedTrustKeys;
exports.selectSupervisorPath = selectSupervisorPath;
exports.selectGlobalScopedBool = selectGlobalScopedBool;
exports.classifyPolicyPath = classifyPolicyPath;
exports.resolveDefaultPolicyCandidate = resolveDefaultPolicyCandidate;
/*
 * Configuration-scope trust filters (pure; NO vscode dependency).
 *
 * Lives in its own module so it can be unit-tested under plain node:test against
 * the compiled dist/ output without requiring the `vscode` host module. The
 * extension host imports the pure functions here and supplies the live
 * getConfiguration(...).inspect(...) result.
 *
 * The threat these functions defend against (sweep-07 Criticals): VS Code's
 * getConfiguration().get() MERGES values across scopes — default < user/global <
 * workspace < workspace-folder. A repository can therefore ship a
 * .vscode/settings.json that supplies its OWN value for a security-load-bearing
 * setting and have it silently win. Two settings are dangerous:
 *   - glyphstudio.trustedVerifierKeys — a repo-supplied key would let a bundle's
 *     verdict reach AUTHORITATIVE under a key the operator never provisioned.
 *   - glyphstudio.supervisorPath — a repo-supplied path would redirect the spawned,
 *     --import tsx supervisor exec to attacker code AND expose the verifier
 *     private key handed to it (RCE + key exfiltration).
 *
 * The durable fix is `"scope": "machine"` in package.json (VS Code then refuses
 * workspace/folder values for these keys). These functions are defense in depth:
 * even if a build ships without the machine scope, the host only ever consumes
 * the default/global (and out-of-band keystore) values, never workspace ones.
 */
const path = __importStar(require("node:path"));
/**
 * Select the trusted-verifier-key set, accepting ONLY operator-controlled
 * scopes: the setting's default value and the user/global value. Workspace and
 * workspace-folder values are deliberately EXCLUDED — a repo must never be able
 * to inject a trust root and reach AUTHORITATIVE.
 *
 * The keystore public key (~/.glyphstudio/verifier/public.pem) is appended when
 * present: it is machine-local, provisioned out-of-band by this extension, and
 * is NOT workspace-controlled, so it is always a legitimate trust root for runs
 * launched from here.
 *
 * @param inspect           getConfiguration('glyphstudio').inspect('trustedVerifierKeys')
 * @param keystorePublicKeyPem  the keystore SPKI PEM, or undefined when absent
 * @returns the de-duplicated, order-preserving global-scoped trust-root set
 */
function selectGlobalScopedTrustKeys(inspect, keystorePublicKeyPem) {
    const keys = [];
    const pushAll = (value) => {
        if (Array.isArray(value)) {
            for (const k of value) {
                if (typeof k === 'string')
                    keys.push(k);
            }
        }
    };
    // Operator-controlled scopes ONLY. NOTE the deliberate omission of
    // workspaceValue and workspaceFolderValue: a repository cannot contribute a
    // verifier trust root.
    pushAll(inspect?.defaultValue);
    pushAll(inspect?.globalValue);
    if (typeof keystorePublicKeyPem === 'string' && keystorePublicKeyPem.length) {
        keys.push(keystorePublicKeyPem);
    }
    // De-duplicate while preserving first-seen order.
    return [...new Set(keys)];
}
/**
 * Resolve the supervisor exec path from an inspect() result, accepting ONLY
 * operator-controlled scopes: globalValue ?? defaultValue. Workspace and
 * workspace-folder values are IGNORED (and flagged) so a repo can never redirect
 * the spawned supervisor process.
 *
 * The durable answer is bundling/pinning the supervisor inside the self-contained
 * .vsix; until then this is the dev bridge and the machine-scope + global-only
 * resolution keeps it from being workspace-hijacked.
 */
function selectSupervisorPath(inspect) {
    const global = typeof inspect?.globalValue === 'string' ? inspect.globalValue : undefined;
    const fallback = typeof inspect?.defaultValue === 'string' ? inspect.defaultValue : '';
    const fromWorkspaceIgnored = (typeof inspect?.workspaceValue === 'string' && inspect.workspaceValue.length > 0) ||
        (typeof inspect?.workspaceFolderValue === 'string' && inspect.workspaceFolderValue.length > 0);
    return {
        path: (global ?? fallback) || '',
        fromWorkspaceIgnored,
    };
}
/**
 * Select a security-load-bearing BOOLEAN flag from an inspect() result,
 * accepting ONLY operator-controlled scopes: the setting's default value and the
 * user/global value. Workspace and workspace-folder values are deliberately
 * IGNORED — a repo's .vscode/settings.json must never be able to flip this flag
 * on (mirrors selectSupervisorPath / selectGlobalScopedTrustKeys).
 *
 * Used for glyphstudio.devSupervisorTrustKey: the gate that hands the verifier
 * PRIVATE key to the un-pinned dev supervisor. A repo-supplied `true` here (when
 * a global dev supervisorPath is set) would leak the signing key to attacker
 * code, so workspace scopes cannot enable it. Combined with `"scope": "machine"`
 * in package.json this is defense in depth.
 *
 * Returns `false` unless a global (else default) value is explicitly the boolean
 * `true`. Any non-boolean, undefined, or workspace-only value resolves to the
 * `fallback` (default `false`).
 *
 * @param inspect   getConfiguration('glyphstudio').inspect('devSupervisorTrustKey')
 * @param fallback  the value to return when no global/default boolean is present
 * @returns the global/default-scoped boolean, never a workspace/folder value
 */
function selectGlobalScopedBool(inspect, fallback = false) {
    // Operator-controlled scopes ONLY: global wins over default. NOTE the
    // deliberate omission of workspaceValue and workspaceFolderValue — a repo
    // cannot enable this flag.
    if (typeof inspect?.globalValue === 'boolean')
        return inspect.globalValue;
    if (typeof inspect?.defaultValue === 'boolean')
        return inspect.defaultValue;
    return fallback;
}
/**
 * Classify the `glyphstudio.policyPath` setting from an inspect() result, in VS
 * Code's effective-source precedence: workspace-folder > workspace > global >
 * default. The first scope supplying a non-empty string wins, and its label is
 * returned alongside the value.
 *
 * This deliberately DIFFERS from selectSupervisorPath()/selectGlobalScopedTrustKeys():
 * a policy is policy-as-code, so a repo-local (.vscode/settings.json) policy is a
 * legitimate selection — NOT something to ignore. The point of classifying is
 * PROVENANCE: when the effective scope is 'workspace' or 'workspaceFolder', the
 * caller can name the repo-provided policy file (and its sha256) and require
 * operator confirmation, rather than silently running under a setting the repo
 * supplied.
 *
 * @param inspect getConfiguration('glyphstudio').inspect('policyPath')
 * @returns the effective non-empty path and the scope it was sourced from, or
 *          { path: '', scope: 'none' } when no scope supplies a value.
 */
function classifyPolicyPath(inspect) {
    const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    const folder = nonEmpty(inspect?.workspaceFolderValue);
    if (folder !== undefined)
        return { path: folder, scope: 'workspaceFolder' };
    const workspace = nonEmpty(inspect?.workspaceValue);
    if (workspace !== undefined)
        return { path: workspace, scope: 'workspace' };
    const global = nonEmpty(inspect?.globalValue);
    if (global !== undefined)
        return { path: global, scope: 'global' };
    const def = nonEmpty(inspect?.defaultValue);
    if (def !== undefined)
        return { path: def, scope: 'default' };
    return { path: '', scope: 'none' };
}
/**
 * Decide the policy picker's DEFAULT candidate (pure & unit-testable; sweep-15
 * Medium). The bundled capstone fixture lives ONLY under the dev supervisor's
 * spikes tree, so it is offered as the picker default ONLY when (a) a real dev
 * supervisorPath is configured AND (b) the fixture file actually exists.
 *
 * On the BUNDLED path the supervisorPath is empty, so this returns undefined and
 * the picker has NO preset default. That is what lets a CANCELLED picker resolve
 * cleanly to undefined upstream (a clean run abort) instead of falling through to
 * a relative '.glyphstudio-fixtures/capstone-policy.json' that would resolve
 * against the host cwd — which is neither a real policy nor an operator choice.
 *
 * @param supervisorPath the resolved dev supervisor root ('' on the bundled path)
 * @param existsFn        an fs.existsSync-shaped probe (injected so tests need no
 *                        real files)
 * @returns the absolute capstone-fixture path when it exists, else undefined
 */
function resolveDefaultPolicyCandidate(supervisorPath, existsFn) {
    if (typeof supervisorPath !== 'string' || supervisorPath.trim().length === 0) {
        return undefined;
    }
    const candidate = path.join(supervisorPath, '.glyphstudio-fixtures', 'capstone-policy.json');
    return existsFn(candidate) ? candidate : undefined;
}
//# sourceMappingURL=configScope.js.map