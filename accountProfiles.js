import GLib from 'gi://GLib';

import {getCodexCliAuthPath, resolveCodexCliAuthPath} from './codexAuth.js';

export const DEFAULT_ACCOUNT_ID = 'default';

export function normalizeAccountProfile(profile) {
    const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
    const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
    const authPath = typeof profile?.authPath === 'string' ? profile.authPath.trim() : '';
    if (!id || id === DEFAULT_ACCOUNT_ID)
        throw new Error('Invalid account profile ID.');
    if (!name)
        throw new Error('Enter an account name.');
    if (!authPath)
        throw new Error('Choose a Codex CLI auth.json file.');

    return {id, name, authPath: resolveCodexCliAuthPath(authPath)};
}

export function getAccountProfiles(serialized, defaultAuthPath = getCodexCliAuthPath(), defaultAccountName = '') {
    const alias = typeof defaultAccountName === 'string' ? defaultAccountName.trim() : '';
    const profiles = [{
        id: DEFAULT_ACCOUNT_ID,
        name: alias || 'Codex CLI',
        authPath: resolveCodexCliAuthPath(defaultAuthPath),
    }];
    let configured;
    try {
        configured = JSON.parse(serialized);
    } catch {
        return profiles;
    }
    if (!Array.isArray(configured))
        return profiles;

    for (const value of configured) {
        try {
            const profile = normalizeAccountProfile(value);
            if (!profiles.some(item => item.id === profile.id || item.authPath === profile.authPath))
                profiles.push(profile);
        } catch {
            // A malformed profile must not prevent the default account from working.
        }
    }
    return profiles;
}

export function serializeAccountProfiles(profiles) {
    // Only metadata belongs in GSettings, even if callers supply extra fields.
    return JSON.stringify(profiles
        .filter(profile => profile.id !== DEFAULT_ACCOUNT_ID)
        .map(normalizeAccountProfile));
}

export function createAccountProfile(name, authPath) {
    return normalizeAccountProfile({id: GLib.uuid_string_random(), name, authPath});
}

export function getPanelAccount(profiles, selectedId) {
    return profiles.find(profile => profile.id === selectedId) ?? profiles[0];
}
