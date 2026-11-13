# Xfce panel adapter

The root extension targets **GNOME Shell only**. On Xfce, use the official [Generic Monitor panel plugin](https://docs.xfce.org/panel-plugins/xfce4-genmon-plugin/start) to run `genmon.js` every few minutes. The script reuses this repository's `codexAuth.js` and `usageApi.js`; it neither imports GNOME Shell nor makes a copy of the API parser. It outputs Genmon's documented `<txt>` and `<tool>` tags for the panel label and tooltip.

## Install

On Debian/Ubuntu/Xubuntu:

```bash
sudo apt install xfce4-genmon-plugin gjs gir1.2-soup-3.0
git clone https://github.com/WaylonSmithersJr/codex-usage-indicator.git "$HOME/.local/share/codex-usage-indicator"
```

Sign in with Codex CLI using file-backed credentials (`~/.codex/auth.json`). If your Codex CLI uses another home, you can pass its file explicitly. Add **Generic Monitor** to the Xfce panel, open **Properties**, and set **Command** to the absolute path command below (replace `<your-user>`):

```text
gjs -m /home/<your-user>/.local/share/codex-usage-indicator/xfce/genmon.js
```

Set **Period** to `300` seconds. Do not use an interval shorter than 60 seconds; the script makes an authenticated usage request each refresh. The initial run can take several seconds. The panel shows the remaining 5-hour allowance, or the weekly allowance if that is the only window available. Hover to see both windows, reset times and credits. Errors appear as `Codex ?` with a non-sensitive explanation in the tooltip.

Options after the script path:

- `--used`: show used rather than remaining percentage.
- `--label NAME`: replace the `Codex` label (quote names with spaces in the Genmon command).
- `--auth-file /absolute/path/auth.json`: use a separate Codex CLI login, useful for a second Genmon instance/account. `~/...` is also supported by the shared auth reader, but an absolute path avoids shell/Genmon expansion differences.

For example, a work account panel item can use:

```text
gjs -m /home/<your-user>/.local/share/codex-usage-indicator/xfce/genmon.js --auth-file /home/<your-user>/.codex-work/auth.json --label Work
```

Xfce's Genmon plugin supplies the panel lifecycle and refresh timer; this is **not** a GNOME extension converted to a native Xfce C plugin. The GNOME preferences UI and its account selector do not appear on Xfce. Use separate Genmon instances for multiple accounts. The Codex CLI file must contain a valid access token; this adapter does not refresh credentials itself. It sends the token only to the same `chatgpt.com` usage endpoints as the GNOME extension, never prints it, and prints generic errors rather than raw API responses. The existing GPL-3.0 license applies.

## Checks

```bash
node --test tests/xfceFormat.test.mjs tests/xfceRunner.test.mjs
gjs -m xfce/genmon.js --auth-file /tmp/codex-indicator-missing-auth.json
```

The second command should show a Genmon `Codex ?` element and safe login guidance. The fork's CI installs GJS/Libsoup and runs these checks plus the shared auth/API parser tests. A live visual panel test still requires a machine with Xfce and `xfce4-genmon-plugin`; this headless repository check does not claim that visual sign-off.
