import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {UsageApiError} from './usageApi.js';

export function formatUsageError(error, gettext = message => message) {
    if (error instanceof UsageApiError && error.isAuthError)
        return gettext('Codex CLI token was rejected. Run codex login.');

    if (error instanceof GLib.Error &&
        error.matches(Gio.TlsError, Gio.TlsError.BAD_CERTIFICATE)) {
        return gettext('TLS certificate verification failed. Check your network proxy, system clock, and trusted certificates.');
    }

    // Gio async operations reject with GLib.Error, which is not a JS Error.
    if (error instanceof Error || error instanceof GLib.Error) {
        if (typeof error.message === 'string' && error.message.trim())
            return error.message.trim();
    }

    return gettext('Unknown error');
}
