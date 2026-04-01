import GLib from 'gi://GLib';

import {loadBearerTokenSync, storeBearerTokenSync, clearBearerTokenSync} from './secret.js';

const LEGACY_ACCOUNT_NAME = 'Default';

export function readAccounts(settings) {
    const raw = settings.get_string('accounts-json');
    if (!raw.trim())
        return [];

    let parsed = [];
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        logError(error, '[codex-usage-indicator] invalid accounts-json');
        return [];
    }

    if (!Array.isArray(parsed))
        return [];

    const seen = new Set();
    const accounts = [];
    for (const entry of parsed) {
        const account = normalizeAccount(entry);
        if (!account || seen.has(account.id))
            continue;

        seen.add(account.id);
        accounts.push(account);
    }

    return accounts;
}

export function writeAccounts(settings, accounts) {
    settings.set_string('accounts-json', JSON.stringify(accounts.map(normalizeAccount).filter(Boolean)));
}

export function getVisibleAccountIds(settings, accounts = readAccounts(settings)) {
    const accountIds = new Set(accounts.map(account => account.id));
    const configured = settings.get_strv('visible-account-ids')
        .filter(accountId => accountIds.has(accountId));

    if (configured.length > 0)
        return configured;

    return accounts.map(account => account.id);
}

export function writeVisibleAccountIds(settings, accountIds) {
    settings.set_strv('visible-account-ids', accountIds);
}

export function getVisibleAccounts(settings) {
    const accounts = readAccounts(settings);
    const visibleIds = new Set(getVisibleAccountIds(settings, accounts));
    return accounts.filter(account => visibleIds.has(account.id));
}

export function createAccount(name = '') {
    return normalizeAccount({
        id: GLib.uuid_string_random(),
        name,
    });
}

export function normalizeAccount(value) {
    if (!value || typeof value !== 'object')
        return null;

    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id)
        return null;

    return {
        id,
        name: normalizeAccountName(value.name),
        profile: normalizeAccountProfile(value.profile),
    };
}

export function normalizeAccountName(name) {
    if (typeof name !== 'string')
        return LEGACY_ACCOUNT_NAME;

    const trimmed = name.trim();
    return trimmed || LEGACY_ACCOUNT_NAME;
}

export function ensureLegacyAccountMigration(settings) {
    const accounts = readAccounts(settings);
    if (accounts.length > 0)
        return accounts;

    const legacyToken = loadBearerTokenSync();
    if (!legacyToken)
        return [];

    const migratedAccount = createAccount(LEGACY_ACCOUNT_NAME);
    writeAccounts(settings, [migratedAccount]);
    writeVisibleAccountIds(settings, [migratedAccount.id]);
    storeBearerTokenSync(legacyToken, migratedAccount.id);
    clearBearerTokenSync();
    return [migratedAccount];
}

export function updateAccountProfile(settings, accountId, profile) {
    const accounts = readAccounts(settings);
    let changed = false;

    const nextAccounts = accounts.map(account => {
        if (account.id !== accountId)
            return account;

        const normalizedProfile = normalizeAccountProfile(profile);
        const currentProfile = JSON.stringify(account.profile ?? null);
        const nextProfile = JSON.stringify(normalizedProfile);
        if (currentProfile === nextProfile)
            return account;

        changed = true;
        return {
            ...account,
            profile: normalizedProfile,
        };
    });

    if (changed)
        writeAccounts(settings, nextAccounts);
}

export function clearAccountProfile(settings, accountId) {
    updateAccountProfile(settings, accountId, null);
}

export function getAccountDisplayName(account) {
    return account.profile?.name || account.name;
}

export function getAccountShortName(account) {
    return deriveInitials(getAccountDisplayName(account));
}

function normalizeAccountProfile(value) {
    if (!value || typeof value !== 'object')
        return null;

    const userId = typeof value.userId === 'string' ? value.userId.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const email = typeof value.email === 'string' ? value.email.trim() : '';
    const picture = typeof value.picture === 'string' ? value.picture.trim() : '';
    const fetchedAt = typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt)
        ? value.fetchedAt
        : null;

    if (!userId && !name && !email && !picture && fetchedAt === null)
        return null;

    return {
        userId: userId || null,
        name: name || null,
        email: email || null,
        picture: picture || null,
        fetchedAt,
    };
}

function deriveInitials(name) {
    if (typeof name !== 'string' || !name.trim())
        return '?';

    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1)
        return parts[0].slice(0, 1).toUpperCase();

    return parts
        .slice(0, 2)
        .map(part => part.slice(0, 1).toUpperCase())
        .join('');
}
