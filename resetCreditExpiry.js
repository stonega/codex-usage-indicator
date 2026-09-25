import GLib from 'gi://GLib';

import {
    RESET_CREDIT_EXPIRY_MODE_DATE,
    RESET_CREDIT_EXPIRY_MODE_LEFT,
} from './constants.js';

export function formatResetCreditExpiryList(
    rateLimitResetCredits,
    nowSeconds = Date.now() / 1000,
    displayMode = RESET_CREDIT_EXPIRY_MODE_LEFT,
) {
    if (!Number.isFinite(nowSeconds))
        return '';

    return (rateLimitResetCredits?.credits ?? [])
        .filter(isAvailableResetCredit)
        .map(credit => credit.expiresAt)
        .filter(expiresAt => Number.isFinite(expiresAt) && expiresAt > nowSeconds)
        .sort((left, right) => left - right)
        .map(expiresAt => displayMode === RESET_CREDIT_EXPIRY_MODE_DATE
            ? formatExpiryDate(expiresAt)
            : formatCompactExpiryDuration(expiresAt - nowSeconds))
        .filter(Boolean)
        .join(' | ');
}

function formatExpiryDate(expiresAt) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.round(expiresAt));
    return dateTime?.format('%F %R') ?? '';
}

export function formatCompactExpiryDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds))
        return '';

    const seconds = Math.max(0, Math.floor(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0)
        return `${days}d${hours}h`;

    if (hours > 0)
        return `${hours}h${minutes}m`;

    if (minutes > 0)
        return `${minutes}m`;

    return '<1m';
}

function isAvailableResetCredit(credit) {
    const status = credit?.status?.toLowerCase();
    if (status)
        return status === 'available';

    return credit?.redeemedAt === null;
}
