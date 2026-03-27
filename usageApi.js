import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {
    API_BASE_URL,
    BREAKDOWN_DAYS,
    BREAKDOWN_ENDPOINT,
    SUMMARY_ENDPOINT,
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

const DATE_KEYS = [
    'date',
    'day',
    'bucket',
    'bucket_start',
    'period_start',
    'start_date',
];

const DETAIL_KEYS = [
    'breakdown',
    'details',
    'models',
    'by_model',
    'categories',
    'by_category',
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

    async fetchDailyBreakdown(token) {
        const payload = await this._getJson(BREAKDOWN_ENDPOINT, token);
        return normalizeDailyBreakdown(payload).slice(0, BREAKDOWN_DAYS);
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
    const rateLimitSummary = normalizeRateLimitSummary(payload);
    if (rateLimitSummary)
        return rateLimitSummary;

    for (const [usedKey, limitKey] of SUMMARY_PATH_HINTS) {
        const used = findNumberByKey(payload, usedKey);
        const limit = findNumberByKey(payload, limitKey);
        if (used !== null && limit !== null) {
            return {
                used,
                limit,
                percent: limit > 0 ? used / limit : null,
                raw: payload,
            };
        }
    }

    const used = findFirstNumber(payload, NUMBER_KEYS);
    const limit = findFirstNumber(payload, LIMIT_KEYS);
    const percent = findFirstNumber(payload, PERCENT_KEYS);

    return {
        used,
        limit,
        percent: normalizePercent(percent, used, limit),
        resetAt: null,
        resetAfterSeconds: null,
        planType: findFirstString(payload, ['plan_type']),
        raw: payload,
    };
}

function normalizeRateLimitSummary(payload) {
    const primaryWindow = payload?.rate_limit?.primary_window;
    const usedPercent = coerceNumber(primaryWindow?.used_percent);
    if (usedPercent === null)
        return null;

    return {
        used: null,
        limit: null,
        percent: normalizePercent(usedPercent, null, null),
        resetAt: coerceNumber(primaryWindow?.reset_at),
        resetAfterSeconds: coerceNumber(primaryWindow?.reset_after_seconds),
        planType: findFirstString(payload, ['plan_type']),
        raw: payload,
    };
}

export function normalizeDailyBreakdown(payload) {
    const candidateArrays = collectCandidateArrays(payload);
    const normalized = [];

    for (const array of candidateArrays) {
        for (const item of array) {
            const normalizedItem = normalizeDailyEntry(item);
            if (normalizedItem)
                normalized.push(normalizedItem);
        }

        if (normalized.length > 0)
            break;
    }

    return normalized
        .sort((left, right) => right.date.localeCompare(left.date));
}

function normalizeDailyEntry(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return null;

    const surfaceValues = normalizeSurfaceUsageValues(item.product_surface_usage_values);
    if (surfaceValues) {
        return {
            date: item.date?.trim?.() ?? null,
            total: sumObjectValues(surfaceValues),
            details: surfaceValues,
            raw: item,
        };
    }

    const date = findFirstString(item, DATE_KEYS) ?? normalizeDateGuess(item);
    const total = findFirstNumber(item, NUMBER_KEYS) ?? findFirstNumber(item, ['tokens']);
    if (!date || total === null)
        return null;

    const details = findDetails(item);
    return {
        date,
        total,
        details,
        raw: item,
    };
}

function findDetails(item) {
    for (const key of DETAIL_KEYS) {
        const value = findValueByKey(item, key);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const entries = Object.entries(value)
                .map(([name, rawValue]) => [name, coerceNumber(rawValue)])
                .filter(([, amount]) => amount !== null);
            if (entries.length > 0)
                return Object.fromEntries(entries);
        }
    }

    return null;
}

function collectCandidateArrays(value) {
    const arrays = [];

    if (Array.isArray(value)) {
        arrays.push(value);
        return arrays;
    }

    if (!value || typeof value !== 'object')
        return arrays;

    for (const nested of Object.values(value)) {
        arrays.push(...collectCandidateArrays(nested));
    }

    return arrays;
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

function normalizeDateGuess(item) {
    for (const value of Object.values(item)) {
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed))
            return trimmed.slice(0, 10);
    }

    return null;
}

function normalizeSurfaceUsageValues(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;

    const entries = Object.entries(value)
        .map(([name, rawValue]) => [name, coerceNumber(rawValue)])
        .filter(([, amount]) => amount !== null);

    if (entries.length === 0)
        return null;

    return Object.fromEntries(entries);
}

function sumObjectValues(value) {
    return Object.values(value).reduce((sum, amount) => sum + amount, 0);
}
