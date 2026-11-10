import {AccountMonitor} from '../accountMonitor.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return {promise, resolve, reject};
}

const profiles = [
    {id: 'a', name: 'Personal', authPath: '/a/auth.json'},
    {id: 'b', name: 'Work', authPath: '/b/auth.json'},
];
const auths = {
    '/a/auth.json': {accessToken: 'token-a', accountId: 'workspace', userId: 'user-a'},
    '/b/auth.json': {accessToken: 'token-b', accountId: 'workspace', userId: 'user-b'},
};
const summary = remaining => ({primaryWindow: {leftPercent: remaining, resetAt: 10_000}});

// Accounts finish independently and concurrent refreshes reuse each account's request.
const a = deferred();
const b = deferred();
let requests = 0;
const monitor = new AccountMonitor({
    loadAuth: async ({path}) => auths[path],
    fetchSummary: token => { requests++; return token === 'token-a' ? a.promise : b.promise; },
    now: () => 1000,
});
monitor.setProfiles(profiles);
const first = monitor.refreshAccount('a');
assert(first === monitor.refreshAccount('a'), 'Overlapping refreshes must be deduplicated per account');
const second = monitor.refreshAccount('b');
await Promise.resolve();
assert(requests === 2, 'Both accounts must be queried');
a.resolve(summary(0.2));
await first;
assert(monitor.getState('a').summary.primaryWindow.leftPercent === 0.2, 'A completed account must update before its peer');
assert(monitor.getState('b').refreshing, 'Other accounts can remain pending');
b.reject(new Error('Work is offline'));
await second;
assert(monitor.getState('b').error === 'Work is offline' && monitor.getState('a').error === null,
    'An account error must not affect another account');
assert(!JSON.stringify(monitor.getState('a')).includes('token-a'), 'State must not retain credentials');

monitor.fetchSummary = async () => { throw new Error('Offline'); };
await monitor.refreshAccount('a');
assert(monitor.getState('a').summary && monitor.getState('a').lastUpdated === 1000,
    'A temporary failure must preserve the same account\'s timestamp and stale data');
auths['/a/auth.json'] = {...auths['/a/auth.json'], userId: 'another-user'};
await monitor.refreshAccount('a');
assert(monitor.getState('a').summary === null && monitor.getState('a').lastUpdated === null,
    'A different user in the same workspace must not inherit cached data');
monitor.fetchSummary = async () => summary(0.2);
await monitor.refreshAccount('a');
monitor.loadAuth = async () => {
    throw Object.assign(new Error('Expired'), {identity: {accountId: 'workspace', userId: 'expired-user'}});
};
await monitor.refreshAccount('a');
assert(monitor.getState('a').summary === null, 'An expired replacement login must also clear the previous account\'s data');
monitor.destroy();

// Replacing or removing a profile invalidates in-flight results and cancels only that request.
let cancellations = 0;
let changes = 0;
const oldResponse = deferred();
const replacement = new AccountMonitor({
    loadAuth: async ({path}) => ({accessToken: path, accountId: path}),
    fetchSummary: token => token === '/a/auth.json' ? oldResponse.promise : Promise.resolve(summary(0.8)),
    createCancellable: () => ({cancel() { cancellations++; }}),
    onChanged: () => { changes++; },
});
replacement.setProfiles(profiles);
const oldRequest = replacement.refreshAccount('a');
await Promise.resolve();
replacement.setProfiles([{...profiles[0], authPath: '/new/auth.json'}, profiles[1]]);
assert(cancellations === 1, 'Changing a profile path must cancel its request');
await replacement.refreshAccount('a');
oldResponse.resolve(summary(0.01));
await oldRequest;
assert(replacement.getState('a').summary.primaryWindow.leftPercent === 0.8,
    'A late response from the old file must not overwrite the replacement');
replacement.setProfiles([{...profiles[0], name: 'Renamed', authPath: '/new/auth.json'}]);
assert(replacement.getState('a').summary.primaryWindow.leftPercent === 0.8,
    'Renaming a profile must preserve its data');
const lateAuth = deferred();
replacement.loadAuth = () => lateAuth.promise;
const removedRequest = replacement.refreshAccount('a');
replacement.setProfiles([]);
const changesAfterRemoval = changes;
lateAuth.resolve({accessToken: 'removed-token'});
await removedRequest;
assert(changes === changesAfterRemoval && replacement.getState('a').summary === null,
    'Removed profiles must not render or receive results');
replacement.destroy();

// Notifications compare snapshots of one profile and identify that profile.
const notices = [];
let remaining = 0.2;
let now = 1000;
const notifying = new AccountMonitor({
    loadAuth: async ({path}) => auths[path],
    fetchSummary: async () => summary(remaining),
    now: () => now,
    onLimitResets: (profile, resets) => notices.push({id: profile.id, resets}),
});
notifying.setProfiles(profiles);
await notifying.refresh();
remaining = 0.97;
now = 1100;
await notifying.refreshAccount('b');
assert(notices.length === 1 && notices[0].id === 'b' && notices[0].resets.length === 1,
    'Only the profile whose limit reset must notify');
assert(notifying.getState('a').summary.primaryWindow.leftPercent === 0.2,
    'Another account\'s snapshot must remain untouched');
const late = deferred();
notifying.fetchSummary = () => late.promise;
const requestAtShutdown = notifying.refreshAccount('b');
await Promise.resolve();
notifying.destroy();
late.resolve(summary(1));
await requestAtShutdown;
assert(notices.length === 1 && notifying.getState('b').summary === null,
    'Disabling the monitor must discard pending responses and notifications');

// Older auth files can rely on account identity supplied by the usage endpoint.
remaining = 0.2;
const fallbackNotices = [];
const fallback = new AccountMonitor({
    loadAuth: async () => ({accessToken: 'opaque-token'}),
    fetchSummary: async () => ({...summary(remaining), accountId: 'api-account'}),
    now: () => 1000,
    onLimitResets: (_profile, resets) => fallbackNotices.push(...resets),
});
fallback.setProfiles([profiles[0]]);
await fallback.refresh();
remaining = 0.97;
await fallback.refresh();
assert(fallbackNotices.length === 1, 'Reset detection must retain the API account identity fallback');
fallback.destroy();
print('account monitor tests passed');
