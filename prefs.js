import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CodexCliAuthError,
    getCodexCliAuthPath,
    loadCodexCliAuth,
} from './codexAuth.js';
import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
} from './constants.js';
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
        this.add(this._buildCodexCliGroup());
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

    _buildCodexCliGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Codex CLI'),
            description: _('The extension reads the bearer token from the local Codex CLI auth file.'),
        });

        const sourceRow = new Adw.ActionRow({
            title: _('Token source'),
            subtitle: getCodexCliAuthPath(),
        });
        group.add(sourceRow);

        const authRow = new Adw.ActionRow({
            title: _('Local auth'),
            subtitle: _('Not checked yet.'),
        });
        const checkButton = new Gtk.Button({
            label: _('Check'),
            valign: Gtk.Align.CENTER,
        });
        checkButton.connect('clicked', () => {
            void this._updateLocalAuthStatus(authRow);
        });
        authRow.add_suffix(checkButton);
        group.add(authRow);
        void this._updateLocalAuthStatus(authRow);

        const statusRow = new Adw.ActionRow({
            title: _('Connection test'),
            subtitle: _('Not checked yet.'),
        });
        const testButton = new Gtk.Button({
            label: _('Test'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => {
            void this._testCodexCliToken(statusRow);
        });
        statusRow.add_suffix(testButton);
        group.add(statusRow);

        return group;
    }

    async _updateLocalAuthStatus(row) {
        try {
            const auth = await loadCodexCliAuth({allowExpired: true});
            row.subtitle = auth.expiresAt !== null
                ? `Access token found; expires ${formatUnixTime(auth.expiresAt)}`
                : _('Access token found; expiry not recognized.');
        } catch (error) {
            row.subtitle = formatPreferenceError(error);
        }
    }

    async _testCodexCliToken(statusRow) {
        statusRow.subtitle = _('Testing Codex CLI token...');

        try {
            const auth = await loadCodexCliAuth();
            const summary = await this._client.fetchSummary(auth.accessToken);
            const displayMode = this._getDisplayMode();
            const value = displayMode === DISPLAY_MODE_USED ? summary.used : summary.left;
            const label = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');
            const formatted = value !== null
                ? new Intl.NumberFormat().format(Math.round(value))
                : _('available');
            statusRow.subtitle = `${_('Connection OK')} · ${formatted} ${label}`;
        } catch (error) {
            statusRow.subtitle = formatPreferenceError(error);
        }
    }

    _getDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        return mode === DISPLAY_MODE_USED ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT;
    }

    destroy() {
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

function formatUnixTime(unixSeconds) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.round(unixSeconds));
    return dateTime ? dateTime.format('%F %R') : _('unknown');
}

function formatPreferenceError(error) {
    if (error instanceof CodexCliAuthError)
        return error.message;

    if (error instanceof UsageApiError && error.isAuthError)
        return _('Codex CLI token was rejected. Run codex login.');

    if (error instanceof Error)
        return error.message;

    return _('Unknown error');
}
