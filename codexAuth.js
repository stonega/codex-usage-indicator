import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const AUTH_FILENAME = 'auth.json';
const EXPIRY_SKEW_SECONDS = 30;

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export class CodexCliAuthError extends Error {
    constructor(message, {path = null, expired = false} = {}) {
        super(message);
        this.name = 'CodexCliAuthError';
        this.path = path;
        this.expired = expired;
    }
}

export function getCodexCliAuthPath() {
    const codexHome = GLib.getenv('CODEX_HOME');
    const basePath = codexHome && codexHome.trim()
        ? codexHome.trim()
        : GLib.build_filenamev([GLib.get_home_dir(), '.codex']);

    return GLib.build_filenamev([basePath, AUTH_FILENAME]);
}

export async function loadCodexCliAuth({allowExpired = false} = {}) {
    const path = getCodexCliAuthPath();
    const payload = await readAuthPayload(path);
    const tokens = payload?.tokens && typeof payload.tokens === 'object'
        ? payload.tokens
        : {};
    const accessToken = typeof tokens.access_token === 'string'
        ? normalizeBearerToken(tokens.access_token)
        : '';

    if (!accessToken) {
        throw new CodexCliAuthError(
            `Codex CLI auth at ${path} does not contain an access token. Run codex login.`,
            {path},
        );
    }

    const expiresAt = getJwtExpiresAt(accessToken);
    const now = Math.floor(Date.now() / 1000);
    if (!allowExpired && expiresAt !== null && expiresAt <= now + EXPIRY_SKEW_SECONDS) {
        throw new CodexCliAuthError(
            'Codex CLI token is expired. Run codex login or start Codex CLI to refresh it.',
            {path, expired: true},
        );
    }

    return {
        accessToken,
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
        expiresAt,
        expiresInSeconds: expiresAt !== null ? Math.max(expiresAt - now, 0) : null,
        lastRefresh: typeof payload?.last_refresh === 'string' ? payload.last_refresh : null,
        path,
    };
}

async function readAuthPayload(path) {
    let contents;
    try {
        [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
    } catch (error) {
        throw new CodexCliAuthError(
            `Codex CLI auth not found at ${path}. Run codex login.`,
            {path},
        );
    }

    try {
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (error) {
        throw new CodexCliAuthError(
            `Codex CLI auth at ${path} is not valid JSON.`,
            {path},
        );
    }
}

function getJwtExpiresAt(token) {
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;

    try {
        const claims = JSON.parse(decodeBase64Url(parts[1]));
        return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
            ? claims.exp
            : null;
    } catch (error) {
        return null;
    }
}

function decodeBase64Url(value) {
    let normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    while (normalized.length % 4 !== 0)
        normalized += '=';

    return new TextDecoder().decode(GLib.base64_decode(normalized));
}

function normalizeBearerToken(token) {
    return token
        .trim()
        .replace(/^Bearer\s+/i, '')
        .trim();
}
