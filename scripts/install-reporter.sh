#!/bin/bash
# Install the reporter cron job.
# macOS: launchd plist at ~/Library/LaunchAgents/com.tokenfx.reporter.plist
# Linux: systemd user unit at ~/.config/systemd/user/tokenfx-reporter.{service,timer}
#
# Both platforms schedule `pnpm reporter:run` hourly. The runtime config
# gate (REQ-11) means this is safe to install before configuring — the
# cron just exits 0 with an info log until `data/reporter-config.json`
# exists.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PLATFORM=$(uname -s)

case "$PLATFORM" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.tokenfx.reporter.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tokenfx.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>cd $REPO_ROOT && pnpm reporter:run</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed launchd job: com.tokenfx.reporter (hourly)"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/tokenfx-reporter.service" <<EOF
[Unit]
Description=TokenFx reporter (push aggregates to central server)
[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
ExecStart=/bin/bash -c 'pnpm reporter:run'
EOF
    cat > "$UNIT_DIR/tokenfx-reporter.timer" <<EOF
[Unit]
Description=Hourly TokenFx reporter push
[Timer]
OnUnitActiveSec=1h
Unit=tokenfx-reporter.service
[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now tokenfx-reporter.timer
    echo "Installed systemd user timer: tokenfx-reporter.timer (hourly)"
    ;;
  *)
    echo "Unsupported platform: $PLATFORM" >&2
    exit 1
    ;;
esac
