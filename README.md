# pi-kitty-theme-sync

A pi extension that generates a pi theme from the Kitty colors used by the
current Kitty window.

## Install

```bash
pi install git:github.com/Rousseau512/pi-kitty-theme-sync
```

The extension synchronizes on session startup and exposes:

```text
/kitty-theme-sync              # Read the current window colors
/kitty-theme-sync configured   # Read Kitty's configured colors
```

## Kitty setup

The extension uses Kitty's read-only remote-control command:

```bash
kitten @ get-colors
```

When pi runs inside Kitty, Kitty's socket environment is used automatically. A
socket-only setup is sufficient:

```conf
allow_remote_control socket-only
listen_on unix:kitty-{kitty_pid}
```

If remote control is unavailable, the extension falls back to parsing
`kitty.conf` and its `include` files (including `current-theme.conf`).

## Behavior

- Reads `background`, `foreground`, and ANSI `color0` through `color15`.
- Uses the current `KITTY_WINDOW_ID` when available, so another focused Kitty
  window does not affect pi's theme.
- Writes generated themes to `~/.pi/agent/themes/kitty-sync-<hash>.json`.
- Keeps only the newest generated Kitty theme.
- Theme changes made in Kitty after pi starts require `/kitty-theme-sync` or a
  new pi session.
