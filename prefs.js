import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    clearAccountProfile,
    createAccount,
    ensureLegacyAccountMigration,
    getVisibleAccountIds,
    normalizeAccountName,
    readAccounts,
    writeAccounts,
    writeVisibleAccountIds,
} from './accounts.js';
import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
} from './constants.js';
import {
    clearBearerTokenSync,
    loadBearerTokenSync,
    storeBearerTokenSync,
} from './secret.js';
import {UsageApiClient, UsageApiError} from './usageApi.js';

const CodexUsagePreferencesPage = GObject.registerClass(
class CodexUsagePreferencesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        this._settings = settings;
        this._client = new UsageApiClient();
        this._accountRows = [];
        this._settingsSignalIds = [];
        ensureLegacyAccountMigration(this._settings);

        this.add(this._buildGeneralGroup());
        this.add(this._buildAccountsGroup());

        this._settingsSignalIds.push(this._settings.connect(
            'changed::accounts-json',
            () => this._rebuildAccountsGroup(),
        ));
        this._settingsSignalIds.push(this._settings.connect(
            'changed::visible-account-ids',
            () => this._rebuildAccountsGroup(),
        ));
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

        return group;
    }

    _buildAccountsGroup() {
        this._accountsGroup = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('Each account stores its bearer token in the GNOME keyring and can be shown or hidden independently.'),
        });

        this._rebuildAccountsGroup();
        return this._accountsGroup;
    }

    _rebuildAccountsGroup() {
        for (const child of this._accountRows)
            this._accountsGroup.remove(child);
        this._accountRows = [];

        const accounts = readAccounts(this._settings);
        const visibleIds = new Set(getVisibleAccountIds(this._settings, accounts));

        if (accounts.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: _('No accounts configured'),
                subtitle: _('Add an account and paste its bearer token to start fetching usage.'),
            });
            this._accountsGroup.add(emptyRow);
            this._accountRows.push(emptyRow);
        }

        for (const account of accounts) {
            const row = this._createAccountRow(account, visibleIds);
            this._accountsGroup.add(row);
            this._accountRows.push(row);
        }

        const addRow = new Adw.ActionRow({
            title: _('Add account'),
            subtitle: _('Create another Codex account profile.'),
        });
        const addButton = new Gtk.Button({
            label: _('Add'),
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => {
            const nextAccount = createAccount(_('Account'));
            const nextAccounts = [...accounts, nextAccount];
            const nextVisibleIds = new Set(getVisibleAccountIds(this._settings, accounts));
            nextVisibleIds.add(nextAccount.id);
            writeAccounts(this._settings, nextAccounts);
            writeVisibleAccountIds(this._settings, nextAccounts
                .map(account => account.id)
                .filter(id => nextVisibleIds.has(id)));
        });
        addRow.add_suffix(addButton);
        this._accountsGroup.add(addRow);
        this._accountRows.push(addRow);
    }

    _createAccountRow(account, visibleIds) {
        const row = new Adw.ExpanderRow({
            title: account.name,
            subtitle: visibleIds.has(account.id)
                ? _('Shown in indicator and menu')
                : _('Hidden from indicator and menu'),
        });

        const nameRow = new Adw.EntryRow({
            title: _('Name'),
            text: account.name,
            show_apply_button: true,
        });
        nameRow.connect('apply', () => {
            this._updateAccount(account.id, {name: nameRow.text});
        });
        row.add_row(nameRow);

        const tokenRow = new Adw.PasswordEntryRow({
            title: _('Bearer token'),
            text: loadBearerTokenSync(account.id),
            show_apply_button: true,
        });
        tokenRow.connect('apply', () => {
            const token = tokenRow.text.trim();
            if (token) {
                storeBearerTokenSync(token, account.id);
                clearAccountProfile(this._settings, account.id);
                statusRow.subtitle = _('Token saved to the GNOME keyring.');
            } else {
                clearBearerTokenSync(account.id);
                clearAccountProfile(this._settings, account.id);
                statusRow.subtitle = _('Stored token cleared.');
            }
        });
        row.add_row(tokenRow);

        const visibilityRow = new Adw.ActionRow({
            title: _('Show this account'),
            subtitle: _('Controls whether this account appears in the panel indicator and popup menu.'),
        });
        const visibilitySwitch = new Gtk.Switch({
            active: visibleIds.has(account.id),
            valign: Gtk.Align.CENTER,
        });
        visibilitySwitch.connect('notify::active', widget => {
            this._setAccountVisibility(account.id, widget.active);
        });
        visibilityRow.add_suffix(visibilitySwitch);
        row.add_row(visibilityRow);

        const statusRow = new Adw.ActionRow({
            title: _('Connection test'),
            subtitle: _('Not checked yet.'),
        });
        const testButton = new Gtk.Button({
            label: _('Test token'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => {
            void this._testToken(account, tokenRow, statusRow);
        });
        statusRow.add_suffix(testButton);
        row.add_row(statusRow);

        const removeRow = new Adw.ActionRow({
            title: _('Remove account'),
            subtitle: _('Delete this account profile and clear its stored token.'),
        });
        const removeButton = new Gtk.Button({
            label: _('Remove'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        removeButton.connect('clicked', () => {
            this._removeAccount(account.id);
        });
        removeRow.add_suffix(removeButton);
        row.add_row(removeRow);

        return row;
    }

    _updateAccount(accountId, updates) {
        const accounts = readAccounts(this._settings);
        const nextAccounts = accounts.map(account => {
            if (account.id !== accountId)
                return account;

            return {
                ...account,
                name: normalizeAccountName(updates.name ?? account.name),
            };
        });

        writeAccounts(this._settings, nextAccounts);
    }

    _setAccountVisibility(accountId, isVisible) {
        const accounts = readAccounts(this._settings);
        const visibleIds = new Set(getVisibleAccountIds(this._settings, accounts));

        if (isVisible)
            visibleIds.add(accountId);
        else
            visibleIds.delete(accountId);

        if (accounts.length > 0 && visibleIds.size === 0)
            visibleIds.add(accountId);

        writeVisibleAccountIds(this._settings, accounts
            .map(account => account.id)
            .filter(id => visibleIds.has(id)));
    }

    _removeAccount(accountId) {
        const accounts = readAccounts(this._settings);
        const nextAccounts = accounts.filter(account => account.id !== accountId);
        const currentVisibleIds = new Set(getVisibleAccountIds(this._settings, accounts));

        currentVisibleIds.delete(accountId);
        const nextVisibleIds = nextAccounts
            .map(account => account.id)
            .filter(id => currentVisibleIds.has(id));

        writeVisibleAccountIds(this._settings, nextVisibleIds);
        writeAccounts(this._settings, nextAccounts);
        clearBearerTokenSync(accountId);
    }

    async _testToken(account, tokenRow, statusRow) {
        const token = tokenRow.text.trim();
        if (!token) {
            statusRow.subtitle = _('Enter a token before testing.');
            return;
        }

        statusRow.subtitle = _('Testing token…');
        try {
            const summary = await this._client.fetchSummary(token);
            const displayMode = this._getDisplayMode();
            const value = displayMode === DISPLAY_MODE_USED ? summary.used : summary.left;
            const label = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');
            const formatted = value !== null
                ? new Intl.NumberFormat().format(Math.round(value))
                : _('available');
            statusRow.subtitle = `${account.name} · ${_('Connection OK')} · ${formatted} ${label}`;
        } catch (error) {
            if (error instanceof UsageApiError && error.isAuthError)
                statusRow.subtitle = `${account.name} · ${_('Authentication failed. Check the token.')}`;
            else if (error instanceof Error)
                statusRow.subtitle = `${account.name} · ${error.message}`;
            else
                statusRow.subtitle = `${account.name} · ${_('Unknown error while testing token.')}`;
        }
    }

    _getDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        return mode === DISPLAY_MODE_USED ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT;
    }

    destroy() {
        for (const signalId of this._settingsSignalIds)
            this._settings.disconnect(signalId);
        this._settingsSignalIds = [];
        this._client.destroy();
        super.destroy();
    }
});

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new CodexUsagePreferencesPage(settings));
    }
}
