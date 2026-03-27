# Pinned Tabs Sync

Chrome extension that syncs pinned tabs across machines within the same Chrome profile. Chrome doesn't do this natively — this fills the gap.

## How it works

- Monitors pinned tab changes (pin, unpin, close) and writes the state to `chrome.storage.sync`
- On browser startup or when sync data arrives from another machine, it reconciles local tabs with the synced state
- Two machines with different pinned tabs converge to the **union** of both sets
- Unpins propagate across machines via tombstones (7-day TTL), so unpinning on one machine unpins everywhere
- A periodic 5-minute alarm acts as a safety net for any missed events

### Conflict resolution

| Scenario | Result |
|----------|--------|
| Machine A has tabs [a, b, c], Machine B has [a, d, e] | Both converge to [a, b, c, d, e] |
| Tab unpinned on Machine A | Unpinned on Machine B after sync |
| Tab re-pinned after being unpinned | Re-pin wins (most recent action takes precedence) |

## Setup

### Prerequisites

- Chrome with **Sync turned on** for each profile (Settings → You and Google → Sync)
- Developer Mode enabled in `chrome://extensions`

### Install

1. Clone the repo on each machine:
   ```bash
   git clone git@github.com:yanda/chrome-pinned-tabs-sync.git
   ```

2. Open `chrome://extensions` in the Chrome profile you want to sync

3. Enable **Developer mode** (toggle in the top right)

4. Click **Load unpacked** and select the `chrome-pinned-tabs-sync` folder

5. Repeat for each profile and each machine

### Verify

- Pin a tab in Chrome
- Click the extension icon — you should see the tab listed under "Synced Tabs"
- On another machine (same profile), open Chrome and the pinned tab should appear

## Usage

The extension runs automatically in the background. Click the extension icon to see:

- **Last synced** — when the most recent sync occurred
- **Synced Tabs** — list of all pinned tab URLs being synced
- **Recent Unpins** — tabs that were recently unpinned (tombstones, expire after 7 days)
- **Sync Now** — manually trigger a sync
- **Reset** — clear all sync data (does not remove your current pinned tabs)

## Technical details

- **Manifest V3** service worker, no content scripts
- **Permissions**: `tabs` (read tab URLs), `storage` (sync data), `alarms` (periodic reconciliation)
- **Storage**: `chrome.storage.sync` — 100KB limit, more than enough for typical pinned tab counts
- **Sync scope**: Per-profile. Each Chrome profile syncs independently
- **Window scope**: Syncs pinned tabs from the main window only (lowest window ID)
- **URL filtering**: Only syncs `http://` and `https://` URLs (skips `chrome://` pages)
