# Chrome Web Store Listing

## Name
Pinned Tabs Sync

## Short Description (132 chars max)
Automatically syncs your pinned tabs across all your devices. Pin once, see everywhere.

## Category
Productivity

## Language
English

## Description

Chrome syncs your bookmarks, passwords, and extensions — but not your pinned tabs. Pinned Tabs Sync fixes that.

**How it works**
Pin a tab on your laptop, and it appears pinned on your desktop. Unpin it on one machine, and it's unpinned everywhere. Your pinned tabs stay consistent across all your devices, automatically.

**Features**
- Automatic sync — pinned tabs sync in the background whenever you pin, unpin, or open Chrome
- Unpin propagation — unpinning a tab on one device removes it on all others
- Smart merging — different pinned tabs on different machines are merged together
- Tab ordering — pinned tab order is preserved across devices
- No account needed — uses Chrome's built-in sync (the same one that syncs your bookmarks)
- Privacy-first — no external servers, no data collection, no tracking

**Requirements**
- Chrome Sync must be enabled (Settings → You and Google → Sync)
- That's it!

**How to use**
Just install the extension and pin tabs like you normally do. Everything syncs automatically. Click the extension icon to see your synced tabs and sync status.

**Open source**
This extension is open source: https://github.com/yanda/chrome-pinned-tabs-sync

---

## Permission Justifications

### tabs
"Read your browsing activity"
→ Required to read the URLs of pinned tabs so they can be synced across devices. The extension only reads URLs of pinned tabs and does not monitor or record browsing activity.

### storage
"Store data"
→ Required to save pinned tab URLs to Chrome's sync storage so they are available on all devices.

### alarms
"Schedule alarms"
→ Required for periodic sync checks (every 5 minutes) to ensure pinned tabs stay up to date across devices.

---

## Privacy Policy URL
https://yanda.github.io/chrome-pinned-tabs-sync/privacy-policy.html
