import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CodexCliAuthError, getCodexCliLoginCommand, loadCodexCliAuth} from '../codexAuth.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function jwt(claims) {
    const encoded = GLib.base64_encode(new TextEncoder().encode(JSON.stringify(claims)))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    return `test.${encoded}.signature`;
}

const directory = Gio.File.new_for_path(GLib.dir_make_tmp('codex-auth-test-XXXXXX'));
const first = directory.get_child('first.json');
const second = directory.get_child('second.json');
function write(file, payload) {
    file.replace_contents(JSON.stringify(payload), null, false, Gio.FileCreateFlags.PRIVATE, null);
}

const loop = new GLib.MainLoop(null, false);
let failure;
(async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    write(first, {tokens: {
        access_token: `Bearer ${jwt({sub: 'user-1', exp: expiresAt})}`,
        id_token: jwt({email: 'one@example.test'}), account_id: 'account-1',
    }});
    write(second, {tokens: {access_token: jwt({sub: 'user-2', exp: 1}), account_id: 'account-2'}});
    const auth = await loadCodexCliAuth({path: first.get_path()});
    assert(auth.accountId === 'account-1' && auth.userId === 'user-1', 'The requested auth file must identify its own login');
    assert(auth.email === 'one@example.test' && auth.expiresAt === expiresAt, 'Identity and expiry must be decoded');
    assert(!auth.accessToken.startsWith('Bearer '), 'Bearer prefixes must be normalized');
    const expired = await loadCodexCliAuth({path: second.get_path(), allowExpired: true});
    assert(expired.accountId === 'account-2', 'Different files must remain independent');
    let error;
    try {
        await loadCodexCliAuth({path: second.get_path()});
    } catch (caught) {
        error = caught;
    }
    assert(error instanceof CodexCliAuthError && error.expired && error.identity.userId === 'user-2',
        'Expired credentials must retain only identity metadata in the error');
    assert(!JSON.stringify(error).includes('signature'), 'Errors must not expose tokens');

    for (const [content, message] of [['invalid JSON', 'not valid JSON'], ['{"OPENAI_API_KEY":"test"}', 'does not contain an access token']]) {
        second.replace_contents(content, null, false, Gio.FileCreateFlags.PRIVATE, null);
        error = null;
        try {
            await loadCodexCliAuth({path: second.get_path()});
        } catch (caught) {
            error = caught;
        }
        assert(error?.message.includes(message), 'Malformed or API-key-only auth must be rejected');
    }
    const command = getCodexCliLoginCommand("/test/account's files/auth.json");
    const [parsed, argv] = GLib.shell_parse_argv(command);
    assert(parsed && argv[0] === "CODEX_HOME=/test/account's files", 'Login guidance must quote paths safely');
    assert(argv.includes('cli_auth_credentials_store="file"'), 'Login guidance must select file storage');
})().catch(error => { failure = error; }).finally(() => loop.quit());
loop.run();
first.delete(null);
second.delete(null);
directory.delete(null);
if (failure)
    throw failure;
print('Codex auth tests passed');
