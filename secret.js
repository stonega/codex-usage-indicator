import Secret from 'gi://Secret';

import {
    LEGACY_SECRET_TOKEN_ACCOUNT,
    SECRET_SCHEMA_NAME,
    SECRET_TOKEN_LABEL,
} from './constants.js';

const TOKEN_SCHEMA = new Secret.Schema(
    SECRET_SCHEMA_NAME,
    Secret.SchemaFlags.NONE,
    {account: Secret.SchemaAttributeType.STRING},
);

function _attributes(accountId) {
    return {account: accountId};
}

function _getTokenLabel(accountId) {
    return accountId === LEGACY_SECRET_TOKEN_ACCOUNT
        ? SECRET_TOKEN_LABEL
        : `${SECRET_TOKEN_LABEL} (${accountId})`;
}

export function loadBearerTokenSync(accountId = LEGACY_SECRET_TOKEN_ACCOUNT) {
    return Secret.password_lookup_sync(TOKEN_SCHEMA, _attributes(accountId), null) ?? '';
}

export function storeBearerTokenSync(token, accountId = LEGACY_SECRET_TOKEN_ACCOUNT) {
    const trimmed = token.trim();
    if (!trimmed)
        return clearBearerTokenSync(accountId);

    return Secret.password_store_sync(
        TOKEN_SCHEMA,
        _attributes(accountId),
        Secret.COLLECTION_DEFAULT,
        _getTokenLabel(accountId),
        trimmed,
        null,
    );
}

export function clearBearerTokenSync(accountId = LEGACY_SECRET_TOKEN_ACCOUNT) {
    return Secret.password_clear_sync(TOKEN_SCHEMA, _attributes(accountId), null);
}
