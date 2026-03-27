# Pinned Tabs Sync

Chrome extension that syncs your pinned tabs across all your devices. Chrome doesn't do this natively — this fills the gap.

## Install

### From the Chrome Web Store

<!-- TODO: Add Chrome Web Store link after publishing -->
Coming soon.

### From source (developer mode)

1. Clone the repo:
   ```bash
   git clone git@github.com:yanda/chrome-pinned-tabs-sync.git
   ```

2. Open `chrome://extensions` in the Chrome profile you want to sync

3. Enable **Developer mode** (toggle in the top right)

4. Click **Load unpacked** and select the `chrome-pinned-tabs-sync` folder

5. Repeat for each profile and each machine

### Requirements

- Chrome with **Sync turned on** (Settings → You and Google → Sync)

## How it works

Pin a tab on your laptop, and it appears pinned on your desktop. Unpin it on one machine, and it's unpinned everywhere. Your pinned tabs stay consistent across all your devices, automatically.

- Monitors pinned tab changes and syncs them via `chrome.storage.sync`
- On browser startup or when sync data arrives, reconciles local tabs with the synced state
- Two machines with different pinned tabs converge to the **union** of both sets
- Unpins propagate via tombstones (7-day TTL), so unpinning on one machine unpins everywhere
- Duplicate pinned tabs are detected and cleaned up automatically
- A periodic 5-minute alarm acts as a safety net for any missed events

### Conflict resolution

| Scenario | Result |
|----------|--------|
| Machine A has tabs [a, b, c], Machine B has [a, d, e] | Both converge to [a, b, c, d, e] |
| Tab unpinned on Machine A | Unpinned on Machine B after sync |
| Tab re-pinned after being unpinned | Re-pin wins (most recent action takes precedence) |
| Same tabs, different order | Reorders to match without creating duplicates |

## Usage

The extension runs automatically in the background. Click the extension icon to see:

- **Sync status** — when the last sync occurred
- **Synced Tabs** — list of all pinned tab URLs being synced
- **Recent Unpins** — tabs that were recently unpinned
- **Sync Now** — manually trigger a sync
- **Reset** — clear all sync data (does not remove your current pinned tabs)

## Privacy

This extension does not collect, transmit, or store any data on external servers. All sync happens through Chrome's built-in sync infrastructure. See the full [Privacy Policy](https://yanda.github.io/chrome-pinned-tabs-sync/privacy-policy.html).

## Technical details

- **Manifest V3** service worker, no content scripts
- **Permissions**: `tabs` (read tab URLs), `storage` (sync data), `alarms` (periodic reconciliation)
- **Storage**: `chrome.storage.sync` — 100KB limit, more than enough for typical pinned tab counts
- **Sync scope**: Per-profile. Each Chrome profile syncs independently
- **Window scope**: Syncs pinned tabs from the main window only (lowest window ID)
- **URL filtering**: Only syncs `http://` and `https://` URLs (skips `chrome://` pages)

## License

MIT
