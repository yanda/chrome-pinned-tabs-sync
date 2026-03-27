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

- Monitors pinned tab changes, tab closures, URL navigations, and reorders — syncs them via `chrome.storage.sync`
- On browser startup or when sync data arrives, reconciles local tabs with the synced state
- Two machines with different pinned tabs converge to the **union** of both sets
- Unpins propagate via tombstones (7-day TTL), so unpinning on one machine unpins everywhere
- URL redirects are detected by tab ID (or origin fallback after restart) — the tab keeps its position instead of being treated as an unpin + new pin
- Tab reordering (dragging a pinned tab) syncs the new order to other machines
- Duplicate pinned tabs are detected and cleaned up automatically
- A periodic 5-minute alarm acts as a safety net for any missed events

### Fresh install on a new machine

When you install the extension on a new machine with the same Chrome profile, it **merges** both sets of pinned tabs. Tabs already synced from other machines are created locally, and any tabs already pinned on the new machine are added to the synced set. If both machines have the same URL pinned, no duplicate is created. The new machine's own tabs are appended after the inherited tabs.

### Conflict resolution

| Scenario | Result |
|----------|--------|
| Machine A has tabs [a, b, c], Machine B has [a, d, e] | Both converge to [a, b, c, d, e] |
| Tab unpinned on Machine A | Unpinned on Machine B after sync |
| Tab re-pinned after being unpinned | Re-pin wins (most recent action takes precedence) |
| Tab reordered on Machine A | Machine B adopts the new order after sync |
| Pinned tab redirects (e.g., http → https) | URL updates in place, tab keeps its position |

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
- **Storage**: `chrome.storage.sync` — 8KB per item, 100KB total. Tombstones are automatically trimmed if storage approaches the limit
- **Sync scope**: Per-profile. Each Chrome profile syncs independently
- **Window scope**: Syncs pinned tabs from the main window only (lowest window ID)
- **URL filtering**: Only syncs `http://` and `https://` URLs (skips `chrome://` pages)

## License

MIT
