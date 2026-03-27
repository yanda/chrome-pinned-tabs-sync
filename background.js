// === Constants ===
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 2000;
const ALARM_NAME = 'reconcile';
const ALARM_PERIOD_MINUTES = 5;
const LOG_PREFIX = '[PinnedTabsSync]';

// === State (in-memory, resets on worker restart) ===
let isSyncing = false;
let debounceTimer = null;
let pendingReconcileTrigger = null; // Queued trigger when reconcile is skipped due to isSyncing
let knownPinnedTabIds = new Set(); // Track pinned tab IDs to filter onTabRemoved noise

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

// === Tab Operation Helper (retries on "cannot be edited" errors) ===

async function safeTabOp(operation, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const msg = err.message || '';
      // Non-retryable: tab no longer exists
      if (msg.includes('No tab with id') || msg.includes('No current window')) {
        console.warn(LOG_PREFIX, 'Tab/window gone, skipping:', msg);
        return null;
      }
      // Retryable: tab is temporarily locked
      if (msg.includes('cannot be edited') && attempt < maxRetries) {
        console.log(LOG_PREFIX, `Tab busy, retrying in ${(attempt + 1)}s...`);
        await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      throw err;
    }
  }
}

// === Data Validation ===

function isValidPinnedTabs(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  for (const [url, entry] of Object.entries(obj)) {
    if (typeof url !== 'string') return false;
    if (typeof entry !== 'object' || entry === null) return false;
    if (typeof entry.addedAt !== 'number') return false;
    if (entry.order !== undefined && typeof entry.order !== 'number') return false;
  }
  return true;
}

function isValidTombstones(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  for (const [url, entry] of Object.entries(obj)) {
    if (typeof url !== 'string') return false;
    if (typeof entry !== 'object' || entry === null) return false;
    if (typeof entry.removedAt !== 'number') return false;
  }
  return true;
}

// === Storage Quota Protection ===

const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const SYNC_QUOTA_MAX_ITEMS = 512;

function estimateJsonSize(obj) {
  return new Blob([JSON.stringify(obj)]).size;
}

function enforceSyncQuota(remotePinned, tombstones) {
  // Trim oldest tombstones first if we exceed item count
  const totalItems = Object.keys(remotePinned).length + Object.keys(tombstones).length;
  if (totalItems > SYNC_QUOTA_MAX_ITEMS - 10) { // leave headroom
    const sorted = Object.entries(tombstones).sort((a, b) => a[1].removedAt - b[1].removedAt);
    while (Object.keys(tombstones).length > 50 && sorted.length > 0) {
      const [url] = sorted.shift();
      delete tombstones[url];
    }
  }

  // Check per-item size limits and warn
  for (const key of ['pinnedTabs', 'tombstones']) {
    const obj = key === 'pinnedTabs' ? remotePinned : tombstones;
    const size = estimateJsonSize(obj);
    if (size > SYNC_QUOTA_BYTES_PER_ITEM - 512) {
      console.warn(LOG_PREFIX, `${key} approaching sync quota: ${size}/${SYNC_QUOTA_BYTES_PER_ITEM} bytes`);
    }
  }
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
    console.log(LOG_PREFIX, 'Queuing reconcile (already syncing), trigger:', trigger);
    pendingReconcileTrigger = trigger;
    return;
  }
  isSyncing = true;
  console.log(LOG_PREFIX, 'Reconcile started, trigger:', trigger);

  try {
    // 1. Read remote state
    const syncData = await chrome.storage.sync.get(['pinnedTabs', 'tombstones', 'meta']);
    let remotePinned = syncData.pinnedTabs || {};
    let tombstones = syncData.tombstones || {};

    // Validate remote data — reset if corrupted
    if (!isValidPinnedTabs(remotePinned)) {
      console.warn(LOG_PREFIX, 'Invalid pinnedTabs data, resetting');
      remotePinned = {};
    }
    if (!isValidTombstones(tombstones)) {
      console.warn(LOG_PREFIX, 'Invalid tombstones data, resetting');
      tombstones = {};
    }
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

    // Group tabs by normalized URL to detect duplicates
    const tabsByUrl = new Map();
    for (const tab of localPinned) {
      const url = normalizeUrl(tab.url);
      if (!tabsByUrl.has(url)) {
        tabsByUrl.set(url, []);
      }
      tabsByUrl.get(url).push(tab);
    }

    // Close duplicate pinned tabs (keep the first, close the rest)
    for (const [url, tabs] of tabsByUrl) {
      for (let i = 1; i < tabs.length; i++) {
        console.log(LOG_PREFIX, 'Closing duplicate pinned tab:', url);
        try {
          await safeTabOp(() => chrome.tabs.remove(tabs[i].id));
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to close duplicate:', url, err);
        }
      }
    }

    // Build deduplicated map of URL -> tab (first occurrence)
    const currentLocalUrls = new Map();
    for (const [url, tabs] of tabsByUrl) {
      currentLocalUrls.set(url, tabs[0]);
    }

    // 3. Read previous snapshot (stores {url, tabId} pairs to detect URL changes vs unpins)
    const localData = await chrome.storage.local.get(['localSnapshot']);
    const rawSnapshot = Array.isArray(localData.localSnapshot) ? localData.localSnapshot : [];
    // Build lookup maps from snapshot
    const snapshotUrlToTabId = new Map();  // url -> tabId
    const snapshotTabIdToUrl = new Map();  // tabId -> url
    for (const entry of rawSnapshot) {
      if (typeof entry === 'string') {
        // Legacy format (plain URL array) — no tabId tracking
        snapshotUrlToTabId.set(entry, null);
      } else if (entry && typeof entry === 'object' && typeof entry.url === 'string') {
        snapshotUrlToTabId.set(entry.url, entry.tabId);
        if (entry.tabId != null) {
          snapshotTabIdToUrl.set(entry.tabId, entry.url);
        }
      }
      // Skip malformed entries silently
    }

    // Build current tabId -> url map
    const currentTabIdToUrl = new Map();
    for (const [url, tab] of currentLocalUrls) {
      currentTabIdToUrl.set(tab.id, url);
    }

    // Compute maxOrder early — needed for fallback ordering in step 4 and step 5
    let maxOrder = 0;
    for (const entry of Object.values(remotePinned)) {
      if ((entry.order || 0) > maxOrder) maxOrder = entry.order || 0;
    }

    // 4. Detect local unpins vs URL changes within the same tab
    //    Build a set of current origins for fallback matching (handles Chrome restart / legacy snapshot)
    const currentOrigins = new Map(); // origin -> url (first match)
    for (const [url] of currentLocalUrls) {
      try {
        const origin = new URL(url).origin;
        if (!currentOrigins.has(origin)) currentOrigins.set(origin, url);
      } catch {}
    }
    // Track which current URLs have been matched to a snapshot URL via origin fallback
    const originMatchedUrls = new Set();

    for (const [snapshotUrl, snapshotTabId] of snapshotUrlToTabId) {
      if (currentLocalUrls.has(snapshotUrl)) continue; // URL still present, no change

      // URL is gone — first try matching by tab ID
      let newUrl = snapshotTabId != null ? currentTabIdToUrl.get(snapshotTabId) : null;

      // Fallback: match by origin (handles Chrome restart where tab IDs change,
      // and legacy snapshots with no tab IDs). Only use each current URL once.
      if (!newUrl) {
        try {
          const snapshotOrigin = new URL(snapshotUrl).origin;
          const candidate = currentOrigins.get(snapshotOrigin);
          if (candidate && !originMatchedUrls.has(candidate) && !currentLocalUrls.has(snapshotUrl)) {
            newUrl = candidate;
            originMatchedUrls.add(candidate);
          }
        } catch {}
      }

      if (newUrl && newUrl !== snapshotUrl) {
        // Same tab (or same origin), URL changed (e.g., redirect after load).
        // Update remote entry, preserve order.
        console.log(LOG_PREFIX, 'URL changed in same tab:', snapshotUrl, '->', newUrl);
        if (remotePinned[snapshotUrl]) {
          const oldEntry = remotePinned[snapshotUrl];
          remotePinned[newUrl] = { addedAt: oldEntry.addedAt, order: oldEntry.order };
          delete remotePinned[snapshotUrl];
        } else {
          // Old URL not in remote (e.g., removed by another device mid-sync).
          // Preserve the tab's current local index as its order so it doesn't jump to the end.
          const tab = currentLocalUrls.get(newUrl);
          remotePinned[newUrl] = { addedAt: now, order: tab ? tab.index : maxOrder + 1 };
        }
        // Clean up any tombstone for the new URL
        delete tombstones[newUrl];
      } else if (!newUrl) {
        // Tab is gone — this is a real unpin/close
        console.log(LOG_PREFIX, 'Detected local unpin:', snapshotUrl);
        tombstones[snapshotUrl] = { removedAt: now };
        delete remotePinned[snapshotUrl];
      }
    }

    // 5. Detect new local pins (pinned locally, not in remote)
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

    // 9. Create missing pinned tabs locally (skip if already pinned)
    const urlsToCreate = [...desiredUrls].filter(url => !currentLocalUrls.has(url));
    if (urlsToCreate.length > 0) {
      // Re-query to catch any tabs we might have missed (e.g., non-syncable URLs that normalized the same)
      const existingPinned = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
      const existingUrls = new Set(existingPinned.map(t => normalizeUrl(t.url)));

      for (const url of urlsToCreate) {
        if (existingUrls.has(url)) {
          console.log(LOG_PREFIX, 'Tab already pinned, skipping:', url);
          continue;
        }
        console.log(LOG_PREFIX, 'Creating pinned tab:', url);
        try {
          await safeTabOp(() => chrome.tabs.create({
            url: url,
            pinned: true,
            active: false,
            windowId: mainWindowId
          }));
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
          await safeTabOp(() => chrome.tabs.update(tab.id, { pinned: false }));
        } catch (err) {
          console.error(LOG_PREFIX, 'Failed to unpin tab:', url, err);
        }
      }
    }

    // 11. Reorder: either push local order to remote, or pull remote order to local.
    //     On local triggers (tab-moved, pin-change), adopt local tab positions as the
    //     source of truth for order. On remote triggers (sync-change, startup, periodic,
    //     install), reorder local tabs to match remote order.
    const localOrderTriggers = new Set(['tab-moved', 'pin-change', 'pinned-url-change']);
    if (localOrderTriggers.has(trigger)) {
      // Push local positions into remote order values
      const currentPinnedTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
      for (const tab of currentPinnedTabs) {
        const url = normalizeUrl(tab.url);
        if (remotePinned[url]) {
          remotePinned[url].order = tab.index;
        }
      }
    } else {
      // Pull remote order to local: move tabs to match desired order
      const orderedUrls = [...desiredUrls].sort(
        (a, b) => (remotePinned[a].order || 0) - (remotePinned[b].order || 0)
      );

      let reorderTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
      let needsRequery = false;
      for (let i = 0; i < orderedUrls.length; i++) {
        const url = orderedUrls[i];
        if (needsRequery) {
          reorderTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
          needsRequery = false;
        }
        const tab = reorderTabs.find(t => normalizeUrl(t.url) === url);
        if (tab && tab.index !== i) {
          try {
            await safeTabOp(() => chrome.tabs.move(tab.id, { index: i }));
            needsRequery = true;
          } catch (err) {
            console.error(LOG_PREFIX, 'Failed to reorder tab:', url, err);
          }
        }
      }
    }

    // 12. Update local snapshot (store {url, tabId} pairs for URL-change detection)
    const freshTabs = await chrome.tabs.query({ pinned: true, windowId: mainWindowId });
    const freshTabsByUrl = new Map();
    for (const tab of freshTabs) {
      freshTabsByUrl.set(normalizeUrl(tab.url), tab.id);
    }
    const finalSnapshot = [...desiredUrls].map(url => ({
      url,
      tabId: freshTabsByUrl.get(url) || null
    }));
    await chrome.storage.local.set({ localSnapshot: finalSnapshot });

    // 13. Update in-memory set of known pinned tab IDs
    knownPinnedTabIds = new Set(freshTabs.filter(t => t.pinned).map(t => t.id));

    // 14. Enforce sync storage quota before writing
    enforceSyncQuota(remotePinned, tombstones);

    // 15. Write back to sync
    try {
      await chrome.storage.sync.set({
        pinnedTabs: remotePinned,
        tombstones: tombstones,
        meta: {
          lastWriteAt: now,
          version: 1
        }
      });
    } catch (err) {
      if (err.message && err.message.includes('QUOTA')) {
        console.error(LOG_PREFIX, 'Sync storage quota exceeded, trimming tombstones');
        // Emergency: clear all tombstones and retry
        await chrome.storage.sync.set({
          pinnedTabs: remotePinned,
          tombstones: {},
          meta: { lastWriteAt: now, version: 1 }
        });
      } else {
        throw err;
      }
    }

    console.log(LOG_PREFIX, 'Reconcile complete. Synced tabs:', desiredUrls.size);
  } catch (err) {
    console.error(LOG_PREFIX, 'Reconcile error:', err);
  } finally {
    isSyncing = false;
    // Process any reconcile that was queued while we were syncing
    if (pendingReconcileTrigger) {
      const queuedTrigger = pendingReconcileTrigger;
      pendingReconcileTrigger = null;
      scheduleReconcile(queuedTrigger);
    }
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
    // Delay after install/reload — Chrome isn't ready for tab operations immediately
    setTimeout(() => reconcile('install'), 3000);
  }
}

function onStartup() {
  console.log(LOG_PREFIX, 'Browser startup');
  reconcile('startup');
}

function onStorageChanged(changes, areaName) {
  if (areaName !== 'sync') return;
  if (changes.pinnedTabs || changes.tombstones) {
    if (isSyncing) {
      // Queue so the change is picked up after current reconcile finishes
      console.log(LOG_PREFIX, 'Sync storage changed while syncing, queuing');
      pendingReconcileTrigger = 'sync-change';
      return;
    }
    console.log(LOG_PREFIX, 'Sync storage changed externally');
    scheduleReconcile('sync-change');
  }
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.pinned !== undefined) {
    // Update known set immediately
    if (changeInfo.pinned) {
      knownPinnedTabIds.add(tabId);
    } else {
      knownPinnedTabIds.delete(tabId);
    }
    console.log(LOG_PREFIX, 'Tab pin state changed:', tab.url, 'pinned:', changeInfo.pinned);
    scheduleReconcile('pin-change');
  } else if (changeInfo.url && tab.pinned) {
    // A pinned tab navigated to a new URL — sync the change
    console.log(LOG_PREFIX, 'Pinned tab URL changed:', changeInfo.url);
    scheduleReconcile('pinned-url-change');
  }
}

function onTabRemoved(tabId, removeInfo) {
  // Skip during window close — all tabs fire onRemoved, reconcile would error
  if (removeInfo.isWindowClosing) return;
  // Only reconcile if this tab was (or might have been) pinned
  // This avoids unnecessary reconciles when regular tabs are closed
  if (knownPinnedTabIds.size === 0 || knownPinnedTabIds.has(tabId)) {
    knownPinnedTabIds.delete(tabId);
    scheduleReconcile('tab-removed');
  }
}

function onTabMoved(tabId, moveInfo) {
  // Sync reorder when user manually moves a pinned tab.
  // We update remote order values from current local positions
  // rather than re-imposing the old remote order.
  if (knownPinnedTabIds.has(tabId)) {
    scheduleReconcile('tab-moved');
  }
}

function onAlarm(alarm) {
  if (alarm.name === ALARM_NAME) {
    reconcile('periodic');
  }
}

function onMessage(msg, sender, sendResponse) {
  if (msg.action === 'syncNow') {
    reconcile('manual')
      .then(() => sendResponse({ ok: true }))
      .catch(err => {
        console.error(LOG_PREFIX, 'Manual sync failed:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }
  if (msg.action === 'getStatus') {
    Promise.all([
      chrome.storage.sync.get(['pinnedTabs', 'tombstones', 'meta']),
      chrome.storage.local.get(['localSnapshot'])
    ]).then(([syncData, localData]) => {
      sendResponse({ ...syncData, localSnapshot: localData.localSnapshot });
    }).catch(err => {
      console.error(LOG_PREFIX, 'getStatus failed:', err);
      sendResponse({ pinnedTabs: {}, tombstones: {}, meta: {} });
    });
    return true;
  }
  if (msg.action === 'reset') {
    Promise.all([
      chrome.storage.sync.clear(),
      chrome.storage.local.clear()
    ]).then(() => {
      knownPinnedTabIds.clear();
      console.log(LOG_PREFIX, 'Storage reset');
      sendResponse({ ok: true });
    }).catch(err => {
      console.error(LOG_PREFIX, 'Reset failed:', err);
      sendResponse({ ok: false, error: err.message });
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
chrome.tabs.onMoved.addListener(onTabMoved);
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.runtime.onMessage.addListener(onMessage);

// Create periodic alarm
chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
