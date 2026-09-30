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

    const {createInfoMenuItem, createUsageProgressMenuItem, CodexUsageIndicator} = new Function(
        'St', 'Clutter', 'GObject', 'PanelMenu', 'PopupMenu', 'Extension', '_', 'DISPLAY_MODE_USED',
        'formatResetCreditExpiryList',
        `${source}\nreturn {createInfoMenuItem, createUsageProgressMenuItem, CodexUsageIndicator};`,
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

}

print('menu layout tests passed');
