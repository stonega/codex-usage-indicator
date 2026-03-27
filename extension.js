import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    BREAKDOWN_DAYS,
    DEFAULT_UPDATE_INTERVAL_SECONDS,
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
        this._lastBreakdown = [];
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
                void this.refresh({includeBreakdown: true});
        });

        this._settings.connectObject(
            'changed::update-interval-seconds',
            () => this._restartRefreshTimer(),
            this,
        );

        this._restartRefreshTimer();
        void this.refresh({includeBreakdown: false});
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
            _('Daily token usage'),
            {reactive: false, can_focus: false},
        );
        this.menu.addMenuItem(titleItem);

        this._breakdownSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._breakdownSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('Refresh now'), () => {
            void this.refresh({includeBreakdown: true, force: true});
        });
        this.menu.addAction(_('Settings'), () => {
            this._extension.openPreferences();
        });
    }

    async refresh({includeBreakdown = false, force = false} = {}) {
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
            this._renderBreakdown([]);
            return null;
        }

        this._summaryError = null;
        this._statusItem.label.text = _('Refreshing usage…');
        this._refreshInFlight = this._doRefresh(token, includeBreakdown)
            .catch(error => {
                this._handleRefreshError(error);
                return null;
            })
            .finally(() => {
                this._refreshInFlight = null;
            });

        return this._refreshInFlight;
    }

    async _doRefresh(token, includeBreakdown) {
        const tasks = [this._client.fetchSummary(token)];
        if (includeBreakdown)
            tasks.push(this._client.fetchDailyBreakdown(token));

        const [summary, breakdown] = await Promise.all(tasks);
        this._authFailed = false;
        this._lastSummary = summary;
        if (breakdown)
            this._lastBreakdown = breakdown;
        this._lastUpdated = GLib.DateTime.new_now_local();

        this._statusItem.label.text = formatSummary(summary);
        this._lastUpdatedItem.label.text = `Last updated: ${this._lastUpdated.format('%F %R')}`;
        this._setLabel(formatPanelLabel(summary));
        this._renderBreakdown(this._lastBreakdown);
    }

    _handleRefreshError(error) {
        if (error instanceof UsageApiError && error.isAuthError)
            this._authFailed = true;

        const detail = error instanceof Error ? error.message : _('Unknown error');
        this._summaryError = detail;

        const staleSummary = this._lastSummary
            ? `${formatSummary(this._lastSummary)} (${_('stale')})`
            : _('Unable to load usage');

        this._statusItem.label.text = staleSummary;
        this._setLabel(this._lastSummary
            ? `${formatPanelLabel(this._lastSummary)} !`
            : _('Codex: error'));

        if (this._lastUpdated) {
            this._lastUpdatedItem.label.text =
                `Last updated: ${this._lastUpdated.format('%F %R')} (${detail})`;
        } else {
            this._lastUpdatedItem.label.text = `Last updated: never (${detail})`;
        }

        this._renderBreakdown(this._lastBreakdown);
        logError(error, '[codex-usage-indicator] refresh failed');
    }

    _renderBreakdown(entries) {
        this._breakdownSection.removeAll();

        if (!entries || entries.length === 0) {
            const placeholder = new PopupMenu.PopupMenuItem(
                _('No daily breakdown data available.'),
                {reactive: false, can_focus: false},
            );
            this._breakdownSection.addMenuItem(placeholder);
            return;
        }

        for (const entry of entries.slice(0, BREAKDOWN_DAYS)) {
            const subtitle = formatBreakdownDetails(entry.details);
            const menuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const content = new St.BoxLayout({
                vertical: true,
                x_expand: true,
            });
            content.add_child(new St.Label({
                text: `${formatDate(entry.date)}  ${formatBreakdownValue(entry.total)}`,
                x_align: Clutter.ActorAlign.START,
            }));

            if (subtitle) {
                content.add_child(new St.Label({
                    text: subtitle,
                    style_class: 'dim-label',
                    x_align: Clutter.ActorAlign.START,
                }));
            }

            menuItem.add_child(content);
            this._breakdownSection.addMenuItem(menuItem);
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
                void this.refresh({includeBreakdown: this.menu.isOpen});
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _setLabel(text) {
        this._label.text = text;
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

function formatPanelLabel(summary) {
    if (summary.used !== null && summary.limit !== null)
        return `Codex: ${formatCompact(summary.used)} / ${formatCompact(summary.limit)}`;

    if (summary.used !== null)
        return `Codex: ${formatCompact(summary.used)}`;

    if (summary.percent !== null)
        return `Codex: ${Math.round(summary.percent * 100)}%`;

    return _('Codex: n/a');
}

function formatSummary(summary) {
    if (summary.used !== null && summary.limit !== null) {
        const percent = summary.percent !== null
            ? ` (${Math.round(summary.percent * 100)}%)`
            : '';
        return `${formatNumber(summary.used)} used of ${formatNumber(summary.limit)}${percent}`;
    }

    if (summary.used !== null)
        return `${formatNumber(summary.used)} used`;

    if (summary.percent !== null) {
        const planType = summary.planType ? `${summary.planType} plan, ` : '';
        const resetText = formatResetText(summary.resetAt, summary.resetAfterSeconds);
        return `${planType}${Math.round(summary.percent * 100)}% used${resetText}`;
    }

    return _('Usage data available, but no totals were recognized.');
}

function formatBreakdownDetails(details) {
    if (!details)
        return '';

    return Object.entries(details)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .filter(([, total]) => total > 0)
        .map(([name, total]) => `${name}: ${formatBreakdownValue(total)}`)
        .join('  •  ');
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

function formatBreakdownValue(value) {
    return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: value % 1 === 0 ? 0 : 1,
        maximumFractionDigits: 1,
    }).format(value);
}

function formatDate(rawDate) {
    const parsed = GLib.DateTime.new_from_iso8601(rawDate, null);
    if (!parsed)
        return rawDate;
    return parsed.format('%b %d');
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
