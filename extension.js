import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    ensureLegacyAccountMigration,
    getAccountDisplayName,
    getAccountShortName,
    getVisibleAccounts,
    readAccounts,
    updateAccountProfile,
} from './accounts.js';
import {
    DEFAULT_UPDATE_INTERVAL_SECONDS,
    DISPLAY_MODE_LEFT,
    DISPLAY_MODE_USED,
} from './constants.js';
import {loadBearerTokenSync} from './secret.js';
import {shouldRefreshProfile, UsageApiClient} from './usageApi.js';

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('Codex Usage Indicator'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new UsageApiClient();

        ensureLegacyAccountMigration(this._settings);

        this._refreshSourceId = null;
        this._refreshInFlight = null;
        this._accountStates = new Map();

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
        this._settings.connectObject(
            'changed::accounts-json',
            () => this._handleAccountsChanged(),
            this,
        );
        this._settings.connectObject(
            'changed::visible-account-ids',
            () => this._handleAccountsChanged(),
            this,
        );

        this._restartRefreshTimer();
        this._renderCurrentState();
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
            _('Accounts'),
            {reactive: false, can_focus: false},
        );
        this.menu.addMenuItem(titleItem);

        this._accountsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._accountsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction(_('Refresh now'), () => {
            void this.refresh();
        });
        this.menu.addAction(_('Settings'), () => {
            this._extension.openPreferences();
        });
    }

    _handleAccountsChanged() {
        ensureLegacyAccountMigration(this._settings);

        const currentAccountIds = new Set(readAccounts(this._settings).map(account => account.id));
        for (const accountId of this._accountStates.keys()) {
            if (!currentAccountIds.has(accountId))
                this._accountStates.delete(accountId);
        }

        this._renderCurrentState();
        void this.refresh();
    }

    async refresh() {
        if (this._refreshInFlight)
            return this._refreshInFlight;

        const visibleAccounts = getVisibleAccounts(this._settings);
        if (visibleAccounts.length === 0) {
            this._renderCurrentState();
            return null;
        }

        this._statusItem.label.text = _('Refreshing usage…');
        this._refreshInFlight = Promise.all(visibleAccounts.map(account => this._refreshAccount(account)))
            .catch(error => {
                logError(error, '[codex-usage-indicator] refresh failed');
            })
            .finally(() => {
                this._refreshInFlight = null;
                this._renderCurrentState();
            });

        return this._refreshInFlight;
    }

    async _refreshAccount(account) {
        const state = this._getAccountState(account);
        const token = loadBearerTokenSync(account.id);

        if (!token) {
            state.error = _('Bearer token required');
            state.authFailed = false;
            return;
        }

        try {
            state.summary = await this._client.fetchSummary(token);
            state.lastUpdated = GLib.DateTime.new_now_local();
            if (shouldRefreshProfile(account.profile)) {
                try {
                    const profile = await this._client.fetchMe(token);
                    updateAccountProfile(this._settings, account.id, profile);
                    state.account = {
                        ...state.account,
                        profile,
                    };
                } catch (error) {
                    logError(error, `[codex-usage-indicator] profile refresh failed for ${getAccountDisplayName(account)}`);
                }
            }
            state.error = null;
            state.authFailed = false;
        } catch (error) {
            state.error = error instanceof Error ? error.message : _('Unknown error');
            state.authFailed = Boolean(error?.isAuthError);
            logError(error, `[codex-usage-indicator] refresh failed for ${account.name}`);
        }
    }

    _getAccountState(account) {
        const existing = this._accountStates.get(account.id);
        if (existing) {
            existing.account = account;
            return existing;
        }

        const state = {
            account,
            summary: null,
            lastUpdated: null,
            error: null,
            authFailed: false,
        };
        this._accountStates.set(account.id, state);
        return state;
    }

    _renderCurrentState() {
        const visibleAccounts = getVisibleAccounts(this._settings);
        const displayMode = this._getDisplayMode();

        if (visibleAccounts.length === 0) {
            this._statusItem.label.text = _('No accounts selected.');
            this._lastUpdatedItem.label.text = _('Last updated: never');
            this._setLabel(_('Codex: no accounts'));
            this._renderAccounts([]);
            return;
        }

        const states = visibleAccounts.map(account => this._getAccountState(account));
        const freshStates = states.filter(state => state.summary && !state.error);
        const staleStates = states.filter(state => state.summary && state.error);
        const failingStates = states.filter(state => !state.summary && state.error);

        this._setLabel(formatPanelLabel(states, displayMode));
        this._statusItem.label.text = formatStatusLine(states, freshStates, staleStates, failingStates);
        this._lastUpdatedItem.label.text = formatLastUpdatedLine(states);
        this._renderAccounts(states);
    }

    _renderAccounts(states) {
        this._accountsSection.removeAll();

        if (states.length === 0) {
            this._accountsSection.addMenuItem(new PopupMenu.PopupMenuItem(
                _('Select at least one account in Settings.'),
                {reactive: false, can_focus: false},
            ));
            return;
        }

        states.forEach((state, index) => {
            if (index > 0)
                this._accountsSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._accountsSection.addMenuItem(createInfoMenuItem(
                getAccountMenuTitle(state.account),
                formatAccountSummary(state, this._getDisplayMode()),
                formatAccountUpdated(state),
            ));

            const windows = getVisibleWindows(state.summary);
            if (windows.length === 0) {
                this._accountsSection.addMenuItem(new PopupMenu.PopupMenuItem(
                    _('No 5h or week data available.'),
                    {reactive: false, can_focus: false},
                ));
                return;
            }

            for (const window of windows) {
                this._accountsSection.addMenuItem(createInfoMenuItem(
                    `${getAccountDisplayName(state.account)} · ${window.title}`,
                    formatWindowValue(window, this._getDisplayMode()),
                    formatWindowSubtitle(window),
                ));
            }
        });
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

function formatPanelLabel(states, displayMode) {
    const parts = states.map(state => formatAccountPanelPart(state, displayMode));
    return `Codex: ${parts.join(' | ')}`;
}

function formatAccountPanelPart(state, displayMode) {
    const prefix = getAccountShortName(state.account);

    if (!state.summary && state.error)
        return `${prefix} !`;

    if (!state.summary)
        return `${prefix} --`;

    const value = displayMode === DISPLAY_MODE_USED ? state.summary.used : state.summary.left;
    const suffix = displayMode === DISPLAY_MODE_USED ? _('used') : _('left');

    if (value !== null)
        return `${prefix} ${formatCompact(value)} ${suffix}`;

    const percent = displayMode === DISPLAY_MODE_USED
        ? state.summary.percent
        : state.summary.leftPercent;
    if (percent !== null)
        return `${prefix} ${Math.round(percent * 100)}% ${suffix}`;

    return `${prefix} n/a`;
}

function formatStatusLine(states, freshStates, staleStates, failingStates) {
    if (states.length === 0)
        return _('No accounts selected.');

    const parts = [];
    if (freshStates.length > 0)
        parts.push(`${freshStates.length} ${_('fresh')}`);
    if (staleStates.length > 0)
        parts.push(`${staleStates.length} ${_('stale')}`);
    if (failingStates.length > 0)
        parts.push(`${failingStates.length} ${_('failing')}`);

    return parts.length > 0
        ? `${states.length} ${_('accounts selected')} · ${parts.join(' · ')}`
        : `${states.length} ${_('accounts selected')}`;
}

function formatLastUpdatedLine(states) {
    const timestamps = states
        .map(state => state.lastUpdated)
        .filter(Boolean)
        .sort((left, right) => left.to_unix() - right.to_unix());

    if (timestamps.length === 0)
        return _('Last updated: never');

    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];
    if (first.to_unix() === last.to_unix())
        return `Last updated: ${last.format('%F %R')}`;

    return `Last updated: ${first.format('%F %R')} - ${last.format('%F %R')}`;
}

function formatAccountSummary(state, displayMode) {
    if (!state.summary && state.error)
        return state.error;

    if (!state.summary)
        return _('Waiting for data…');

    const summaryText = formatSummary(state.summary, displayMode);
    return state.error ? `${summaryText} (${_('stale')})` : summaryText;
}

function formatAccountUpdated(state) {
    if (!state.lastUpdated && state.error)
        return state.error;

    if (!state.lastUpdated)
        return _('Last updated: never');

    return state.error
        ? `Last updated: ${state.lastUpdated.format('%F %R')} (${state.error})`
        : `Last updated: ${state.lastUpdated.format('%F %R')}`;
}

function getAccountMenuTitle(account) {
    const displayName = getAccountDisplayName(account);
    const email = account.profile?.email?.trim();

    if (email)
        return `${displayName} (${email})`;

    return displayName;
}

function formatSummary(summary, displayMode) {
    const planType = summary.planType ? `${summary.planType.toUpperCase()} · ` : '';
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
