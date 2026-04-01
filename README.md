# Codex Usage Indicator

GNOME Shell extension for GNOME Shell `50` that shows remaining Codex usage in the top bar and displays the current 5-hour and weekly windows in the popup.

## Features

- Multiple account profiles with per-account bearer tokens
- Multi-select account visibility for both the top-bar label and popup menu
- Top-bar label showing remaining or used usage for the selected accounts
- Popup with the latest fetch timestamp plus 5-hour and weekly usage windows for each selected account
- Cached account profile lookups from `/backend-api/me` for display names and initials
- Configurable refresh interval
- Toggle to show `left` or `used` values
- Bearer tokens stored in the GNOME keyring through Secret Service

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
   - one or more accounts
   - each account's `Bearer token`
   - which accounts should be shown

## Notes

- The extension intentionally does not store cookies or browser session state.
- Account metadata and visibility are stored in GSettings.
- Cached user profile data from `/backend-api/me` is stored in GSettings per account.
- Bearer tokens are persisted in the GNOME keyring rather than GSettings.
