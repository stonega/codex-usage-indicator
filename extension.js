import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {CodexCliAuthError, loadCodexCliAuth} from './codexAuth.js';
import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
} from './constants.js';
import {UsageApiClient, UsageApiError} from './usageApi.js';

const PROGRESS_BAR_WIDTH = 360;
const PROGRESS_BAR_HEIGHT = 7;
const PANEL_ICON_SIZE = 16;
const MENU_TITLE_STYLE = 'color: #fff;';

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Codex Usage Indicator'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new UsageApiClient();
        this._menuOpenStateChangedId = null;
        this._refreshSourceId = null;
        this._refreshInFlight = null;
        this._state = {
            summary: null,
            auth: null,
            lastUpdated: null,
            error: null,
        };

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev([
                this._extension.path,
                'icons',
                'codex-symbolic.svg',
            ])),
            icon_size: PANEL_ICON_SIZE,
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label = new St.Label({
            text: _('--'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this._menuOpenStateChangedId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                void this.refresh();
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
        this._renderCurrentState();
        void this.refresh();
    }

    _buildMenu() {
        this._usageSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._usageSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupBaseMenuItem();
        this._refreshItem.add_child(new St.Label({
            text: _('Refresh now'),
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        this._refreshTimestampLabel = new St.Label({
            text: formatLastUpdatedValue(this._state),
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.END,
        });
        this._refreshItem.add_child(this._refreshTimestampLabel);
        this._refreshItem.connect('activate', () => {
            void this.refresh();
        });
        this.menu.addMenuItem(this._refreshItem);

        this.menu.addAction(_('Settings'), () => {
            this._extension.openPreferences();
        });
    }

    async refresh() {
        if (this._refreshInFlight)
            return this._refreshInFlight;

        this._refreshTimestampLabel.text = _('Refreshing...');
        this._refreshInFlight = this._refreshUsage()
            .catch(error => {
                reportError(error, '[codex-usage-indicator] refresh failed');
            })
            .finally(() => {
                this._refreshInFlight = null;
                try {
                    this._renderCurrentState();
                } catch (error) {
                    reportError(error, '[codex-usage-indicator] render failed');
                }
            });

        return this._refreshInFlight;
    }

    async _refreshUsage() {
        try {
            const auth = await loadCodexCliAuth();
            const summary = await this._client.fetchSummary(auth.accessToken);
            this._state = {
                summary,
                auth,
                lastUpdated: GLib.DateTime.new_now_local(),
                error: null,
            };
        } catch (error) {
            this._state = {
                ...this._state,
                error: formatRefreshError(error),
            };
            reportError(error, '[codex-usage-indicator] usage refresh failed');
        }
    }

    _renderCurrentState() {
        const displayMode = this._getDisplayMode();

        this._setLabel(formatPanelLabel(this._state, displayMode));
        this._refreshTimestampLabel.text = formatLastUpdatedValue(this._state);
        this._renderUsage(this._state, displayMode);
    }

    _renderUsage(state, displayMode) {
        this._usageSection.removeAll();

        this._usageSection.addMenuItem(createInfoMenuItem(
            formatUsageTitle(state),
            formatUsageSummary(state, displayMode),
            formatUsageMeta(state),
        ));

        const windows = getVisibleWindows(state.summary);
        if (windows.length === 0) {
            this._usageSection.addMenuItem(new PopupMenu.PopupMenuItem(
                state.error ?? _('No 5h or week data available.'),
                {reactive: false, can_focus: false},
            ));
            return;
        }

        for (const window of windows) {
            this._usageSection.addMenuItem(createUsageProgressMenuItem(
                window.title,
                window,
                displayMode,
            ));
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
        if (this._menuOpenStateChangedId) {
            this.menu.disconnect(this._menuOpenStateChangedId);
            this._menuOpenStateChangedId = null;
        }
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

function reportError(error, context) {
    if (typeof globalThis.logError === 'function') {
        globalThis.logError(error, context);
        return;
    }

    const detail = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
    console.error(`${context}: ${detail}`);
}

function createInfoMenuItem(title, subtitle = '', meta = '') {
    const menuItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });

    const content = new St.BoxLayout({
        vertical: true,
        x_expand: true,
    });
    content.add_child(new St.Label({
        text: title,
        style: MENU_TITLE_STYLE,
        x_align: Clutter.ActorAlign.START,
    }));

    if (subtitle) {
        content.add_child(new St.Label({
            text: subtitle,
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.START,
        }));
    }

    if (meta) {
        content.add_child(new St.Label({
            text: meta,
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.START,
        }));
    }

    menuItem.add_child(content);
    return menuItem;
}

function createUsageProgressMenuItem(title, window, displayMode) {
    const menuItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });

    const content = new St.BoxLayout({
        vertical: true,
        x_expand: true,
    });

    content.add_child(new St.Label({
        text: title,
        style: MENU_TITLE_STYLE,
        x_align: Clutter.ActorAlign.START,
    }));

    content.add_child(new St.Label({
        text: formatWindowValue(window, displayMode),
        style: 'font-weight: 700; font-size: 1.08em;',
        x_align: Clutter.ActorAlign.START,
    }));

    content.add_child(createProgressBar(getWindowProgressPercent(window, displayMode), displayMode));

    const subtitle = formatWindowSubtitle(window);
    if (subtitle) {
        content.add_child(new St.Label({
            text: subtitle,
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.START,
        }));
    }

    menuItem.add_child(content);
    return menuItem;
}

function createProgressBar(percent, displayMode) {
    const normalized = normalizeProgressPercent(percent);
    const fillWidth = normalized === null
        ? 0
        : Math.round(PROGRESS_BAR_WIDTH * normalized);
    const fill = fillWidth > 0
        ? new St.Widget({
            width: fillWidth,
            height: PROGRESS_BAR_HEIGHT,
            style: [
                `background-color: ${getProgressColor(normalized, displayMode)};`,
                `border-radius: ${Math.floor(PROGRESS_BAR_HEIGHT / 2)}px;`,
            ].join(' '),
        })
        : null;

    const track = new St.Widget({
        width: PROGRESS_BAR_WIDTH,
        height: PROGRESS_BAR_HEIGHT,
        x_align: Clutter.ActorAlign.START,
        layout_manager: new Clutter.FixedLayout(),
        style: [
            'background-color: rgba(255, 255, 255, 0.16);',
            `border-radius: ${Math.floor(PROGRESS_BAR_HEIGHT / 2)}px;`,
            'margin-top: 6px;',
            'margin-bottom: 5px;',
        ].join(' '),
    });

    if (fill) {
        fill.set_position(0, 0);
        track.add_child(fill);
    }

    return track;
}

function formatPanelLabel(state, displayMode) {
    if (!state.summary && state.error)
        return _('!');

    if (!state.summary)
        return _('--');

    const value = displayMode === DISPLAY_MODE_USED ? state.summary.used : state.summary.left;
    const suffix = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');

    if (value !== null)
        return `${formatCompact(value)} ${suffix}`;

    const percent = displayMode === DISPLAY_MODE_USED
        ? state.summary.percent
        : state.summary.leftPercent;
    if (percent !== null)
        return `${Math.round(percent * 100)}% ${suffix}`;

    return _('n/a');
}

function formatLastUpdatedValue(state) {
    if (!state.lastUpdated)
        return _('never');

    return state.lastUpdated.format('%F %R');
}

function formatUsageTitle(state) {
    const email = state.summary?.email?.trim();
    if (email)
        return email;

    return _('Codex CLI account');
}

function formatUsageSummary(state, displayMode) {
    if (!state.summary && state.error)
        return state.error;

    if (!state.summary)
        return _('Waiting for data...');

    const parts = [];
    if (state.summary.planType)
        parts.push(formatPlanType(state.summary.planType));

    const resetCreditsText = formatResetCredits(state.summary.rateLimitResetCredits);
    if (resetCreditsText)
        parts.push(resetCreditsText);

    const summaryText = parts.length > 0
        ? parts.join(' · ')
        : formatSummary(state.summary, displayMode);
    return state.error ? `${summaryText} (${_('stale')})` : summaryText;
}

function formatUsageMeta(state) {
    const parts = [];

    const resetExpiryText = formatResetCreditExpiry(state.summary?.rateLimitResetCredits);
    if (resetExpiryText)
        parts.push(resetExpiryText);

    if (state.error && state.summary)
        parts.push(state.error);

    return parts.join('  •  ');
}

function formatRefreshError(error) {
    if (error instanceof CodexCliAuthError)
        return error.message;

    if (error instanceof UsageApiError && error.isAuthError)
        return _('Codex CLI token was rejected. Run codex login.');

    if (error instanceof Error)
        return error.message;

    return _('Unknown error');
}

function formatSummary(summary, displayMode) {
    const contextParts = [];
    if (summary.planType)
        contextParts.push(formatPlanType(summary.planType));
    if (summary.limitName)
        contextParts.push(summary.limitName);

    const summaryPrefix = contextParts.length > 0 ? `${contextParts.join(' · ')} · ` : '';
    const resetText = formatResetText(summary.resetAt, summary.resetAfterSeconds);

    if (displayMode === DISPLAY_MODE_USED) {
        if (summary.used !== null && summary.limit !== null) {
            const percent = summary.percent !== null
                ? ` (${Math.round(summary.percent * 100)}% used)`
                : '';
            return `${summaryPrefix}${formatNumber(summary.used)} used of ${formatNumber(summary.limit)}${percent}${resetText}`;
        }

        if (summary.used !== null)
            return `${summaryPrefix}${formatNumber(summary.used)} used${resetText}`;

        if (summary.percent !== null)
            return `${summaryPrefix}${Math.round(summary.percent * 100)}% used${resetText}`;
    } else {
        if (summary.left !== null && summary.limit !== null) {
            const percent = summary.leftPercent !== null
                ? ` (${Math.round(summary.leftPercent * 100)}% left)`
                : '';
            return `${summaryPrefix}${formatNumber(summary.left)} left of ${formatNumber(summary.limit)}${percent}${resetText}`;
        }

        if (summary.left !== null)
            return `${summaryPrefix}${formatNumber(summary.left)} left${resetText}`;

        if (summary.leftPercent !== null)
            return `${summaryPrefix}${Math.round(summary.leftPercent * 100)}% left${resetText}`;
    }

    return _('Usage data available, but no totals were recognized.');
}

function formatPlanType(planType) {
    const normalized = String(planType).trim();
    if (!normalized)
        return '';

    const knownNames = {
        free: 'Free',
        go: 'Go',
        plus: 'Plus',
        pro: 'Pro',
        team: 'Team',
        enterprise: 'Enterprise',
        edu: 'Edu',
        business: 'Business',
        prolite: 'Pro Lite',
    };

    return knownNames[normalized.toLowerCase()]
        ?? normalized
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, char => char.toUpperCase());
}

function formatResetCredits(rateLimitResetCredits) {
    const availableCount = rateLimitResetCredits?.availableCount;
    if (availableCount === null || availableCount === undefined)
        return '';

    return `${formatNumber(availableCount)} ${_('resets available')}`;
}

function formatResetCreditExpiry(rateLimitResetCredits) {
    const expiresAt = rateLimitResetCredits?.nextExpiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
        return '';

    const formatted = formatMenuDateTime(expiresAt);
    if (!formatted)
        return '';

    const availableCount = rateLimitResetCredits?.availableCount;
    const label = availableCount > 1 ? _('next reset expires') : _('reset expires');
    return `${label} ${formatted}`;
}

function formatMenuDateTime(unixSeconds) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.round(unixSeconds));
    const now = GLib.DateTime.new_now_local();

    if (!dateTime)
        return '';

    if (now && isSameDay(dateTime, now))
        return dateTime.format('%H:%M');

    return dateTime.format('%b %d, %Y %H:%M');
}

function getVisibleWindows(summary) {
    if (!summary)
        return [];

    const windows = [];
    addRateLimitWindows(windows, summary.rateLimit, null);
    addRateLimitWindows(windows, summary.codeReviewRateLimit, _('Code review'));

    for (const rateLimit of getAdditionalRateLimitItems(summary.additionalRateLimits))
        addRateLimitWindows(windows, rateLimit, rateLimit.limitName);

    if (windows.length === 0) {
        if (summary.primaryWindow)
            windows.push({title: formatLimitWindowTitle(null, 'primary', summary.primaryWindow), ...summary.primaryWindow});
        if (summary.weekWindow)
            windows.push({title: formatLimitWindowTitle(null, 'secondary', summary.weekWindow), ...summary.weekWindow});
    }

    return windows;
}

function addRateLimitWindows(output, rateLimit, limitName) {
    if (!rateLimit)
        return;

    let added = false;

    if (rateLimit.primaryWindow) {
        output.push({
            title: formatLimitWindowTitle(limitName, 'primary', rateLimit.primaryWindow),
            ...rateLimit.primaryWindow,
        });
        added = true;
    }

    if (rateLimit.secondaryWindow) {
        output.push({
            title: formatLimitWindowTitle(limitName, 'secondary', rateLimit.secondaryWindow),
            ...rateLimit.secondaryWindow,
        });
        added = true;
    }

    if (added)
        return;

    for (const window of rateLimit.windows ?? []) {
        output.push({
            title: formatLimitWindowTitle(limitName, null, window),
            ...window,
        });
    }
}

function getAdditionalRateLimitItems(value) {
    if (Array.isArray(value))
        return value;

    if (!value || typeof value !== 'object')
        return [];

    return Object.values(value);
}

function formatLimitWindowTitle(limitName, kind, window) {
    const prefix = typeof limitName === 'string' && limitName.trim()
        ? `${limitName.trim()} `
        : '';

    if (kind === 'primary' || isPrimaryWindow(window))
        return `${prefix}${_('5 hour usage limit')}`;

    if (kind === 'secondary' || isWeekWindow(window))
        return `${prefix}${_('Weekly usage limit')}`;

    const label = typeof window?.label === 'string' && window.label.trim()
        ? window.label.trim()
        : _('Usage');
    return `${prefix}${label} ${_('usage limit')}`;
}

function isPrimaryWindow(window) {
    return window?.windowSeconds !== null &&
        Math.abs(window.windowSeconds - 5 * 3600) <= 2 * 3600;
}

function isWeekWindow(window) {
    return window?.windowSeconds !== null &&
        Math.abs(window.windowSeconds - 7 * 86400) <= 86400;
}

function formatWindowValue(window, displayMode) {
    if (displayMode === DISPLAY_MODE_USED) {
        if (window.used !== null)
            return `${formatCompact(window.used)} used`;

        if (window.percent !== null)
            return `${Math.round(window.percent * 100)}% used`;
    } else {
        if (window.left !== null)
            return `${formatCompact(window.left)} remaining`;

        if (window.leftPercent !== null)
            return `${Math.round(window.leftPercent * 100)}% remaining`;
    }

    return _('Unavailable');
}

function formatWindowSubtitle(window) {
    const parts = [];

    const resetText = formatWindowReset(window);
    if (resetText)
        parts.push(resetText);

    if (window.limit !== null)
        parts.push(`${formatNumber(window.limit)} total`);

    if (window.used !== null)
        parts.push(`${formatNumber(window.used)} used`);

    return parts.join('  •  ');
}

function formatWindowReset(window) {
    if (typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)) {
        const resetDateTime = GLib.DateTime.new_from_unix_local(Math.round(window.resetAt));
        const now = GLib.DateTime.new_now_local();

        if (resetDateTime && now && isSameDay(resetDateTime, now))
            return `Resets ${resetDateTime.format('%H:%M')}`;

        if (resetDateTime)
            return `Resets ${resetDateTime.format('%b %d, %Y %H:%M')}`;
    }

    if (typeof window.resetAfterSeconds === 'number' && Number.isFinite(window.resetAfterSeconds))
        return `Resets in ${formatDuration(window.resetAfterSeconds)}`;

    return '';
}

function isSameDay(left, right) {
    return left.get_year() === right.get_year() &&
        left.get_month() === right.get_month() &&
        left.get_day_of_month() === right.get_day_of_month();
}

function getWindowUsedPercent(window) {
    if (typeof window.percent === 'number' && Number.isFinite(window.percent))
        return window.percent;

    if (typeof window.leftPercent === 'number' && Number.isFinite(window.leftPercent))
        return 1 - window.leftPercent;

    return null;
}

function getWindowProgressPercent(window, displayMode) {
    if (displayMode === DISPLAY_MODE_USED)
        return getWindowUsedPercent(window);

    if (typeof window.leftPercent === 'number' && Number.isFinite(window.leftPercent))
        return window.leftPercent;

    const usedPercent = getWindowUsedPercent(window);
    return usedPercent !== null ? 1 - usedPercent : null;
}

function normalizeProgressPercent(percent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent))
        return null;

    return Math.max(0, Math.min(percent, 1));
}

function getProgressColor(percent, displayMode) {
    if (displayMode !== DISPLAY_MODE_USED) {
        if (percent <= 0.1)
            return '#ed333b';

        if (percent <= 0.3)
            return '#f6d32d';

        return '#2ec27e';
    }

    if (percent >= 0.9)
        return '#ed333b';

    if (percent >= 0.7)
        return '#f6d32d';

    return '#62a0ea';
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
