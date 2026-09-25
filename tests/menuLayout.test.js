import Gio from 'gi://Gio';

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

    const {createInfoMenuItem, createUsageProgressMenuItem} = new Function(
        'St', 'Clutter', 'GObject', 'PanelMenu', 'PopupMenu', 'Extension', '_', 'DISPLAY_MODE_USED',
        `${source}\nreturn {createInfoMenuItem, createUsageProgressMenuItem};`,
    )(
        {BoxLayout, Label: Actor, Widget: Actor},
        {Orientation: {VERTICAL: 1}, ActorAlign: {START: 0}, FixedLayout: class {}},
        {registerClass: klass => klass},
        {Button: Actor},
        {PopupBaseMenuItem: Actor},
        class {},
        text => text,
        'used',
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
}

print('menu layout tests passed');
