import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        this.add(this._buildGeneralGroup());
        this.add(this._buildTokenGroup());
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

    _buildTokenGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Authentication'),
            description: _('The bearer token is stored in the GNOME keyring via Secret Service.'),
        });

        this._tokenRow = new Adw.PasswordEntryRow({
            title: _('Bearer token'),
            text: loadBearerTokenSync(),
            show_apply_button: true,
        });
        this._tokenRow.connect('apply', () => {
            this._saveToken();
        });
        group.add(this._tokenRow);

        const helperRow = new Adw.ActionRow({
            title: _('Clear stored token'),
            subtitle: _('Remove the token from the GNOME keyring.'),
        });
        const clearButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
        });
        clearButton.connect('clicked', () => {
            clearBearerTokenSync();
            this._tokenRow.text = '';
            this._statusRow.subtitle = _('Stored token cleared.');
        });
        helperRow.add_suffix(clearButton);
        group.add(helperRow);

        this._statusRow = new Adw.ActionRow({
            title: _('Connection test'),
            subtitle: _('Not checked yet.'),
        });
        const testButton = new Gtk.Button({
            label: _('Test token'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => {
            void this._testToken();
        });
        this._statusRow.add_suffix(testButton);
        group.add(this._statusRow);

        return group;
    }

    _saveToken() {
        if (this._tokenRow.text.trim()) {
            storeBearerTokenSync(this._tokenRow.text);
            this._statusRow.subtitle = _('Token saved to the GNOME keyring.');
        } else {
            clearBearerTokenSync();
            this._statusRow.subtitle = _('Stored token cleared.');
        }
    }

    async _testToken() {
        const token = this._tokenRow.text.trim();
        if (!token) {
            this._statusRow.subtitle = _('Enter a token before testing.');
            return;
        }

        this._statusRow.subtitle = _('Testing token…');
        try {
            const summary = await this._client.fetchSummary(token);
            const displayMode = this._getDisplayMode();
            const value = displayMode === DISPLAY_MODE_USED ? summary.used : summary.left;
            const label = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');
            const formatted = value !== null
                ? new Intl.NumberFormat().format(Math.round(value))
                : _('available');
            this._statusRow.subtitle = _('Connection OK') + ` · ${formatted} ${label}`;
        } catch (error) {
            if (error instanceof UsageApiError && error.isAuthError)
                this._statusRow.subtitle = _('Authentication failed. Check the token.');
            else if (error instanceof Error)
                this._statusRow.subtitle = error.message;
            else
                this._statusRow.subtitle = _('Unknown error while testing token.');
        }
    }

    _getDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        return mode === DISPLAY_MODE_USED ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT;
    }
});

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new CodexUsagePreferencesPage(settings));
    }
}
