import Secret from 'gi://Secret';

import {
    SECRET_SCHEMA_NAME,
    SECRET_TOKEN_ACCOUNT,
    SECRET_TOKEN_LABEL,
} from './constants.js';

const TOKEN_SCHEMA = new Secret.Schema(
    SECRET_SCHEMA_NAME,
    Secret.SchemaFlags.NONE,
    {account: Secret.SchemaAttributeType.STRING},
);

function _attributes() {
    return {account: SECRET_TOKEN_ACCOUNT};
}

export function loadBearerTokenSync() {
    return Secret.password_lookup_sync(TOKEN_SCHEMA, _attributes(), null) ?? '';
}

export function storeBearerTokenSync(token) {
    const trimmed = token.trim();
    if (!trimmed)
        return clearBearerTokenSync();

    return Secret.password_store_sync(
        TOKEN_SCHEMA,
        _attributes(),
        Secret.COLLECTION_DEFAULT,
        SECRET_TOKEN_LABEL,
        trimmed,
        null,
    );
}

export function clearBearerTokenSync() {
    return Secret.password_clear_sync(TOKEN_SCHEMA, _attributes(), null);
}
