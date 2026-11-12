import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    RATE_LIMIT_RESET_CREDITS_ENDPOINT,
    SUMMARY_ENDPOINT,
} from '../constants.js';
import {UsageApiClient} from '../usageApi.js';

function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected))
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function setJsonResponse(message, statusCode, payload) {
    message.set_status(statusCode, null);
    message.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(JSON.stringify(payload)),
    );
}

const requestCounts = new Map();
const requestAccountIds = new Map();
const credentials = [];
const server = new Soup.Server();
server.add_handler(null, (_server, message, path) => {
    credentials.push({path,
        token: message.get_request_headers().get_one('Authorization'),
        accountId: message.get_request_headers().get_one('ChatGPT-Account-Id'),
    });
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    const accountIds = requestAccountIds.get(path) ?? [];
    accountIds.push(message.get_request_headers().get_one('ChatGPT-Account-Id'));
    requestAccountIds.set(path, accountIds);

    if (path === SUMMARY_ENDPOINT) {
        setJsonResponse(message, 200, {
            account_id: 'payload-account',
            rate_limit: {
                primary_window: {
                    used_percent: 25,
                    window_seconds: 5 * 60 * 60,
                },
            },
        });
        return;
    }

    if (path === RATE_LIMIT_RESET_CREDITS_ENDPOINT) {
        const accountId = message.get_request_headers().get_one('ChatGPT-Account-Id');
        if (accountId === 'payload-account' || accountId === 'auth-account') {
            setJsonResponse(message, 200, {
                available_count: 2,
                total_earned_count: 2,
                credits: [{
                    id: 'reset-1',
                    status: 'available',
                    expires_at: 2_000_000_000,
                }],
            });
            return;
        }

        setJsonResponse(message, 429, {
            message: 'Too many requests',
        });
        return;
    }

    setJsonResponse(message, 404, {
        message: 'Not found',
    });
});
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

const serverPort = server.get_uris()[0].get_port();
const apiBaseUrl = `http://127.0.0.1:${serverPort}`;
const client = new UsageApiClient({
    apiBaseUrl,
    proxyResolver: Gio.SimpleProxyResolver.new(null, null),
});
const loop = new GLib.MainLoop(null, false);
let testError = null;

Promise.resolve()
    .then(async () => {
        const fallbackSummary = await client.fetchSummary('test-token');
        assertEqual(fallbackSummary.rateLimitResetCredits?.availableCount, 2,
            'the usage payload account ID should authorize reset-credit data');
        assertEqual(requestAccountIds.get(SUMMARY_ENDPOINT)[0], null,
            'the usage request should omit an unavailable account ID');
        assertEqual(requestAccountIds.get(RATE_LIMIT_RESET_CREDITS_ENDPOINT)[0], 'payload-account',
            'the reset-credit request should fall back to the usage payload account ID');

        const authenticatedSummary = await client.fetchSummary('test-token', 'auth-account');
        assertEqual(authenticatedSummary.rateLimitResetCredits?.availableCount, 2,
            'the auth account ID should authorize reset-credit data');
        assertEqual(requestAccountIds.get(SUMMARY_ENDPOINT)[1], 'auth-account',
            'the usage request should send the auth account ID');
        assertEqual(requestAccountIds.get(RATE_LIMIT_RESET_CREDITS_ENDPOINT)[1], 'auth-account',
            'the reset-credit request should send the auth account ID');

        const rateLimitedSummary = await client.fetchSummary('test-token', 'rate-limited-account');
        assertEqual(rateLimitedSummary.primaryWindow?.percent, 0.25,
            'primary usage should survive a reset-credit rate limit');
        assertEqual(rateLimitedSummary.rateLimitResetCredits, null,
            'rate-limited reset credits should be treated as unavailable');
        assertEqual(requestCounts.get(SUMMARY_ENDPOINT), 3,
            'summary endpoint should be requested once per refresh');
        assertEqual(requestCounts.get(RATE_LIMIT_RESET_CREDITS_ENDPOINT), 3,
            'reset-credit endpoint should be requested once per refresh');

        const start = credentials.length;
        await Promise.all([
            client.fetchSummary('first-token', 'auth-account'),
            client.fetchSummary('second-token', 'payload-account'),
        ]);
        assertEqual(credentials.length - start, 4, 'two accounts should each fetch usage and reset credits');
        for (const request of credentials.slice(start)) {
            assertEqual(request.token, request.accountId === 'auth-account' ? 'Bearer first-token' : 'Bearer second-token',
                'concurrent requests must keep each token paired with its account ID');
        }
        const cancellable = new Gio.Cancellable();
        cancellable.cancel();
        let cancelled = false;
        try {
            await client.fetchSummary('cancelled-token', 'auth-account', cancellable);
        } catch (error) {
            cancelled = error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
        }
        assertEqual(cancelled, true, 'cancellation must propagate to HTTP requests');
        const stillWorking = await client.fetchSummary('remaining-token', 'payload-account');
        assertEqual(stillWorking.primaryWindow?.percent, 0.25,
            'cancelling one account must leave the shared client usable');
    })
    .catch(error => {
        testError = error;
    })
    .finally(() => {
        loop.quit();
    });

loop.run();
client.destroy();
server.disconnect();

if (testError)
    throw testError;

print('usageApi HTTP tests passed');
