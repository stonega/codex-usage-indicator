import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
} from './constants.js';
import {loadBearerTokenSync} from './secret.js';
import {UsageApiClient, UsageApiError} from './usageApi.js';

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Codex Usage Indicator'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new UsageApiClient();

        this._refreshSourceId = null;
        this._refreshInFlight = null;
        this._lastUpdated = null;
        this._lastSummary = null;
        this._authFailed = false;
        this._summaryError = null;

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        this._label = new St.Label({
            text: _('Codex: --'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                void this.refresh({force: true});
        });

        this._settings.connectObject(
            'changed::update-interval-seconds',
            () => this._restartRefreshTimer(),
            this,
        );
        this._settings.connectObject(
            'changed::display-mode',
            () => this._renderCurrentState(),
            this,
        );

        this._restartRefreshTimer();
        void this.refresh();
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem(_('Loading usage…'), {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._statusItem);

        this._lastUpdatedItem = new PopupMenu.PopupMenuItem(_('Last updated: never'), {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._lastUpdatedItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const titleItem = new PopupMenu.PopupMenuItem(
            _('Usage windows'),
            {reactive: false, can_focus: false},
        );
        this.menu.addMenuItem(titleItem);

        this._windowsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._windowsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('Refresh now'), () => {
            void this.refresh({force: true});
        });
        this.menu.addAction(_('Settings'), () => {
            this._extension.openPreferences();
        });
    }

    async refresh({force = false} = {}) {
        if (this._refreshInFlight)
            return this._refreshInFlight;

        if (!force && this._authFailed)
            return null;

        const token = loadBearerTokenSync();
        if (!token) {
            this._authFailed = false;
            this._summaryError = _('Bearer token required');
            this._setLabel(_('Codex: token'));
            this._statusItem.label.text = _('Configure a bearer token in Settings.');
            this._lastUpdatedItem.label.text = _('Last updated: never');
            this._renderWindows(null);
            return null;
        }

        this._summaryError = null;
        this._statusItem.label.text = _('Refreshing usage…');
        this._refreshInFlight = this._doRefresh(token)
            .catch(error => {
                this._handleRefreshError(error);
                return null;
            })
            .finally(() => {
                this._refreshInFlight = null;
            });

        return this._refreshInFlight;
    }

    async _doRefresh(token) {
        const summary = await this._client.fetchSummary(token);
        this._authFailed = false;
        this._lastSummary = summary;
        this._lastUpdated = GLib.DateTime.new_now_local();

        this._renderCurrentState();
    }

    _handleRefreshError(error) {
        if (error instanceof UsageApiError && error.isAuthError)
            this._authFailed = true;

        const detail = error instanceof Error ? error.message : _('Unknown error');
        this._summaryError = detail;
        const displayMode = this._getDisplayMode();

        const staleSummary = this._lastSummary
            ? `${formatSummary(this._lastSummary, displayMode)} (${_('stale')})`
            : _('Unable to load usage');

        this._statusItem.label.text = staleSummary;
        this._setLabel(this._lastSummary
            ? `${formatPanelLabel(this._lastSummary, displayMode)} !`
            : _('Codex: error'));

        if (this._lastUpdated) {
            this._lastUpdatedItem.label.text =
                `Last updated: ${this._lastUpdated.format('%F %R')} (${detail})`;
        } else {
            this._lastUpdatedItem.label.text = `Last updated: never (${detail})`;
        }

        this._renderWindows(this._lastSummary);
        logError(error, '[codex-usage-indicator] refresh failed');
    }

    _renderCurrentState() {
        if (!this._lastSummary)
            return;

        const displayMode = this._getDisplayMode();
        this._statusItem.label.text = formatSummary(this._lastSummary, displayMode);
        this._lastUpdatedItem.label.text = `Last updated: ${this._lastUpdated.format('%F %R')}`;
        this._setLabel(formatPanelLabel(this._lastSummary, displayMode));
        this._renderWindows(this._lastSummary);
    }

    _renderWindows(summary) {
        this._windowsSection.removeAll();

        const windows = getVisibleWindows(summary);
        if (windows.length === 0) {
            const placeholder = new PopupMenu.PopupMenuItem(
                _('No 5h or week data available.'),
                {reactive: false, can_focus: false},
            );
            this._windowsSection.addMenuItem(placeholder);
            return;
        }

        for (const window of windows) {
            const menuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const content = new St.BoxLayout({
                vertical: true,
                x_expand: true,
            });
            content.add_child(new St.Label({
                text: `${window.title}  ${formatWindowValue(window, this._getDisplayMode())}`,
                x_align: Clutter.ActorAlign.START,
            }));

            const subtitle = formatWindowSubtitle(window);
            if (subtitle) {
                content.add_child(new St.Label({
                    text: subtitle,
                    style_class: 'dim-label',
                    x_align: Clutter.ActorAlign.START,
                }));
            }

            menuItem.add_child(content);
            this._windowsSection.addMenuItem(menuItem);
        }
    }

    _restartRefreshTimer() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = null;
        }

        const interval = Math.max(
            60,
            this._settings.get_int('update-interval-seconds') || DEFAULT_UPDATE_INTERVAL_SECONDS,
        );

        this._refreshSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                void this.refresh();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _setLabel(text) {
        this._label.text = text;
    }

    _getDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        return mode === DISPLAY_MODE_USED ? DISPLAY_MODE_USED : DISPLAY_MODE_LEFT;
    }

    destroy() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = null;
        }

        this._settings.disconnectObject(this);
        this._client.destroy();
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._indicator = new CodexUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}

function formatPanelLabel(summary, displayMode) {
    if (displayMode === DISPLAY_MODE_USED) {
        if (summary.used !== null)
            return `Codex: ${formatCompact(summary.used)} used`;

        if (summary.percent !== null)
            return `Codex: ${Math.round(summary.percent * 100)}% used`;
    } else {
        if (summary.left !== null)
            return `Codex: ${formatCompact(summary.left)} left`;

        if (summary.leftPercent !== null)
            return `Codex: ${Math.round(summary.leftPercent * 100)}% left`;
    }

    return _('Codex: n/a');
}

function formatSummary(summary, displayMode) {
    const planType = summary.planType ? `${summary.planType} · ` : '';
    const resetText = formatResetText(summary.resetAt, summary.resetAfterSeconds);

    if (displayMode === DISPLAY_MODE_USED) {
        if (summary.used !== null && summary.limit !== null) {
            const percent = summary.percent !== null
                ? ` (${Math.round(summary.percent * 100)}% used)`
                : '';
            return `${planType}${formatNumber(summary.used)} used of ${formatNumber(summary.limit)}${percent}${resetText}`;
        }

        if (summary.used !== null)
            return `${planType}${formatNumber(summary.used)} used${resetText}`;

        if (summary.percent !== null)
            return `${planType}${Math.round(summary.percent * 100)}% used${resetText}`;
    } else {
        if (summary.left !== null && summary.limit !== null) {
            const percent = summary.leftPercent !== null
                ? ` (${Math.round(summary.leftPercent * 100)}% left)`
                : '';
            return `${planType}${formatNumber(summary.left)} left of ${formatNumber(summary.limit)}${percent}${resetText}`;
        }

        if (summary.left !== null)
            return `${planType}${formatNumber(summary.left)} left${resetText}`;

        if (summary.leftPercent !== null)
            return `${planType}${Math.round(summary.leftPercent * 100)}% left${resetText}`;
    }

    return _('Usage data available, but no totals were recognized.');
}

function getVisibleWindows(summary) {
    if (!summary)
        return [];

    const windows = [];
    if (summary.primaryWindow)
        windows.push({title: '5h', ...summary.primaryWindow});
    if (summary.weekWindow)
        windows.push({title: 'Week', ...summary.weekWindow});
    return windows;
}

function formatWindowValue(window, displayMode) {
    if (displayMode === DISPLAY_MODE_USED) {
        if (window.used !== null)
            return `${formatCompact(window.used)} used`;

        if (window.percent !== null)
            return `${Math.round(window.percent * 100)}% used`;
    } else {
        if (window.left !== null)
            return `${formatCompact(window.left)} left`;

        if (window.leftPercent !== null)
            return `${Math.round(window.leftPercent * 100)}% left`;
    }

    return _('Unavailable');
}

function formatWindowSubtitle(window) {
    const parts = [];

    if (window.limit !== null)
        parts.push(`${formatNumber(window.limit)} total`);

    if (window.used !== null)
        parts.push(`${formatNumber(window.used)} used`);

    if (window.resetAfterSeconds)
        parts.push(`resets in ${formatDuration(window.resetAfterSeconds)}`);

    return parts.join('  •  ');
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(Math.round(value));
}

function formatCompact(value) {
    return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
    }).format(value);
}

function formatResetText(resetAt, resetAfterSeconds) {
    if (typeof resetAfterSeconds === 'number' && Number.isFinite(resetAfterSeconds))
        return `, resets in ${formatDuration(resetAfterSeconds)}`;

    if (typeof resetAt === 'number' && Number.isFinite(resetAt)) {
        const resetDateTime = GLib.DateTime.new_from_unix_local(Math.round(resetAt));
        if (resetDateTime)
            return `, resets ${resetDateTime.format('%b %d %R')}`;
    }

    return '';
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0 && minutes > 0)
        return `${hours}h ${minutes}m`;

    if (hours > 0)
        return `${hours}h`;

    if (minutes > 0)
        return `${minutes}m`;

    return `${seconds}s`;
}
