# Codex Usage Indicator

GNOME Shell extension for GNOME Shell `45`–`51` that shows remaining Codex usage in the top bar and displays the current 5-hour and weekly windows in the popup.

**Xfce:** GNOME Shell extensions cannot run in the Xfce panel. This fork also includes a [Generic Monitor (Genmon) adapter](xfce/README.md) that uses the same Codex auth reader and usage API normalizer; it does not require GNOME Shell.

## Features

- Automatically reads the bearer token from the local Codex CLI auth file at `~/.codex/auth.json`
- Monitor multiple Codex accounts using a separate CLI auth file for each account
- Choose the account shown in the top bar from the popup or preferences; expand any account in the popup for its usage, credits and last update
- Top-bar label showing remaining or used Codex usage
- Popup with the latest fetch timestamp plus account and Codex model-specific 5-hour and weekly usage progress bars
- Remaining credit balance in the popup, including zero balances and unlimited credits when available
- Positive or unlimited credits also appear in the top bar when either the 5-hour or weekly allowance has 10% or less remaining; exhausted limits show credits alone. Zero, unavailable, or invalid credit balances keep the original panel behavior
- Notification when a limit resets to at least 95% remaining before its scheduled reset
- Configurable refresh interval
- Toggle to show `left` or `used` values
- Choose whether reset credit expiries show time left or local date and time

## Files

- `extension.js`: panel indicator and popup
- `prefs.js`: settings UI
- `codexAuth.js`: local Codex CLI auth reader
- `accountProfiles.js`: profile configuration and panel account selection
- `accountMonitor.js`: independent account refreshes, cached state and reset notifications
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
   - `Reset credit expiry`
   - optionally test the Codex CLI token

## Multiple accounts

The default **Codex CLI** account continues to use `CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is unset in GNOME Shell's environment. Existing installations need no configuration changes.

Use the pencil button beside the main account in preferences to edit its alias. The name updates immediately in the panel, popup, selector and notifications. Leave the alias empty to restore **Codex CLI**.

1. Maintain each additional login in its own Codex home. For example:

   ```bash
   CODEX_HOME="$HOME/.codex-work" codex -c 'cli_auth_credentials_store="file"' login
   ```

2. Open the extension preferences and click **Add account**. Enter a short name and select the corresponding `auth.json`, such as `~/.codex-work/auth.json`. Absolute paths and `~/` paths are supported.
3. Select **Panel account** in preferences or in the popup to choose which account appears in the top bar. All configured accounts remain visible in the popup, with expandable usage details.
4. Expand an account in preferences to check its local token or test the connection. Additional profiles can be edited or removed; removing a profile leaves its auth file untouched. Removing the selected profile returns the panel to the default account.

Accounts refresh independently. A failed or expired login does not stop the others from updating. Cached data for a failed account is marked stale, and reset notifications identify the account.

The extension reads tokens but does not renew them or change the account used by Codex. Keep each login current by using Codex with its matching `CODEX_HOME` and file storage setting; to sign in again, use the same command as above. Static copies of auth files can expire. File-based credential storage is required; OS keyring and ephemeral credentials are not read by this extension. GSettings stores only profile IDs, names, auth file paths and the selected panel account.

## Tests

Run the test suite with:

```bash
gjs -m tests/usageApi.test.js
gjs -m tests/usageApiHttp.test.js
gjs -m tests/usageError.test.js
gjs -m tests/limitReset.test.js
gjs -m tests/resetCreditExpiry.test.js
gjs -m tests/menuLayout.test.js
gjs -m tests/codexAuth.test.js
gjs -m tests/accountProfiles.test.js
gjs -m tests/accountMonitor.test.js
glib-compile-schemas --strict --dry-run schemas
```

The GTK preferences test uses an in-memory settings backend and fabricated credentials. On a headless system, run it with Xvfb:

```bash
xvfb-run -a gjs -m tests/preferences.test.js
```

## Notes

- The extension intentionally does not store cookies or browser session state.
- The extension does not persist bearer tokens. It reads each account's current Codex CLI access token from its auth file when refreshing.
- If a Codex CLI token expires, sign in or start Codex CLI with that account's `CODEX_HOME` to refresh it.

[![Listed on Vibe GNOME](https://vibe-gnome.org/badges/listed-on-vibe-gnome-light.svg)](https://vibe-gnome.org/extensions/1/codex-usage-indicator)
