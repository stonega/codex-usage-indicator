import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    API_BASE_URL,
    PRIMARY_WINDOW_HOURS,
    SUMMARY_ENDPOINT,
    WEEK_WINDOW_DAYS,
} from './constants.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const SUMMARY_PATH_HINTS = [
    ['total_tokens_used', 'total_tokens_limit'],
    ['used_tokens', 'token_limit'],
    ['tokens_used', 'token_limit'],
    ['used', 'limit'],
    ['usage', 'limit'],
    ['consumed', 'quota'],
];

const NUMBER_KEYS = [
    'total_tokens_used',
    'used_tokens',
    'tokens_used',
    'used',
    'usage',
    'consumed',
    'count',
    'value',
    'total',
];

const LIMIT_KEYS = [
    'total_tokens_limit',
    'token_limit',
    'limit',
    'quota',
    'max',
    'capacity',
];

const PERCENT_KEYS = [
    'percent',
    'percentage',
    'usage_percent',
    'percent_used',
    'utilization',
];

export class UsageApiError extends Error {
    constructor(message, {statusCode = 0, payload = null} = {}) {
        super(message);
        this.name = 'UsageApiError';
        this.statusCode = statusCode;
        this.payload = payload;
    }

    get isAuthError() {
        return this.statusCode === 401 || this.statusCode === 403;
    }
}

export class UsageApiClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 30,
        });
    }

    async fetchSummary(token) {
        const payload = await this._getJson(SUMMARY_ENDPOINT, token);
        return normalizeSummary(payload);
    }

    destroy() {
        this._session.abort();
    }

    async _getJson(path, token) {
        if (!token?.trim())
            throw new UsageApiError('A bearer token is required.');

        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Authorization', `Bearer ${token.trim()}`);
        headers.append('Referer', 'https://chatgpt.com/codex/settings/usage');
        headers.append('oai-language', 'en-US');
        headers.append('x-openai-target-path', path);
        headers.append('x-openai-target-route', path);

        const bytes = await this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
        );

        const statusCode = message.get_status();
        const body = decodeBytes(bytes);
        let payload = null;

        try {
            payload = body ? JSON.parse(body) : null;
        } catch (error) {
            throw new UsageApiError(`The server returned invalid JSON for ${path}.`, {
                statusCode,
            });
        }

        if (statusCode < 200 || statusCode >= 300) {
            const messageText = payload?.message || payload?.error || `Request failed with HTTP ${statusCode}.`;
            throw new UsageApiError(messageText, {statusCode, payload});
        }

        return payload;
    }
}

export function decodeBytes(bytes) {
    const data = bytes?.toArray?.() ?? bytes?.get_data?.() ?? [];
    return new TextDecoder().decode(data);
}

export function normalizeSummary(payload) {
    const windows = normalizeRateLimitWindows(payload);
    const primaryWindow = findPrimaryWindow(windows);
    const weekWindow = findWeekWindow(windows);
    const activeWindow = primaryWindow ?? weekWindow ?? windows[0] ?? null;

    let used = null;
    let limit = null;
    for (const [usedKey, limitKey] of SUMMARY_PATH_HINTS) {
        used = findNumberByKey(payload, usedKey);
        limit = findNumberByKey(payload, limitKey);
        if (used !== null && limit !== null)
            break;
    }

    if (used === null || limit === null) {
        used = activeWindow?.used ?? findFirstNumber(payload, NUMBER_KEYS);
        limit = activeWindow?.limit ?? findFirstNumber(payload, LIMIT_KEYS);
    }

    const percent = normalizePercent(
        activeWindow?.percent ?? findFirstNumber(payload, PERCENT_KEYS),
        used,
        limit,
    );
    const left = used !== null && limit !== null ? Math.max(limit - used, 0) : null;

    return {
        used,
        limit,
        left,
        percent,
        leftPercent: percent !== null ? Math.max(1 - percent, 0) : null,
        resetAt: activeWindow?.resetAt ?? null,
        resetAfterSeconds: activeWindow?.resetAfterSeconds ?? null,
        planType: findFirstString(payload, ['plan_type']),
        windows,
        primaryWindow,
        weekWindow,
        raw: payload,
    };
}

function normalizeRateLimitWindows(payload) {
    const windows = [];
    collectRateLimitWindows(payload, [], windows);

    const deduped = [];
    for (const window of windows) {
        const duplicate = deduped.some(candidate =>
            candidate.windowSeconds === window.windowSeconds &&
            candidate.percent === window.percent &&
            candidate.used === window.used &&
            candidate.limit === window.limit &&
            candidate.resetAt === window.resetAt &&
            candidate.resetAfterSeconds === window.resetAfterSeconds
        );
        if (!duplicate)
            deduped.push(window);
    }

    return deduped.sort((left, right) => {
        const leftSeconds = left.windowSeconds ?? Number.MAX_SAFE_INTEGER;
        const rightSeconds = right.windowSeconds ?? Number.MAX_SAFE_INTEGER;
        return leftSeconds - rightSeconds;
    });
}

function collectRateLimitWindows(value, path, output) {
    if (!value || typeof value !== 'object')
        return;

    if (Array.isArray(value)) {
        for (const item of value)
            collectRateLimitWindows(item, path, output);
        return;
    }

    const normalized = normalizeRateLimitWindow(value, path);
    if (normalized)
        output.push(normalized);

    for (const [key, nested] of Object.entries(value))
        collectRateLimitWindows(nested, [...path, key], output);
}

function normalizeRateLimitWindow(value, path) {
    const used = findLocalFirstNumber(value, NUMBER_KEYS);
    const limit = findLocalFirstNumber(value, LIMIT_KEYS);
    const percent = normalizePercent(findLocalFirstNumber(value, PERCENT_KEYS), used, limit);
    const resetAt = coerceNumber(findLocalValueByKey(value, 'reset_at'));
    const resetAfterSeconds = coerceNumber(findLocalValueByKey(value, 'reset_after_seconds'));
    const windowSeconds = findWindowSeconds(value, resetAfterSeconds);
    const pathHint = path.some(segment => /window|rate_limit/i.test(segment));

    if (percent === null && (used === null || limit === null))
        return null;

    if (windowSeconds === null && resetAt === null && resetAfterSeconds === null && !pathHint)
        return null;

    return {
        id: path.join('.') || 'window',
        label: inferWindowLabel(value, path, windowSeconds),
        used,
        limit,
        left: used !== null && limit !== null ? Math.max(limit - used, 0) : null,
        percent,
        leftPercent: percent !== null ? Math.max(1 - percent, 0) : null,
        resetAt,
        resetAfterSeconds,
        windowSeconds,
    };
}

function findPrimaryWindow(windows) {
    const targetSeconds = PRIMARY_WINDOW_HOURS * 3600;
    return findWindowByDuration(windows, targetSeconds, 2 * 3600)
        ?? windows.find(window => /(^| )5h( |$)|primary/i.test(window.label ?? ''))
        ?? null;
}

function findWeekWindow(windows) {
    const targetSeconds = WEEK_WINDOW_DAYS * 86400;
    return findWindowByDuration(windows, targetSeconds, 86400)
        ?? windows.find(window => /week|7d/i.test(window.label ?? ''))
        ?? null;
}

function findWindowByDuration(windows, targetSeconds, toleranceSeconds) {
    return windows.find(window =>
        window.windowSeconds !== null &&
        Math.abs(window.windowSeconds - targetSeconds) <= toleranceSeconds
    ) ?? null;
}

function findWindowSeconds(value, resetAfterSeconds) {
    const seconds = findLocalFirstNumber(value, [
        'window_seconds',
        'duration_seconds',
    ]);
    if (seconds !== null)
        return seconds;

    const minutes = findLocalFirstNumber(value, [
        'window_minutes',
        'duration_minutes',
        'window_mins',
    ]);
    if (minutes !== null)
        return minutes * 60;

    const hours = findLocalFirstNumber(value, ['window_hours', 'duration_hours']);
    if (hours !== null)
        return hours * 3600;

    const days = findLocalFirstNumber(value, ['window_days', 'duration_days']);
    if (days !== null)
        return days * 86400;

    if (resetAfterSeconds !== null)
        return resetAfterSeconds;

    return null;
}

function inferWindowLabel(value, path, windowSeconds) {
    const explicitLabel = findLocalFirstString(value, ['label', 'name', 'window_name', 'title']);
    if (explicitLabel)
        return explicitLabel;

    if (windowSeconds !== null)
        return formatWindowDuration(windowSeconds);

    const lastSegment = path[path.length - 1];
    if (lastSegment)
        return lastSegment.replaceAll('_', ' ');

    return 'Window';
}

function formatWindowDuration(windowSeconds) {
    const hours = windowSeconds / 3600;
    const days = windowSeconds / 86400;

    if (Math.abs(hours - PRIMARY_WINDOW_HOURS) < 0.01)
        return '5h';

    if (Math.abs(days - WEEK_WINDOW_DAYS) < 0.01)
        return 'Week';

    if (days >= 1 && Number.isInteger(days))
        return `${days}d`;

    if (hours >= 1 && Number.isInteger(hours))
        return `${hours}h`;

    return `${Math.round(windowSeconds / 60)}m`;
}

function findLocalFirstNumber(value, keys) {
    for (const key of keys) {
        const number = coerceNumber(findLocalValueByKey(value, key));
        if (number !== null)
            return number;
    }

    return null;
}

function findLocalFirstString(value, keys) {
    for (const key of keys) {
        const found = findLocalValueByKey(value, key);
        if (typeof found === 'string' && found.trim())
            return found.trim();
    }

    return null;
}

function findLocalValueByKey(value, targetKey) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;

    if (!Object.prototype.hasOwnProperty.call(value, targetKey))
        return null;

    return value[targetKey];
}

function findFirstNumber(value, keys) {
    for (const key of keys) {
        const number = findNumberByKey(value, key);
        if (number !== null)
            return number;
    }

    return null;
}

function findNumberByKey(value, targetKey) {
    const found = findValueByKey(value, targetKey);
    return coerceNumber(found);
}

function findFirstString(value, keys) {
    for (const key of keys) {
        const found = findValueByKey(value, key);
        if (typeof found === 'string' && found.trim())
            return found.trim();
    }

    return null;
}

function findValueByKey(value, targetKey) {
    if (!value || typeof value !== 'object')
        return null;

    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findValueByKey(item, targetKey);
            if (found !== null)
                return found;
        }
        return null;
    }

    for (const [key, nested] of Object.entries(value)) {
        if (key === targetKey)
            return nested;

        const found = findValueByKey(nested, targetKey);
        if (found !== null)
            return found;
    }

    return null;
}

function coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;

    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed))
            return parsed;
    }

    return null;
}

function normalizePercent(percent, used, limit) {
    if (percent !== null) {
        if (percent > 1)
            return percent / 100;
        return percent;
    }

    if (used !== null && limit !== null && limit > 0)
        return used / limit;

    return null;
}
