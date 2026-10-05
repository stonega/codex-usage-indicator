import Gio from 'gi://Gio';

import {formatResetCreditExpiryList} from '../resetCreditExpiry.js';
import {normalizeSummary} from '../usageApi.js';

const [, bytes] = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('extension.js').load_contents(null);
const source = new TextDecoder().decode(bytes)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default class', 'class');

class Actor {
    constructor(params = {}) {
        Object.assign(this, params);
        this.children = [];
    }

    add_child(child) {
        this.children.push(child);
    }

    set_position() {}
}

// Exercise both menu builders with the properties available in each Shell API.
for (const properties of [['vertical'], ['vertical', 'orientation'], ['orientation']]) {
    class BoxLayout extends Actor {
        constructor(params) {
            for (const name of Object.keys(params)) {
                if (name !== 'x_expand' && !properties.includes(name))
                    throw new Error(`No property ${name} on StBoxLayout (${properties})`);
            }
            super(params);
        }
    }
    for (const name of properties)
        Object.defineProperty(BoxLayout.prototype, name, {value: null, writable: true});

    const {createInfoMenuItem, createUsageProgressMenuItem, CodexUsageIndicator, formatPanelLabel} = new Function(
        'St', 'Clutter', 'GObject', 'PanelMenu', 'PopupMenu', 'Extension', '_', 'DISPLAY_MODE_USED',
        'formatResetCreditExpiryList',
        `${source}\nreturn {createInfoMenuItem, createUsageProgressMenuItem, CodexUsageIndicator, formatPanelLabel};`,
    )(
        {BoxLayout, Label: Actor, Widget: Actor},
        {Orientation: {VERTICAL: 1}, ActorAlign: {START: 0}, FixedLayout: class {}},
        {registerClass: klass => klass},
        {Button: Actor},
        {PopupBaseMenuItem: Actor, PopupMenuItem: Actor},
        class {},
        text => text,
        'used',
        formatResetCreditExpiryList,
    );

    const items = [
        createInfoMenuItem('Account', 'Plan', 'Reset credits'),
        createUsageProgressMenuItem('5 hour usage limit', {
            percent: 0.25,
            leftPercent: 0.75,
            used: null,
            left: null,
            limit: null,
        }, 'left'),
    ];

    for (const item of items) {
        const content = item.children[0];
        const isVertical = content.orientation === 1 || content.vertical === true;
        if (!isVertical || !content.x_expand || content.children.length !== 3)
            throw new Error(`Menu content must remain vertical and expanded (${properties})`);
        if (content.children[0].style !== undefined)
            throw new Error('Menu title color must inherit from the Shell theme');
    }

    for (const [credits, expected] of [
        [{balance: '1234.567890'}, `${new Intl.NumberFormat().format(1234.57)} credits remaining`],
        [{has_credits: false, balance: 0}, '0 credits remaining'],
        [{balance: '0.0001'}, `<${new Intl.NumberFormat().format(0.01)} credits remaining`],
        [{balance: '0.25'}, `${new Intl.NumberFormat().format(0.25)} credits remaining`],
        [{unlimited: true, balance: null}, 'Unlimited'],
        [{balance: null}, 'Unavailable'],
        [{has_credits: false}, 'Unavailable'],
        [{balance: 'invalid'}, 'Unavailable'],
        [null, null],
        [undefined, null],
    ]) {
        const menuItems = [];
        // No rate-limit windows: credits must still render before the early return.
        CodexUsageIndicator.prototype._renderUsage.call({
            _usageSection: {
                removeAll() {},
                addMenuItem(item) { menuItems.push(item); },
            },
        }, {summary: normalizeSummary({credits}), error: null}, 'left', 'left');
        const creditItem = menuItems.find(item =>
            item.children[0]?.children[0]?.text === 'Credit balance');
        if (expected === null) {
            if (creditItem)
                throw new Error('Missing credits must not create a balance row');
        } else if (creditItem?.children[0]?.children[1]?.text !== expected) {
            throw new Error(`Unexpected credit balance for ${JSON.stringify(credits)} (${properties})`);
        }
        if (creditItem && (creditItem.reactive || creditItem.can_focus))
            throw new Error('Credit information must not add interactive controls');
    }

    for (const [primaryUsed, weekUsed, limitReached, displayMode, expected] of [
        [25, 30, null, 'left', '75% left'],
        [95, 30, null, 'left', '5h 5% left · 12 credits'],
        [90, 30, null, 'left', '5h 10% left · 12 credits'],
        [89.9, 30, null, 'left', '10% left'],
        [25, 90, null, 'left', 'Week 10% left · 12 credits'],
        [25, 89.9, null, 'left', '75% left'],
        [25, 95, null, 'left', 'Week 5% left · 12 credits'],
        [95, 90, null, 'used', '5h 95% used · 12 credits'],
        [90, 95, null, 'used', 'Week 95% used · 12 credits'],
        [100, 30, null, 'left', '12 credits'],
        [25, 100, null, 'used', '12 credits'],
        [99.9, 30, null, 'left', '5h 0% left · 12 credits'],
        [100, 30, false, 'left', '5h 0% left · 12 credits'],
        [25, 30, true, 'left', '12 credits'],
        [null, null, null, 'left', 'n/a'],
        [null, 95, null, 'left', 'Week 5% left · 12 credits'],
        [25, 30, false, 'left', '75% left'],
    ]) {
        const summary = normalizeSummary({
            rate_limit: {
                limit_reached: limitReached,
                primary_window: primaryUsed === null ? null : {
                    used_percent: primaryUsed,
                    window_seconds: 5 * 3600,
                },
                secondary_window: weekUsed === null ? null : {
                    used_percent: weekUsed,
                    window_seconds: 7 * 86400,
                },
            },
            code_review_rate_limit: primaryUsed === null && weekUsed === null ? null : {
                limit_reached: true,
                primary_window: {used_percent: 100, window_seconds: 7 * 86400},
            },
            credits: {balance: '12'},
        });
        const actual = formatPanelLabel({summary, error: null}, displayMode);
        if (actual !== expected)
            throw new Error(`Panel label: expected ${expected}, got ${actual} (${properties})`);
        if (formatPanelLabel({summary, error: 'Offline'}, displayMode) !==
            (expected.includes('credits') ? `${expected}*` : expected))
            throw new Error('Displayed cached credits must be marked as stale without changing normal quota labels');
    }

    for (const credits of [{balance: 0}, {balance: '0'}, {balance: -1},
        {balance: null}, {balance: 'invalid'}, {balance: 'Infinity'}, null]) {
        for (const [primaryUsed, weekUsed] of [[25, 30], [95, 30], [100, 30], [25, 95], [25, 100]]) {
            const summary = normalizeSummary({
                rate_limit: {
                    limit_reached: primaryUsed === 100 || weekUsed === 100,
                    primary_window: {used_percent: primaryUsed, window_seconds: 5 * 3600},
                    secondary_window: {used_percent: weekUsed, window_seconds: 7 * 86400},
                },
                credits,
            });
            for (const mode of ['left', 'used']) {
                const expected = mode === 'used' ? `${primaryUsed}% used` : `${100 - primaryUsed}% left`;
                for (const error of [null, 'Offline']) {
                    if (formatPanelLabel({summary, error}, mode) !== expected)
                        throw new Error(`Nonpositive or unavailable credits must not change the panel (${mode})`);
                }
            }
        }
        const empty = normalizeSummary({credits});
        if (formatPanelLabel({summary: empty, error: null}, 'left') !== 'n/a')
            throw new Error('Unknown usage and zero or missing credits must retain the original label');
    }

    for (const [credits, expected] of [
        [{unlimited: true, balance: 0}, '∞ credits'],
        [{balance: '0.0001'}, `<${new Intl.NumberFormat().format(0.01)} credits`],
        [{balance: '0.25'}, `${new Intl.NumberFormat().format(0.25)} credits`],
        [{balance: '12345.6'}, `${new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1}).format(12345.6)} credits`],
    ]) {
        const summary = normalizeSummary({rate_limit: {limit_reached: true}, credits});
        if (formatPanelLabel({summary, error: null}, 'used') !== expected)
            throw new Error(`Unexpected exhausted-limit label for ${JSON.stringify(credits)}`);
    }

    const legacyTotals = normalizeSummary({used: 25, limit: 100, credits: {balance: '12'}});
    if (formatPanelLabel({summary: legacyTotals, error: null}, 'left') !== '75 left')
        throw new Error('Recognized totals must not be replaced merely because window metadata is missing');

    const countedWindow = normalizeSummary({
        rate_limit: {primary_window: {used: 95, limit: 100, window_seconds: 5 * 3600}},
        credits: {balance: '12'},
    });
    if (formatPanelLabel({summary: countedWindow, error: null}, 'left') !== '5h 5 left · 12 credits')
        throw new Error('Counted usage windows must retain their units near the limit');

    const modelOnlySummary = normalizeSummary({
        rate_limit: {limit_reached: false},
        additional_rate_limits: [{
            limit_name: 'other-model',
            rate_limit: {
                primary_window: {used_percent: 95, window_seconds: 5 * 3600},
            },
        }],
        credits: {balance: '12'},
    });
    if (formatPanelLabel({summary: modelOnlySummary, error: null}, 'left') !== '5% left')
        throw new Error('An independent model limit must not be treated as the main allowance');

    const independentLimit = normalizeSummary({additional_rate_limits: [{
        limit_name: 'codex-other-model',
        rate_limit: {
            limit_reached: true,
            primary_window: {used_percent: 95, window_seconds: 5 * 3600},
        },
    }]});
    if (formatPanelLabel({summary: independentLimit, error: null}, 'left') !== '5% left')
        throw new Error('An independent model flag must not trigger credit billing display');
}

print('menu layout tests passed');
