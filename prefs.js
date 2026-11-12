import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    loadCodexCliAuth,
} from './codexAuth.js';
import {
    DEFAULT_ACCOUNT_ID,
    createAccountProfile,
    getAccountProfiles,
    getPanelAccount,
    normalizeAccountProfile,
    serializeAccountProfiles,
} from './accountProfiles.js';
import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
    RESET_CREDIT_EXPIRY_MODE_DATE,
    RESET_CREDIT_EXPIRY_MODE_LEFT,
} from './constants.js';
import {UsageApiClient} from './usageApi.js';
import {formatAccountError} from './usageError.js';

const CodexUsagePreferencesPage = GObject.registerClass(
class CodexUsagePreferencesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        this._settings = settings;
        this._client = new UsageApiClient();
        this._closed = false;
        this._editors = new Set();
        this._accountRows = [];

        this.add(this._buildGeneralGroup());
        this.add(this._buildAccountsGroup());
        this._reloadAccounts();
        this._accountsChangedId = settings.connect('changed::accounts', () => this._reloadAccounts());
        this._aliasChangedId = settings.connect('changed::default-account-name', () => this._reloadAccounts());
        this._panelChangedId = settings.connect('changed::panel-account-id', () => this._updatePanelSelector());
    }

    _buildGeneralGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Refresh'),
            description: _('Control how the panel displays and refreshes Codex usage from ChatGPT.'),
        });

        const adjustment = new Gtk.Adjustment({
            lower: 60,
            upper: 3600,
            step_increment: 60,
            page_increment: 300,
            value: this._settings.get_int('update-interval-seconds') || DEFAULT_UPDATE_INTERVAL_SECONDS,
        });

        const row = new Adw.SpinRow({
            title: _('Update interval'),
            subtitle: _('Seconds between automatic refreshes'),
            adjustment,
            climb_rate: 1,
            digits: 0,
        });

        this._settings.bind(
            'update-interval-seconds',
            row,
            'value',
            Gio.SettingsBindFlags.DEFAULT,
        );

        group.add(row);

        const displayRow = new Adw.ComboRow({
            title: _('Display value'),
            subtitle: _('Choose whether the panel shows remaining or used quota.'),
            model: Gtk.StringList.new([
                _('Left'),
                _('Used'),
            ]),
            selected: this._getDisplayMode() === DISPLAY_MODE_USED ? 1 : 0,
        });
        displayRow.connect('notify::selected', combo => {
            this._settings.set_string(
                'display-mode',
                combo.selected === 1 ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT,
            );
        });
        group.add(displayRow);

        const resetCreditExpiryRow = new Adw.ComboRow({
            title: _('Reset credit expiry'),
            subtitle: _('Choose how expiry times appear below the reset credit count.'),
            model: Gtk.StringList.new([
                _('Time left'),
                _('Date and time'),
            ]),
            selected: this._getResetCreditExpiryMode() === RESET_CREDIT_EXPIRY_MODE_DATE ? 1 : 0,
        });
        resetCreditExpiryRow.connect('notify::selected', combo => {
            this._settings.set_string(
                'reset-credit-expiry-mode',
                combo.selected === 1
                    ? RESET_CREDIT_EXPIRY_MODE_DATE
                    : RESET_CREDIT_EXPIRY_MODE_LEFT,
            );
        });
        group.add(resetCreditExpiryRow);

        return group;
    }

    _getProfiles() {
        return getAccountProfiles(this._settings.get_string('accounts'), undefined,
            this._settings.get_string('default-account-name'));
    }

    _buildAccountsGroup() {
        const addButton = new Gtk.Button({
            label: _('Add account'),
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._openProfileEditor());
        const group = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('Monitor multiple Codex accounts and choose which one appears in the top bar.'),
            header_suffix: addButton,
        });
        this._panelAccountRow = new Adw.ComboRow({
            title: _('Panel account'),
            subtitle: _('Other accounts remain available in the popup.'),
            use_markup: false,
        });
        this._panelAccountRow.connect('notify::selected', combo => {
            if (!this._updatingPanelSelector) {
                const profile = this._getProfiles()[combo.selected];
                if (profile)
                    this._settings.set_string('panel-account-id', profile.id);
            }
        });
        group.add(this._panelAccountRow);
        this._accountsGroup = group;
        return group;
    }

    _updatePanelSelector() {
        const profiles = this._getProfiles();
        const selected = getPanelAccount(profiles, this._settings.get_string('panel-account-id'));
        this._updatingPanelSelector = true;
        this._panelAccountRow.model = Gtk.StringList.new(profiles.map(getAccountName));
        this._panelAccountRow.selected = profiles.findIndex(profile => profile.id === selected.id);
        this._updatingPanelSelector = false;
    }

    _reloadAccounts() {
        this._updatePanelSelector();
        for (const row of this._accountRows)
            this._accountsGroup.remove(row);
        this._accountRows = this._getProfiles().map(profile => this._buildAccountRow(profile));
        for (const row of this._accountRows)
            this._accountsGroup.add(row);
    }

    _buildAccountRow(profile) {
        const row = new Adw.ExpanderRow({
            title: getAccountName(profile),
            subtitle: profile.authPath,
            use_markup: false,
        });
        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            tooltip_text: profile.id === DEFAULT_ACCOUNT_ID ? _('Edit account alias') : _('Edit account'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        editButton.connect('clicked', () => this._openProfileEditor(profile));
        row.add_action(editButton);
        if (profile.id !== DEFAULT_ACCOUNT_ID) {
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove account from indicator'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeButton.connect('clicked', () => {
                this._settings.set_string('accounts', serializeAccountProfiles(
                    this._getProfiles().filter(item => item.id !== profile.id),
                ));
                if (this._settings.get_string('panel-account-id') === profile.id)
                    this._settings.set_string('panel-account-id', DEFAULT_ACCOUNT_ID);
            });
            row.add_action(removeButton);
        }
        const authRow = new Adw.ActionRow({
            title: _('Local auth'),
            subtitle: _('Not checked yet.'),
            use_markup: false,
        });
        const checkButton = new Gtk.Button({
            label: _('Check'),
            valign: Gtk.Align.CENTER,
        });
        checkButton.connect('clicked', () => {
            void this._updateLocalAuthStatus(authRow, profile);
        });
        authRow.add_suffix(checkButton);
        row.add_row(authRow);
        void this._updateLocalAuthStatus(authRow, profile);

        const statusRow = new Adw.ActionRow({
            title: _('Connection test'),
            subtitle: _('Not checked yet.'),
            use_markup: false,
        });
        const testButton = new Gtk.Button({
            label: _('Test'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', async () => {
            testButton.sensitive = false;
            await this._testCodexCliToken(statusRow, profile);
            if (!this._closed)
                testButton.sensitive = true;
        });
        statusRow.add_suffix(testButton);
        row.add_row(statusRow);

        return row;
    }

    _openProfileEditor(profile = null) {
        const isDefault = profile?.id === DEFAULT_ACCOUNT_ID;
        const editor = new Gtk.Window({
            title: isDefault ? _('Edit account alias') : profile ? _('Edit account') : _('Add account'),
            transient_for: this.get_root(),
            modal: true,
            default_width: 560,
            default_height: isDefault ? 240 : 360,
        });
        this._editors.add(editor);
        let chooser = null;
        editor.connect('close-request', () => {
            this._editors.delete(editor);
            chooser?.destroy();
            return false;
        });
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const header = new Adw.HeaderBar({
            show_end_title_buttons: false,
            show_start_title_buttons: false,
            title_widget: new Adw.WindowTitle({title: editor.title}),
        });
        const cancelButton = new Gtk.Button({label: _('Cancel')});
        cancelButton.connect('clicked', () => editor.close());
        header.pack_start(cancelButton);
        const saveButton = new Gtk.Button({label: _('Save'), css_classes: ['suggested-action']});
        header.pack_end(saveButton);
        editor.set_titlebar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: isDefault ? _('Choose an alias for the main account. Leave empty to use Codex CLI.')
                : _('Choose the auth.json file maintained by Codex CLI for this account.'),
        });
        const nameRow = new Adw.EntryRow({
            title: isDefault ? _('Account alias') : _('Account name'),
            text: profile?.name ?? '',
        });
        const pathRow = new Adw.EntryRow({title: _('Auth file'), text: profile?.authPath ?? '', visible: !isDefault});
        const browseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            tooltip_text: _('Choose auth file'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        browseButton.connect('clicked', () => {
            chooser?.destroy();
            chooser = new Gtk.FileChooserNative({
                title: _('Choose Codex CLI auth file'),
                transient_for: editor,
                modal: true,
                action: Gtk.FileChooserAction.OPEN,
                accept_label: _('Select'),
                cancel_label: _('Cancel'),
            });
            const filter = new Gtk.FileFilter();
            filter.set_name(_('JSON files'));
            filter.add_pattern('*.json');
            chooser.add_filter(filter);
            chooser.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT)
                    pathRow.text = dialog.get_file()?.get_path() ?? '';
                dialog.destroy();
                chooser = null;
            });
            chooser.show();
        });
        pathRow.add_suffix(browseButton);
        group.add(nameRow);
        group.add(pathRow);
        page.add(group);
        box.append(page);
        const errorLabel = new Gtk.Label({
            visible: false,
            wrap: true,
            xalign: 0,
            margin_start: 24,
            margin_end: 24,
            margin_bottom: 16,
            css_classes: ['error'],
        });
        box.append(errorLabel);
        saveButton.connect('clicked', () => {
            try {
                if (isDefault) {
                    this._settings.set_string('default-account-name', nameRow.text.trim());
                    editor.close();
                    return;
                }
                const candidate = profile
                    ? normalizeAccountProfile({...profile, name: nameRow.text, authPath: pathRow.text})
                    : createAccountProfile(nameRow.text, pathRow.text);
                const profiles = this._getProfiles();
                if (profiles.some(item => item.id !== candidate.id && item.authPath === candidate.authPath))
                    throw new Error(_('This auth file is already configured.'));
                const updated = profile
                    ? profiles.map(item => item.id === candidate.id ? candidate : item)
                    : [...profiles, candidate];
                this._settings.set_string('accounts', serializeAccountProfiles(updated));
                editor.close();
            } catch (error) {
                errorLabel.label = error.message;
                errorLabel.visible = true;
            }
        });
        editor.set_child(box);
        editor.present();
    }

    async _updateLocalAuthStatus(row, profile) {
        try {
            const auth = await loadCodexCliAuth({path: profile.authPath, allowExpired: true});
            if (this._closed)
                return;
            row.subtitle = auth.expiresAt !== null
                ? `Access token found; expires ${formatUnixTime(auth.expiresAt)}`
                : _('Access token found; expiry not recognized.');
        } catch (error) {
            if (!this._closed)
                row.subtitle = formatAccountError(error, profile, _);
        }
    }

    async _testCodexCliToken(statusRow, profile) {
        statusRow.subtitle = _('Testing Codex CLI token...');

        try {
            const auth = await loadCodexCliAuth({path: profile.authPath});
            if (this._closed)
                return;
            const summary = await this._client.fetchSummary(auth.accessToken, auth.accountId);
            if (this._closed)
                return;
            const displayMode = this._getDisplayMode();
            const value = displayMode === DISPLAY_MODE_USED ? summary.used : summary.left;
            const label = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');
            const percent = displayMode === DISPLAY_MODE_USED ? summary.percent : summary.leftPercent;
            const formatted = value !== null ? `${new Intl.NumberFormat().format(Math.round(value))} ${label}`
                : percent !== null ? `${Math.round(percent * 100)}% ${label}` : _('Usage available');
            statusRow.subtitle = `${_('Connection OK')} · ${formatted}`;
        } catch (error) {
            if (!this._closed)
                statusRow.subtitle = formatAccountError(error, profile, _);
        }
    }

    _getDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        return mode === DISPLAY_MODE_USED ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT;
    }

    _getResetCreditExpiryMode() {
        const mode = this._settings.get_string('reset-credit-expiry-mode');
        return mode === RESET_CREDIT_EXPIRY_MODE_DATE
            ? RESET_CREDIT_EXPIRY_MODE_DATE
            : RESET_CREDIT_EXPIRY_MODE_LEFT;
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._settings.disconnect(this._accountsChangedId);
        this._settings.disconnect(this._aliasChangedId);
        this._settings.disconnect(this._panelChangedId);
        for (const editor of this._editors)
            editor.close();
        this._editors.clear();
        this._client.destroy();
    }
});

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new CodexUsagePreferencesPage(settings);
        window.add(page);
        window.connect('close-request', () => {
            page.close();
            return false;
        });
    }
}

function formatUnixTime(unixSeconds) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.round(unixSeconds));
    return dateTime ? dateTime.format('%F %R') : _('unknown');
}

function getAccountName(profile) {
    return profile.id === DEFAULT_ACCOUNT_ID && profile.name === 'Codex CLI'
        ? _('Codex CLI') : profile.name;
}
