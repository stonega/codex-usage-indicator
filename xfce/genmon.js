#!/usr/bin/env -S gjs -m

// One-shot Xfce panel adapter. It shares the GNOME extension's auth reader and
// API normalizer, without importing GNOME Shell or reading browser cookies.
import {loadCodexCliAuth, CodexCliAuthError} from '../codexAuth.js';
import {UsageApiClient, UsageApiError} from '../usageApi.js';
import {renderGenmon, renderGenmonError} from './format.mjs';
import {fetchPanelSummary} from './runner.mjs';

function parseOptions(args) {
    const options = {label: 'Codex', mode: 'left'};
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--used') options.mode = 'used';
        else if ((arg === '--auth-file' || arg === '--label') && args[index + 1]) {
            options[arg === '--auth-file' ? 'authFile' : 'label'] = args[++index];
        } else if (arg === '--help') return null;
        else throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    return options;
}

function safeError(error) {
    if (error instanceof CodexCliAuthError) return 'Codex CLI login required; check the auth file or run codex login.';
    if (error instanceof UsageApiError) {
        if (error.isAuthError) return 'Codex login expired; run codex login again.';
        if (error.statusCode === 429) return 'Usage API rate-limited; retry at the next refresh.';
        return `Usage API unavailable (HTTP ${error.statusCode || '?'})`;
    }
    return 'Usage unavailable; check network and panel command.';
}

let options;
try {
    options = parseOptions(ARGV);
} catch (error) {
    print(renderGenmonError(error.message));
}
if (options === null) {
    print('Usage: gjs -m xfce/genmon.js [--auth-file /path/to/auth.json] [--label NAME] [--used]');
} else if (options) {
    try {
        const summary = await fetchPanelSummary(options, loadCodexCliAuth, () => new UsageApiClient());
        print(renderGenmon(summary, options));
    } catch (error) {
        // A panel display must never print the bearer token or raw API payload.
        print(renderGenmonError(safeError(error), options));
    }
}
