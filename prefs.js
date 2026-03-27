import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DEFAULT_UPDATE_INTERVAL_SECONDS} from './constants.js';
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
            description: _('Control how often the panel refreshes Codex usage from ChatGPT.'),
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
            const used = summary.used !== null
                ? new Intl.NumberFormat().format(Math.round(summary.used))
                : _('available');
            this._statusRow.subtitle = _('Connection OK') + ` · ${used}`;
        } catch (error) {
            if (error instanceof UsageApiError && error.isAuthError)
                this._statusRow.subtitle = _('Authentication failed. Check the token.');
            else if (error instanceof Error)
                this._statusRow.subtitle = error.message;
            else
                this._statusRow.subtitle = _('Unknown error while testing token.');
        }
    }
});

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new CodexUsagePreferencesPage(settings));
    }
}
