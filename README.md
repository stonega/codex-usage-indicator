# Codex Usage Indicator

GNOME Shell extension for GNOME Shell `50` that shows Codex usage in the top bar and displays the last 7 days of daily token usage in the popup.

## Features

- Top-bar label showing `used / limit`
- Popup with the latest fetch timestamp and 7-day token breakdown
- Configurable refresh interval
- Bearer token stored in the GNOME keyring through Secret Service

## Files

- `extension.js`: panel indicator and popup
- `prefs.js`: settings UI
- `secret.js`: Secret Service token storage helpers
- `usageApi.js`: HTTP requests and response normalization
- `schemas/`: GSettings schema

## Local install

1. Copy this directory to `~/.local/share/gnome-shell/extensions/codex-usage-indicator@stone.dev`
2. Compile the schema in place:

   ```bash
   glib-compile-schemas schemas
   ```

3. Enable the extension:

   ```bash
   gnome-extensions enable codex-usage-indicator@stone.dev
   ```

4. Open extension preferences and set:
   - `Update interval`
   - `Bearer token`

## Notes

- The extension intentionally does not store cookies or browser session state.
- Only the bearer token is persisted, and it is stored in the GNOME keyring rather than GSettings.
