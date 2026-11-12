// Run with xvfb-run -a gjs -m tests/preferences.test.js.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as profiles from '../accountProfiles.js';
import * as constants from '../constants.js';
import {formatAccountError} from '../usageError.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function descendants(widget) {
    const result = [widget];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        result.push(...descendants(child));
    return result;
}

function renderAndCapture(widget, path = null) {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    loop.run();
    if (!path)
        return;
    const paintable = new Gtk.WidgetPaintable({widget});
    const snapshot = new Gtk.Snapshot();
    paintable.snapshot(snapshot, widget.get_width(), widget.get_height());
    const node = snapshot.to_node();
    assert(node, 'The preferences window must render');
    widget.get_renderer().render_texture(node, null).save_to_png(path);
}

Adw.init();
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const temporary = Gio.File.new_for_path(GLib.dir_make_tmp('codex-prefs-test-XXXXXX'));
const [, , stderr, status] = GLib.spawn_sync(null,
    ['glib-compile-schemas', '--strict', `--targetdir=${temporary.get_path()}`, root.get_child('schemas').get_path()],
    null, GLib.SpawnFlags.SEARCH_PATH, null);
assert(status === 0, `Schema compilation failed: ${new TextDecoder().decode(stderr)}`);
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(temporary.get_path(), Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: schemaSource.lookup(constants.SETTINGS_SCHEMA_ID, false),
    backend: Gio.memory_settings_backend_new(),
});
const [, bytes] = root.get_child('prefs.js').load_contents(null);
const source = new TextDecoder().decode(bytes)
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace('export default class', 'class');
let destroyed = false;
const bindings = {
    Adw, Gio, GLib, GObject, Gtk,
    ExtensionPreferences: class {},
    _: text => text,
    ...profiles, ...constants,
    // Use fabricated auth and transport; never read real credentials or contact ChatGPT.
    loadCodexCliAuth: async ({path}) => ({accessToken: 'fake-token', accountId: path, expiresAt: 2_000_000_000}),
    UsageApiClient: class {
        async fetchSummary() { return {used: null, left: null, percent: 0.2, leftPercent: 0.8}; }
        destroy() { destroyed = true; }
    },
    formatAccountError,
};
const PreferencesPage = new Function(...Object.keys(bindings), `${source}\nreturn CodexUsagePreferencesPage;`)(...Object.values(bindings));
const page = new PreferencesPage(settings);
const window = new Adw.PreferencesWindow({default_width: 700, default_height: 800, title: 'Codex Usage Indicator'});
window.add(page);
window.present();

function editorFields() {
    const editor = [...page._editors][0];
    const widgets = descendants(editor);
    return {
        editor,
        name: widgets.find(widget => widget instanceof Adw.EntryRow && ['Account name', 'Account alias'].includes(widget.title)),
        path: widgets.find(widget => widget instanceof Adw.EntryRow && widget.title === 'Auth file'),
        save: widgets.find(widget => widget instanceof Gtk.Button && widget.label === 'Save'),
    };
}

assert(page._accountRows.length === 1, 'The default profile must appear without migration');
const screenshot = GLib.getenv('CODEX_USAGE_TEST_SCREENSHOT');
const defaultProfile = page._getProfiles()[0];
const aliasButton = descendants(page._accountRows[0])
    .find(widget => widget instanceof Gtk.Button && widget.tooltip_text === 'Edit account alias');
assert(aliasButton, 'The main account must provide an alias edit control');
aliasButton.emit('clicked');
let aliasFields = editorFields();
assert(!aliasFields.path.visible, 'The main alias editor must keep the auth source fixed');
aliasFields.name.text = ' Personal ';
if (screenshot)
    renderAndCapture(aliasFields.editor, `${screenshot}.alias.png`);
aliasFields.save.emit('clicked');
assert(settings.get_string('default-account-name') === 'Personal' && page._accountRows[0].title === 'Personal' &&
    page._panelAccountRow.model.get_string(0) === 'Personal',
    'Saving an alias must update the account row and panel selector');
assert(page._getProfiles()[0].id === defaultProfile.id && page._getProfiles()[0].authPath === defaultProfile.authPath &&
    settings.get_string('accounts') === '[]' && settings.get_string('panel-account-id') === 'default',
    'Renaming the main account must preserve auth, account configuration and selection');
page._openProfileEditor(page._getProfiles()[0]);
aliasFields = editorFields();
aliasFields.name.text = '';
aliasFields.save.emit('clicked');
assert(page._accountRows[0].title === 'Codex CLI', 'Clearing the alias must restore the default name');
page._openProfileEditor();
let fields = editorFields();
fields.name.text = 'Work <example>';
fields.path.text = profiles.getAccountProfiles('[]')[0].authPath;
fields.save.emit('clicked');
assert(page._editors.size === 1 && page._getProfiles().length === 1,
    'Duplicate auth paths must be rejected in the editor');
if (screenshot)
    renderAndCapture(fields.editor, `${screenshot}.editor.png`);
fields.path.text = '/fixtures/work/auth.json';
fields.save.emit('clicked');
assert(page._getProfiles().length === 2 && page._accountRows.length === 2,
    'Saving an account must update settings and the visible account list');
const workId = page._getProfiles()[1].id;
page._panelAccountRow.selected = 1;
assert(settings.get_string('panel-account-id') === workId, 'Selecting a panel account must persist its stable ID');
settings.set_string('panel-account-id', 'default');
assert(page._panelAccountRow.selected === 0, 'A selection made from the shell must update preferences');
page._openProfileEditor(page._getProfiles()[1]);
fields = editorFields();
fields.name.text = 'Work renamed';
fields.save.emit('clicked');
assert(page._getProfiles()[1].id === workId && page._getProfiles()[1].name === 'Work renamed',
    'Editing a name must preserve the profile ID');
const statusRow = new Adw.ActionRow();
await page._testCodexCliToken(statusRow, page._getProfiles()[1]);
assert(statusRow.subtitle === 'Connection OK · 80% left', 'The connection test must display percentage-only quotas correctly');

// Allow actual GTK layout and rendering before optionally capturing the preferences window.
renderAndCapture(window, screenshot);

page._panelAccountRow.selected = 1;
const removeButton = descendants(page._accountRows[1])
    .find(widget => widget instanceof Gtk.Button && widget.tooltip_text === 'Remove account from indicator');
assert(removeButton, 'Custom accounts must provide a removal control');
removeButton.emit('clicked');
assert(page._getProfiles().length === 1 && settings.get_string('panel-account-id') === 'default',
    'Removing the selected account must fall back to default');
assert(!settings.get_string('accounts').includes('fake-token'), 'Preferences must only store account metadata');
page.close();
page.close();
assert(destroyed, 'Closing preferences must release the HTTP client');
window.destroy();
temporary.get_child('gschemas.compiled').delete(null);
temporary.delete(null);
print('GTK preference tests passed');
