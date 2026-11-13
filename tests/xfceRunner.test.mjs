import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fetchPanelSummary} from '../xfce/runner.mjs';

test('selected auth file, token and account ID reach the shared API client', async () => {
    const calls = [];
    const summary = {primaryWindow: {percent: 0.25}};
    const result = await fetchPanelSummary({authFile: '/tmp/work-auth.json'},
        async options => { calls.push(options); return {accessToken: 'test-token', accountId: 'test-account'}; },
        () => ({
            async fetchSummary(token, accountId) { calls.push([token, accountId]); return summary; },
            destroy() { calls.push('destroy'); },
        }));
    assert.equal(result, summary);
    assert.deepEqual(calls, [{path: '/tmp/work-auth.json'}, ['test-token', 'test-account'], 'destroy']);
});

test('API errors still close the client', async () => {
    let closed = false;
    await assert.rejects(fetchPanelSummary({}, async () => ({accessToken: 'test', accountId: null}),
        () => ({fetchSummary: async () => { throw new Error('offline'); }, destroy() { closed = true; }})), /offline/);
    assert.equal(closed, true);
});
