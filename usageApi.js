import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {
    API_BASE_URL,
    PRIMARY_WINDOW_HOURS,
    RATE_LIMIT_RESET_CREDITS_ENDPOINT,
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
    'used_percent',
    'percent',
    'percentage',
    'usage_percent',
    'percent_used',
    'utilization',
];

const WHAM_REFERER = `${API_BASE_URL}/codex/cloud/settings/analytics`;

export class UsageApiError extends Error {
    constructor(message, {statusCode = 0, payload = null} = {}) {
        super(String(message));
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
        const [payload, resetCreditsPayload] = await Promise.all([
            this._getJson(SUMMARY_ENDPOINT, token),
            this._getJson(RATE_LIMIT_RESET_CREDITS_ENDPOINT, token),
        ]);
        return normalizeSummary(payload, resetCreditsPayload);
    }

    destroy() {
        this._session.abort();
    }

    async _getJson(path, token) {
        const normalizedToken = normalizeBearerToken(token ?? '');
        if (!normalizedToken)
            throw new UsageApiError('A bearer token is required.');

        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', '*/*');
        headers.append('Authorization', `Bearer ${normalizedToken}`);
        headers.append('Cache-Control', 'no-cache');
        headers.append('Pragma', 'no-cache');
        headers.append('Referer', path.startsWith('/backend-api/wham/') ? WHAM_REFERER : API_BASE_URL);
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
            const messageText = getErrorMessage(payload, statusCode);
            throw new UsageApiError(messageText, {statusCode, payload});
        }

        return payload;
    }
}

export function decodeBytes(bytes) {
    const data = bytes?.toArray?.() ?? bytes?.get_data?.() ?? [];
    return new TextDecoder().decode(data);
}

function getErrorMessage(payload, statusCode) {
    for (const value of [
        payload?.message,
        payload?.error,
        payload?.detail,
        payload?.title,
    ]) {
        const message = normalizeErrorMessage(value);
        if (message)
            return message;
    }

    return `Request failed with HTTP ${statusCode}.`;
}

function normalizeErrorMessage(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();

    if (!value || typeof value !== 'object')
        return '';

    for (const key of ['message', 'detail', 'title', 'code', 'type']) {
        const nested = normalizeErrorMessage(value[key]);
        if (nested)
            return nested;
    }

    return '';
}

export function normalizeSummary(payload, resetCreditsPayload = null) {
    const rateLimit = normalizeRateLimitSection(payload?.rate_limit, 'rate_limit');
    const codeReviewRateLimit = normalizeRateLimitSection(
        payload?.code_review_rate_limit,
        'code_review_rate_limit',
    );
    const additionalRateLimits = normalizeAdditionalRateLimits(payload?.additional_rate_limits);
    const usageRateLimit = selectUsageRateLimit(rateLimit, additionalRateLimits);
    const summaryRateLimit = rateLimit ?? usageRateLimit;

    const windows = normalizeRateLimitWindows(payload);
    const usageWindows = summaryRateLimit?.windows?.length > 0
        ? summaryRateLimit.windows
        : selectUsageWindows(windows);
    const primaryWindow = summaryRateLimit?.primaryWindow ?? findPrimaryWindow(usageWindows);
    const weekWindow = summaryRateLimit?.secondaryWindow ?? findWeekWindow(usageWindows);
    const activeWindow = primaryWindow ?? weekWindow ?? usageWindows[0] ?? null;
    const metricSources = getUsageMetricSources(payload, summaryRateLimit);

    let {used, limit} = findSummaryTotals(metricSources);

    if (used === null || limit === null) {
        used = activeWindow?.used ?? findFirstNumberInSources(metricSources, NUMBER_KEYS);
        limit = activeWindow?.limit ?? findFirstNumberInSources(metricSources, LIMIT_KEYS);
    }

    const percent = normalizePercent(
        activeWindow?.percent ?? findFirstNumberInSources(metricSources, PERCENT_KEYS),
        used,
        limit,
    );
    const left = used !== null && limit !== null ? Math.max(limit - used, 0) : null;

    return {
        userId: findFirstString(payload, ['user_id', 'id']),
        accountId: findFirstString(payload, ['account_id']),
        email: findFirstString(payload, ['email']),
        used,
        limit,
        left,
        percent,
        leftPercent: percent !== null ? Math.max(1 - percent, 0) : null,
        resetAt: activeWindow?.resetAt ?? null,
        resetAfterSeconds: activeWindow?.resetAfterSeconds ?? null,
        planType: findFirstString(payload, ['plan_type']),
        windows: usageWindows,
        primaryWindow,
        weekWindow,
        summaryRateLimit,
        usageRateLimit,
        limitName: summaryRateLimit?.limitName ?? null,
        meteredFeature: summaryRateLimit?.meteredFeature ?? null,
        rateLimit,
        codeReviewRateLimit,
        additionalRateLimits,
        credits: normalizeCredits(payload?.credits),
        rateLimitResetCredits: normalizeRateLimitResetCredits(
            resetCreditsPayload ?? payload?.rate_limit_reset_credits,
        ),
        spendControl: normalizeSpendControl(payload?.spend_control),
        promo: payload?.promo ?? null,
        raw: payload,
    };
}

function getUsageMetricSources(payload, summaryRateLimit) {
    const sources = [];
    if (summaryRateLimit?.raw)
        sources.push(summaryRateLimit.raw);
    sources.push(payload);

    return sources.filter(source => source && typeof source === 'object');
}

function findSummaryTotals(sources) {
    for (const source of sources) {
        for (const [usedKey, limitKey] of SUMMARY_PATH_HINTS) {
            const used = findNumberByKey(source, usedKey);
            const limit = findNumberByKey(source, limitKey);
            if (used !== null && limit !== null)
                return {used, limit};
        }
    }

    return {used: null, limit: null};
}

function findFirstNumberInSources(sources, keys) {
    for (const source of sources) {
        const number = findFirstNumber(source, keys);
        if (number !== null)
            return number;
    }

    return null;
}

function normalizeRateLimitSection(section, rootKey) {
    if (!section || typeof section !== 'object' || Array.isArray(section))
        return null;

    const windows = normalizeRateLimitWindows(section).map(window => ({
        ...window,
        rootKey,
    }));
    const namedPrimaryWindow = normalizeNamedRateLimitWindow(
        section.primary_window,
        'primary_window',
        rootKey,
    );
    const namedSecondaryWindow = normalizeNamedRateLimitWindow(
        section.secondary_window,
        'secondary_window',
        rootKey,
    );
    const primaryWindow = findPrimaryWindow(windows)
        ?? findWindowWithoutDuration([namedPrimaryWindow]);
    const secondaryWindow = findWeekWindow(windows)
        ?? findWindowWithoutDuration([namedSecondaryWindow]);

    return {
        allowed: coerceBoolean(section.allowed),
        limitReached: coerceBoolean(section.limit_reached),
        windows,
        primaryWindow,
        secondaryWindow,
        raw: section,
    };
}

function findWindowWithoutDuration(windows) {
    return windows.find(window => window?.windowSeconds === null) ?? null;
}

function normalizeAdditionalRateLimits(value) {
    if (value === null || value === undefined)
        return null;

    if (Array.isArray(value)) {
        return value
            .map((item, index) => normalizeAdditionalRateLimitItem(item, index))
            .filter(Boolean);
    }

    if (typeof value !== 'object')
        return null;

    return Object.fromEntries(
        Object.entries(value)
            .map(([key, section]) => {
                const normalized = normalizeRateLimitSection(section, key);
                if (!normalized)
                    return [key, null];

                return [key, classifySingleSparkWindow({
                    ...normalized,
                    limitName: findFirstString(section, ['limit_name', 'name', 'label']) ?? key,
                    meteredFeature: findFirstString(section, ['metered_feature', 'feature']),
                })];
            })
            .filter(([, section]) => section !== null)
    );
}

function normalizeAdditionalRateLimitItem(item, index) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return null;

    const nestedSection = normalizeRateLimitSection(
        item.rate_limit ?? item,
        item.limit_name ?? `additional_rate_limits.${index}`,
    );
    if (!nestedSection)
        return null;

    return classifySingleSparkWindow({
        ...nestedSection,
        raw: item,
        limitName: findFirstString(item, ['limit_name', 'name', 'label']),
        meteredFeature: findFirstString(item, ['metered_feature', 'feature']),
    });
}

function classifySingleSparkWindow(rateLimit) {
    const isSparkLimit = typeof rateLimit.limitName === 'string' &&
        rateLimit.limitName.trim().toLowerCase() === 'gpt-5.3-codex-spark';
    if (!isSparkLimit || rateLimit.windows.length !== 1)
        return rateLimit;

    const weekWindow = {
        ...rateLimit.windows[0],
        period: 'weekly',
    };

    return {
        ...rateLimit,
        windows: [weekWindow],
        primaryWindow: null,
        secondaryWindow: weekWindow,
    };
}

function selectUsageRateLimit(rateLimit, additionalRateLimits) {
    return findCodexRateLimit(additionalRateLimits) ?? rateLimit;
}

function findCodexRateLimit(additionalRateLimits) {
    return getAdditionalRateLimitItems(additionalRateLimits)
        .filter(hasRateLimitWindows)
        .find(isCodexRateLimit) ?? null;
}

function getAdditionalRateLimitItems(value) {
    if (Array.isArray(value))
        return value;

    if (!value || typeof value !== 'object')
        return [];

    return Object.values(value);
}

function hasRateLimitWindows(rateLimit) {
    return Boolean(
        rateLimit?.primaryWindow ||
        rateLimit?.secondaryWindow ||
        rateLimit?.windows?.length > 0,
    );
}

function isCodexRateLimit(rateLimit) {
    return [
        rateLimit?.limitName,
        rateLimit?.meteredFeature,
    ].some(value => typeof value === 'string' && /codex/i.test(value));
}

function normalizeCredits(credits) {
    if (!credits || typeof credits !== 'object' || Array.isArray(credits))
        return null;

    return {
        hasCredits: coerceBoolean(credits.has_credits),
        unlimited: coerceBoolean(credits.unlimited),
        overageLimitReached: coerceBoolean(credits.overage_limit_reached),
        balance: typeof credits.balance === 'string' && credits.balance.trim()
            ? credits.balance.trim()
            : coerceNumber(credits.balance),
        approxLocalMessages: normalizeNumberTuple(credits.approx_local_messages),
        approxCloudMessages: normalizeNumberTuple(credits.approx_cloud_messages),
    };
}

function normalizeRateLimitResetCredits(resetCredits) {
    if (!resetCredits)
        return null;

    const source = Array.isArray(resetCredits) ? {credits: resetCredits} : resetCredits;
    if (typeof source !== 'object' || Array.isArray(source))
        return null;

    const credits = normalizeRateLimitResetCreditItems(source.credits);
    const availableCredits = credits.filter(isAvailableResetCredit);

    return {
        availableCount: coerceNumber(source.available_count) ?? availableCredits.length,
        totalEarnedCount: coerceNumber(source.total_earned_count),
        credits,
        nextExpiresAt: findEarliestResetCreditExpiry(availableCredits),
        raw: resetCredits,
    };
}

function normalizeRateLimitResetCreditItems(value) {
    if (!Array.isArray(value))
        return [];

    return value
        .map(normalizeRateLimitResetCreditItem)
        .filter(Boolean);
}

function normalizeRateLimitResetCreditItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
        return null;

    return {
        id: findLocalFirstString(item, ['id']),
        resetType: findLocalFirstString(item, ['reset_type']),
        status: findLocalFirstString(item, ['status']),
        title: findLocalFirstString(item, ['title']),
        grantedAt: coerceUnixSeconds(findLocalValueByKey(item, 'granted_at')),
        expiresAt: coerceUnixSeconds(findLocalValueByKey(item, 'expires_at')),
        redeemStartedAt: coerceUnixSeconds(findLocalValueByKey(item, 'redeem_started_at')),
        redeemedAt: coerceUnixSeconds(findLocalValueByKey(item, 'redeemed_at')),
        raw: item,
    };
}

function isAvailableResetCredit(credit) {
    const status = credit.status?.toLowerCase();
    if (status)
        return status === 'available';

    return credit.redeemedAt === null;
}

function findEarliestResetCreditExpiry(credits) {
    let earliest = null;

    for (const credit of credits) {
        if (typeof credit.expiresAt !== 'number' || !Number.isFinite(credit.expiresAt))
            continue;

        if (earliest === null || credit.expiresAt < earliest)
            earliest = credit.expiresAt;
    }

    return earliest;
}

function normalizeSpendControl(spendControl) {
    if (!spendControl || typeof spendControl !== 'object' || Array.isArray(spendControl))
        return null;

    return {
        reached: coerceBoolean(spendControl.reached),
    };
}

function normalizeNamedRateLimitWindow(value, key, rootKey) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;

    const window = normalizeRateLimitWindow(value, [key]);
    if (!window)
        return null;

    return {
        ...window,
        rootKey,
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
        rootKey: path[0] ?? null,
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

function selectUsageWindows(windows) {
    const rateLimitWindows = windows.filter(window => window.rootKey === 'rate_limit');
    if (rateLimitWindows.length > 0)
        return rateLimitWindows;

    return windows.filter(window => window.rootKey !== 'code_review_rate_limit');
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
        'limit_window_seconds',
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

function coerceUnixSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value > 9999999999 ? value / 1000 : value;

    if (typeof value !== 'string' || !value.trim())
        return null;

    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const number = Number.parseFloat(trimmed);
        return number > 9999999999 ? number / 1000 : number;
    }

    try {
        const dateTime = GLib.DateTime.new_from_iso8601(trimmed, null);
        if (dateTime)
            return dateTime.to_unix();
    } catch (error) {
        // Fall back to JavaScript date parsing below.
    }

    const timestamp = Date.parse(trimmed);
    return Number.isFinite(timestamp) ? timestamp / 1000 : null;
}

function coerceBoolean(value) {
    if (typeof value === 'boolean')
        return value;

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true')
            return true;
        if (normalized === 'false')
            return false;
    }

    return null;
}

function normalizeNumberTuple(value) {
    if (!Array.isArray(value))
        return null;

    return value.map(item => coerceNumber(item));
}

function normalizeBearerToken(token) {
    return String(token)
        .trim()
        .replace(/^Bearer\s+/i, '')
        .trim();
}

function normalizePercent(percent, used, limit) {
    if (percent !== null) {
        if (used !== null && limit !== null && limit > 0) {
            const ratio = used / limit;
            const directPercent = percent >= 0 && percent <= 1 ? percent : null;
            const scaledPercent = percent >= 0 && percent <= 100 ? percent / 100 : null;

            if (directPercent !== null && scaledPercent !== null)
                return Math.abs(directPercent - ratio) <= Math.abs(scaledPercent - ratio)
                    ? directPercent
                    : scaledPercent;

            if (scaledPercent !== null)
                return scaledPercent;

            if (directPercent !== null)
                return directPercent;
        }

        if (percent > 1 || Number.isInteger(percent))
            return percent / 100;

        return percent;
    }

    if (used !== null && limit !== null && limit > 0)
        return used / limit;

    return null;
}
