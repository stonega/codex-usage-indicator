import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CodexCliAuthError} from '../codexAuth.js';
import {UsageApiError} from '../usageApi.js';
import {formatUsageError} from '../usageError.js';

function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected))
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const certificateError = new Gio.TlsError({
    code: Gio.TlsError.BAD_CERTIFICATE,
    message: 'Unacceptable TLS certificate',
});
assertEqual(certificateError instanceof Error, false,
    'the regression must exercise a native error outside the JS Error hierarchy');
assertEqual(certificateError instanceof GLib.Error, true,
    'the regression must exercise a real GLib.Error');
assertEqual(formatUsageError(certificateError),
    'TLS certificate verification failed. Check your network proxy, system clock, and trusted certificates.',
    'certificate failures should explain the connection problem');

const networkError = new Gio.IOErrorEnum({
    code: Gio.IOErrorEnum.TIMED_OUT,
    message: 'Socket I/O timed out',
});
assertEqual(formatUsageError(networkError), 'Socket I/O timed out',
    'native network errors should preserve their message');
assertEqual(formatUsageError(new Gio.TlsError({
    code: Gio.TlsError.EOF,
    message: 'TLS connection closed unexpectedly',
})), 'TLS connection closed unexpectedly',
'other TLS errors should preserve their specific message');

assertEqual(formatUsageError(new Error('The server returned invalid JSON.')),
    'The server returned invalid JSON.', 'JS errors should preserve their message');
assertEqual(formatUsageError(new CodexCliAuthError('Codex CLI token is expired.')),
    'Codex CLI token is expired.', 'local authentication errors should keep their guidance');
for (const statusCode of [401, 403]) {
    assertEqual(formatUsageError(new UsageApiError('Unauthorized', {statusCode})),
        'Codex CLI token was rejected. Run codex login.',
        `HTTP ${statusCode} should retain login guidance`);
}
assertEqual(formatUsageError(new UsageApiError('Too many requests', {statusCode: 429})),
    'Too many requests', 'other API failures should preserve their message');
assertEqual(formatUsageError(certificateError, message => `translated: ${message}`),
    'translated: TLS certificate verification failed. Check your network proxy, system clock, and trusted certificates.',
    'shared error guidance should use the caller’s translation function');
for (const error of [null, undefined, {}, new Error('')]) {
    assertEqual(formatUsageError(error), 'Unknown error',
        'errors without a usable message should have a nonempty fallback');
}

print('usageError tests passed');
