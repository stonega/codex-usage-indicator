import GLib from 'gi://GLib';

import {RESET_CREDIT_EXPIRY_MODE_DATE} from '../constants.js';
import {
    formatCompactExpiryDuration,
    formatResetCreditExpiryList,
} from '../resetCreditExpiry.js';

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 2_000_000_000;

function assertEqual(actual, expected, message) {
    if (!Object.is(actual, expected))
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const expiryList = formatResetCreditExpiryList({
    credits: [
        {status: 'available', expiresAt: NOW + 20 * DAY + 20 * HOUR},
        {status: 'redeemed', expiresAt: NOW + DAY},
        {status: 'available', expiresAt: NOW + 12 * HOUR + 23 * 60},
        {status: 'available', expiresAt: NOW + 12 * DAY + 12 * HOUR},
        {status: 'available', expiresAt: null},
    ],
}, NOW);

assertEqual(expiryList, '12h23m | 12d12h | 20d20h',
    'available reset expiries should be compact, ordered, and unlabeled');
assertEqual(formatCompactExpiryDuration(12 * HOUR), '12h0m',
    'exact hours should include zero minutes');
assertEqual(formatCompactExpiryDuration(14 * DAY), '14d0h',
    'exact days should include zero hours');
assertEqual(formatCompactExpiryDuration(45 * 60), '45m',
    'sub-hour durations should show minutes');
assertEqual(formatCompactExpiryDuration(30), '<1m',
    'sub-minute durations should remain visible');

const firstExpiry = GLib.DateTime.new_local(2034, 4, 5, 6, 7, 0).to_unix();
const secondExpiry = GLib.DateTime.new_local(2034, 5, 6, 8, 9, 0).to_unix();
assertEqual(formatResetCreditExpiryList({credits: [
    {status: 'available', expiresAt: secondExpiry},
    {status: 'redeemed', expiresAt: firstExpiry},
    {status: 'available', expiresAt: firstExpiry},
    {status: 'available', expiresAt: NOW - DAY},
]}, NOW, RESET_CREDIT_EXPIRY_MODE_DATE),
'2034-04-05 06:07 | 2034-05-06 08:09',
'date mode should show local expiry dates in order for available credits');

print('reset credit expiry tests passed');
