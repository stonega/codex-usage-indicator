# Codex Usage Indicator

GNOME Shell extension for GNOME Shell `50` that shows remaining Codex usage in the top bar and displays the current 5-hour and weekly windows in the popup.

## Features

- Automatically reads the bearer token from the local Codex CLI auth file at `~/.codex/auth.json`
- Top-bar label showing remaining or used Codex usage
- Popup with the latest fetch timestamp plus account and Codex model-specific 5-hour and weekly usage progress bars
- Configurable refresh interval
- Toggle to show `left` or `used` values

## Files

- `extension.js`: panel indicator and popup
- `prefs.js`: settings UI
- `codexAuth.js`: local Codex CLI auth reader
- `usageApi.js`: HTTP requests and response normalization
- `schemas/`: GSettings schema

## Local install

1. Sign in with the Codex CLI so `~/.codex/auth.json` exists:

   ```bash
   codex login
   ```

2. Copy this directory to `~/.local/share/gnome-shell/extensions/codex-usage-indicator@stone.dev`
3. Compile the schema in place:

   ```bash
   glib-compile-schemas schemas
   ```

4. Enable the extension:

   ```bash
   gnome-extensions enable codex-usage-indicator@stone.dev
   ```

5. Open extension preferences and set:
   - `Update interval`
   - `Display value`
   - optionally test the Codex CLI token

## Notes

- The extension intentionally does not store cookies or browser session state.
- The extension does not persist bearer tokens. It reads the current Codex CLI access token from `~/.codex/auth.json` when refreshing.
- If the Codex CLI token expires, run `codex login` or start Codex CLI to refresh it.
