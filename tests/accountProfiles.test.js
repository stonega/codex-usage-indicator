import GLib from 'gi://GLib';

import {
    DEFAULT_ACCOUNT_ID, getAccountProfiles, getPanelAccount,
    normalizeAccountProfile, serializeAccountProfiles,
} from '../accountProfiles.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

for (const value of ['', '{', 'null', '{}', '42']) {
    const profiles = getAccountProfiles(value, '/test/default/auth.json');
    assert(profiles.length === 1 && profiles[0].id === DEFAULT_ACCOUNT_ID,
        'Invalid configuration must preserve the default account');
}

const profiles = getAccountProfiles(JSON.stringify([
    {id: 'work', name: ' Work ', authPath: '/test/work/../work/auth.json', accessToken: 'secret'},
    {id: 'work', name: 'Duplicate ID', authPath: '/test/duplicate/auth.json'},
    {id: 'alias', name: 'Duplicate path', authPath: '/test/work/auth.json'},
    {id: 'default-alias', name: 'Default alias', authPath: '/test/default/auth.json'},
    {id: 'default', name: 'Override default', authPath: '/test/override/auth.json'},
    {id: 'empty', name: '', authPath: '/test/empty/auth.json'},
    {id: 'relative', name: 'Relative', authPath: 'relative/auth.json'},
    {id: 'personal', name: 'Personal', authPath: '~/codex-personal/auth.json'},
]), '/test/default/auth.json');
assert(profiles.length === 3, 'Only valid, distinct profiles must be loaded');
assert(profiles[1].name === 'Work' && profiles[1].authPath === '/test/work/auth.json',
    'Names and auth paths must be normalized');
assert(profiles[2].authPath === `${GLib.get_home_dir()}/codex-personal/auth.json`,
    'Home paths must expand without invoking a shell');
assert(getPanelAccount(profiles, 'work') === profiles[1], 'The selected profile must be used');
assert(getPanelAccount(profiles, 'deleted') === profiles[0], 'A deleted selection must fall back to default');
const serialized = serializeAccountProfiles(profiles.map(profile => ({...profile, accessToken: 'secret'})));
assert(!serialized.includes('secret') && !serialized.includes('accessToken'), 'Tokens must never enter GSettings');
assert(JSON.parse(serialized).length === 2, 'The implicit default must not be serialized');
let rejected = false;
try {
    normalizeAccountProfile({id: 'bad', name: 'Bad', authPath: ''});
} catch {
    rejected = true;
}
assert(rejected, 'An empty path must be rejected');
const renamed = getAccountProfiles(serialized, '/test/default/auth.json', ' Personal ');
assert(renamed[0].name === 'Personal' && renamed[0].id === DEFAULT_ACCOUNT_ID &&
    renamed[0].authPath === '/test/default/auth.json',
    'A main-account alias must preserve its stable ID and auth source');
assert(serializeAccountProfiles(renamed) === serialized,
    'Renaming the main account must not change additional account configuration');
assert(getAccountProfiles('[]', '/test/default/auth.json', '   ')[0].name === 'Codex CLI',
    'An empty alias must restore the default display name');
print('account profile tests passed');
