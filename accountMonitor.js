import {detectEarlyLimitResets} from './limitReset.js';

function emptyState() {
    return {summary: null, auth: null, lastUpdated: null, error: null, refreshing: false};
}

function authIdentity(auth) {
    const parts = [auth?.accountId, auth?.userId ?? auth?.email];
    return parts.some(value => typeof value === 'string' && value.trim())
        ? JSON.stringify(parts) : null;
}

function snapshot(state) {
    return {
        accountId: authIdentity({
            accountId: state.auth?.accountId ?? state.summary?.accountId,
            userId: state.auth?.userId ?? state.summary?.userId,
            email: state.auth?.email ?? state.summary?.email,
        }),
        observedAt: state.lastUpdated,
        summary: state.summary,
    };
}

export class AccountMonitor {
    constructor({loadAuth, fetchSummary, formatError = error => error.message,
        now = () => Date.now() / 1000, createCancellable = () => null,
        onChanged = () => {}, onLimitResets = () => {}, onError = () => {}}) {
        Object.assign(this, {loadAuth, fetchSummary, formatError, now,
            createCancellable, onChanged, onLimitResets, onError});
        this._entries = new Map();
        this._destroyed = false;
    }

    setProfiles(profiles) {
        if (this._destroyed)
            return;
        const previous = this._entries;
        this._entries = new Map(profiles.map(profile => {
            const entry = previous.get(profile.id);
            if (entry && entry.profile.authPath === profile.authPath) {
                entry.profile = profile;
                return [profile.id, entry];
            }
            return [profile.id, {profile, state: emptyState(), inFlight: null, cancellable: null}];
        }));
        for (const [id, entry] of previous) {
            if (this._entries.get(id) !== entry)
                entry.cancellable?.cancel();
        }
    }

    getState(id) {
        return this._entries.get(id)?.state ?? emptyState();
    }

    async refresh() {
        await Promise.allSettled([...this._entries.keys()].map(id => this.refreshAccount(id)));
    }

    refreshAccount(id) {
        const entry = this._entries.get(id);
        if (!entry || this._destroyed)
            return Promise.resolve();
        if (entry.inFlight)
            return entry.inFlight;

        entry.cancellable = this.createCancellable();
        entry.state = {...entry.state, refreshing: true};
        entry.inFlight = this._refreshEntry(entry).finally(() => {
            entry.inFlight = null;
            entry.cancellable = null;
            if (this._isCurrent(entry)) {
                entry.state = {...entry.state, refreshing: false};
                this.onChanged(entry.profile);
            }
        });
        this.onChanged(entry.profile);
        return entry.inFlight;
    }

    async _refreshEntry(entry) {
        try {
            const auth = await this.loadAuth({path: entry.profile.authPath, cancellable: entry.cancellable});
            if (!this._isCurrent(entry))
                return;
            this._clearChangedIdentity(entry, auth);
            const summary = await this.fetchSummary(auth.accessToken, auth.accountId, entry.cancellable);
            if (!this._isCurrent(entry))
                return;

            // Retain identity metadata, never the access or refresh token.
            const state = {
                summary,
                auth: {accountId: auth.accountId, userId: auth.userId, email: auth.email},
                lastUpdated: this.now(),
                error: null,
                refreshing: true,
            };
            const resets = detectEarlyLimitResets(snapshot(entry.state), snapshot(state));
            entry.state = state;
            if (resets.length)
                this.onLimitResets(entry.profile, resets);
        } catch (error) {
            if (!this._isCurrent(entry))
                return;
            // An expired replacement token still identifies a different login.
            if (error.identity)
                this._clearChangedIdentity(entry, error.identity);
            entry.state = {...entry.state, error: this.formatError(error, entry.profile)};
            this.onError(error, entry.profile);
        }
    }

    _clearChangedIdentity(entry, auth) {
        if (entry.state.auth && authIdentity(entry.state.auth) !== authIdentity(auth)) {
            entry.state = {...emptyState(), refreshing: true};
            this.onChanged(entry.profile);
        }
    }

    _isCurrent(entry) {
        return !this._destroyed && this._entries.get(entry.profile.id) === entry;
    }

    destroy() {
        this._destroyed = true;
        for (const entry of this._entries.values())
            entry.cancellable?.cancel();
        this._entries.clear();
    }
}
