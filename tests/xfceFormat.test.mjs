import assert from 'node:assert/strict';
import {test} from 'node:test';
import {renderGenmon, renderGenmonError} from '../xfce/format.mjs';

test('Genmon shows 5h/week usage, resets and credits', () => {
    const output = renderGenmon({
        primaryWindow: {id: 'primary', percent: 0.25, windowSeconds: 18000, resetAt: 2030000000},
        weekWindow: {id: 'weekly', percent: 0.6, windowSeconds: 604800},
        credits: {balance: '12.5'},
    });
    assert.match(output, /<txt>Codex 75% left<\/txt>/);
    assert.match(output, /5h: 75% left/);
    assert.match(output, /Week: 40% left/);
    assert.match(output, /12.5 credits remaining/);
    assert.match(output, /resets/);
});

test('used mode, weekly-only fallback and XML escaping are safe', () => {
    const output = renderGenmon({weekWindow: {id: 'weekly', percent: 1, windowSeconds: 604800}},
        {label: 'Work <&>', mode: 'used'});
    assert.match(output, /<txt>Work &lt;&amp;&gt; 100% used<\/txt>/);
    assert.match(output, /Week: 100% used/);
    assert.doesNotMatch(output, /<txt>Work <&>/);
});

test('unknown usage and errors never leak raw markup', () => {
    assert.match(renderGenmon({}), /Codex —/);
    assert.equal(renderGenmonError('Bad <token>&', {label: 'A&B'}),
        '<txt>A&amp;B ?</txt><tool>Bad &lt;token&gt;&amp;</tool>');
});
