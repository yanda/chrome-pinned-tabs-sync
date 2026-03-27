// === Constants ===
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 2000;
const ALARM_NAME = 'reconcile';
const ALARM_PERIOD_MINUTES = 5;
const LOG_PREFIX = '[PinnedTabsSync]';

// === State (in-memory, resets on worker restart) ===
let isSyncing = false;
let debounceTimer = null;

// === URL Utilities ===

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function isSyncableUrl(url) {
  return url && (url.startsWith('http://') || url.startsWith('https://'));
}

// === Main Window Helper ===

async function getMainWindowId() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (windows.length === 0) return null;
  // Use the window with the lowest ID (typically the first opened)
  windows.sort((a, b) => a.id - b.id);
  return windows[0].id;
}

// === Core Reconcile ===

async function reconcile(trigger) {
  if (isSyncing) {
    console.log(LOG_PREFIX, 'Skipping reconcile (already syncing), trigger:', trigger);
    return;
  }
  isSyncing = true;
  console.log(LOG_PREFIX, 'Reconcile started, trigger:', trigger);

  try {
    // 1. Read remote state
    const syncData = await chrome.storage.sync.get(['pinnedTabs', 'tombstones', 'meta']);
    const remotePinned = syncData.pinnedTabs || {};
    const tombstones = syncData.tombstones || {};
    const now = Date.now();

    // 2. Read local state
    const mainWindowId = await getMainWindowId();
    if (mainWindowId === null) {
      console.log(LOG_PREFIX, 'No browser window found, skipping');
      return;
    }

    const allPinnedTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
    const localPinned = allPinnedTabs
      .filter(t => isSyncableUrl(t.url))
      .sort((a, b) => a.index - b.index);

    const currentLocalUrls = new Map();
    for (const tab of localPinned) {
      currentLocalUrls.set(normalizeUrl(tab.url), tab);
    }

    // 3. Read previous snapshot
    const localData = await chrome.storage.local.get(['localSnapshot']);
    const previousSnapshot = new Set(localData.localSnapshot || []);

    // 4. Detect local unpins (was in snapshot, no longer pinned locally)
    for (const url of previousSnapshot) {
      if (!currentLocalUrls.has(url)) {
        console.log(LOG_PREFIX, 'Detected local unpin:', url);
        tombstones[url] = { removedAt: now };
        delete remotePinned[url];
      }
    }

    // 5. Detect new local pins (pinned locally, not in remote)
    let maxOrder = 0;
    for (const entry of Object.values(remotePinned)) {
      if ((entry.order || 0) > maxOrder) maxOrder = entry.order || 0;
    }

    for (const [url] of currentLocalUrls) {
      if (!remotePinned[url]) {
        // Check if there's a very recent tombstone (< 60s) — likely our own unpin propagating
        if (tombstones[url] && (now - tombstones[url].removedAt) < 60000) {
          continue;
        }
        maxOrder++;
        remotePinned[url] = { addedAt: now, order: maxOrder };
        delete tombstones[url]; // Clear any old tombstone
        console.log(LOG_PREFIX, 'New local pin:', url);
      }
    }

    // 6. Expire old tombstones
    for (const [url, ts] of Object.entries(tombstones)) {
      if (now - ts.removedAt > TOMBSTONE_TTL_MS) {
        delete tombstones[url];
      }
    }

    // 7. Apply tombstones — remove entries where tombstone is newer than addedAt
    for (const [url, ts] of Object.entries(tombstones)) {
      if (remotePinned[url] && ts.removedAt > remotePinned[url].addedAt) {
        delete remotePinned[url];
      }
    }

    // 8. Compute desired URL set
    const desiredUrls = new Set(Object.keys(remotePinned));

    // 9. Create missing pinned tabs locally
    for (const url of desiredUrls) {
      if (!currentLocalUrls.has(url)) {
        console.log(LOG_PREFIX, 'Creating pinned tab:', url);
        try {
          await chrome.tabs.create({
            url: url,
            pinned: true,
            active: false,
            windowId: mainWindowId
          });
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to create tab:', url, err);
        }
      }
    }

    // 10. Unpin tabs that have been tombstoned
    for (const [url, tab] of currentLocalUrls) {
      if (!desiredUrls.has(url)) {
        console.log(LOG_PREFIX, 'Unpinning tab:', url);
        try {
          await chrome.tabs.update(tab.id, { pinned: false });
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to unpin tab:', url, err);
        }
      }
    }

    // 11. Reorder pinned tabs to match desired order
    const orderedUrls = [...desiredUrls].sort(
      (a, b) => (remotePinned[a].order || 0) - (remotePinned[b].order || 0)
    );

    const freshPinnedTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
    for (let i = 0; i < orderedUrls.length; i++) {
      const url = orderedUrls[i];
      const tab = freshPinnedTabs.find(t => normalizeUrl(t.url) === url);
      if (tab && tab.index !== i) {
        try {
          await chrome.tabs.move(tab.id, { index: i });
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to reorder tab:', url, err);
        }
      }
    }

    // 12. Update local snapshot
    const finalSnapshot = [...desiredUrls];
    await chrome.storage.local.set({ localSnapshot: finalSnapshot });

    // 13. Write back to sync
    await chrome.storage.sync.set({
      pinnedTabs: remotePinned,
      tombstones: tombstones,
      meta: {
        lastWriteAt: now,
        version: 1
      }
    });

    console.log(LOG_PREFIX, 'Reconcile complete. Synced tabs:', desiredUrls.size);
  } catch (err) {
    console.error(LOG_PREFIX, 'Reconcile error:', err);
  } finally {
    isSyncing = false;
  }
}

// === Debounce ===

function scheduleReconcile(trigger) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    reconcile(trigger);
  }, DEBOUNCE_MS);
}

// === Event Handlers ===

function onInstalled(details) {
  console.log(LOG_PREFIX, 'Installed, reason:', details.reason);
  if (details.reason === 'install' || details.reason === 'update') {
    reconcile('install');
  }
}

function onStartup() {
  console.log(LOG_PREFIX, 'Browser startup');
  reconcile('startup');
}

function onStorageChanged(changes, areaName) {
  if (areaName !== 'sync') return;
  if (isSyncing) return;
  if (changes.pinnedTabs || changes.tombstones) {
    console.log(LOG_PREFIX, 'Sync storage changed externally');
    scheduleReconcile('sync-change');
  }
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.pinned !== undefined) {
    console.log(LOG_PREFIX, 'Tab pin state changed:', tab.url, 'pinned:', changeInfo.pinned);
    scheduleReconcile('pin-change');
  }
}

function onTabRemoved(tabId, removeInfo) {
  // Tab is gone — we can't check if it was pinned.
  // Reconcile will compare against localSnapshot to detect if a pinned tab was closed.
  scheduleReconcile('tab-removed');
}

function onAlarm(alarm) {
  if (alarm.name === ALARM_NAME) {
    reconcile('periodic');
  }
}

function onMessage(msg, sender, sendResponse) {
  if (msg.action === 'syncNow') {
    reconcile('manual').then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'getStatus') {
    Promise.all([
      chrome.storage.sync.get(['pinnedTabs', 'tombstones', 'meta']),
      chrome.storage.local.get(['localSnapshot'])
    ]).then(([syncData, localData]) => {
      sendResponse({ ...syncData, localSnapshot: localData.localSnapshot });
    });
    return true;
  }
  if (msg.action === 'reset') {
    Promise.all([
      chrome.storage.sync.clear(),
      chrome.storage.local.clear()
    ]).then(() => {
      console.log(LOG_PREFIX, 'Storage reset');
      sendResponse({ ok: true });
    });
    return true;
  }
}

// === Event Registration (MUST be top-level, synchronous) ===
chrome.runtime.onInstalled.addListener(onInstalled);
chrome.runtime.onStartup.addListener(onStartup);
chrome.storage.onChanged.addListener(onStorageChanged);
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.runtime.onMessage.addListener(onMessage);

// Create periodic alarm
chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
