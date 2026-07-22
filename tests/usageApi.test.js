import {normalizeSummary} from '../usageApi.js';

function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected))
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const exhaustedWeeklyLimit = normalizeSummary({
    rate_limit: {
        primary_window: {
            used_percent: 100,
            window_seconds: 7 * 86400,
        },
    },
});

assertEqual(exhaustedWeeklyLimit.weekWindow?.percent, 1,
    'weekly window should be fully used');
assertEqual(exhaustedWeeklyLimit.weekWindow?.leftPercent, 0,
    'weekly window should have no usage remaining');
assertEqual(exhaustedWeeklyLimit.percent, 1,
    'summary should preserve the normalized weekly percentage');
assertEqual(exhaustedWeeklyLimit.leftPercent, 0,
    'summary should match the exhausted weekly window');

print('usageApi tests passed');
