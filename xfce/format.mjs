// Xfce Genmon accepts <txt> and <tool> on stdout. Keep this module free of
// GNOME/GI imports so its presentation and escaping can be tested anywhere.
export function escapeMarkup(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function percent(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.max(0, Math.min(1, value)) * 100)
        : null;
}

function windowName(window) {
    return window?.windowSeconds >= 5 * 86400 || /week|secondary/i.test(`${window?.id ?? ''} ${window?.label ?? ''}`)
        ? 'Week' : '5h';
}

function resetTime(window) {
    const timestamp = window?.resetAt ?? (window?.resetAfterSeconds != null
        ? Date.now() / 1000 + window.resetAfterSeconds : null);
    return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp * 1000).toLocaleString() : null;
}

function creditLabel(credits) {
    if (!credits) return null;
    if (credits.unlimited) return 'Unlimited credits';
    const balance = Number(credits.balance);
    if (credits.balance == null || !Number.isFinite(balance)) return 'Credits unavailable';
    return `${new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(balance)} credits remaining`;
}

export function renderGenmon(summary, {label = 'Codex', mode = 'left'} = {}) {
    const windows = [summary?.primaryWindow, summary?.weekWindow].filter(Boolean)
        .filter((window, index, all) => all.findIndex(other => other.id === window.id) === index);
    const active = summary?.primaryWindow ?? summary?.weekWindow ?? null;
    const used = percent(active?.percent ?? summary?.percent);
    const shown = used === null ? null : mode === 'used' ? used : 100 - used;
    const caption = shown === null ? `${label} —` : `${label} ${shown}% ${mode === 'used' ? 'used' : 'left'}`;
    const tooltip = windows.map(window => {
        const usedValue = percent(window.percent);
        const value = usedValue === null ? 'unavailable'
            : `${mode === 'used' ? usedValue : 100 - usedValue}% ${mode === 'used' ? 'used' : 'left'}`;
        const reset = resetTime(window);
        return `${windowName(window)}: ${value}${reset ? ` · resets ${reset}` : ''}`;
    });
    const credits = creditLabel(summary?.credits);
    if (credits) tooltip.push(credits);
    if (tooltip.length === 0) tooltip.push('No usage windows available');
    return `<txt>${escapeMarkup(caption)}</txt><tool>${escapeMarkup(tooltip.join('\n'))}</tool>`;
}

export function renderGenmonError(message, {label = 'Codex'} = {}) {
    return `<txt>${escapeMarkup(label)} ?</txt><tool>${escapeMarkup(message)}</tool>`;
}
