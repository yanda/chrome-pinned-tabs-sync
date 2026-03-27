const $ = (id) => document.getElementById(id);

const statusDot = $('status-dot');
const statusText = $('status-text');
const welcome = $('welcome');
const mainContent = $('main-content');
const tabsSection = $('tabs-section');
const tabCountEl = $('tab-count');
const tabListEl = $('tab-list');
const emptyState = $('empty-state');
const tombstonesSection = $('tombstones-section');
const tombstoneCountEl = $('tombstone-count');
const tombstoneListEl = $('tombstone-list');
const syncBtn = $('sync-btn');
const resetBtn = $('reset-btn');
const resetConfirm = $('reset-confirm');
const resetYes = $('reset-yes');
const resetNo = $('reset-no');
const welcomeDismiss = $('welcome-dismiss');

function formatUrl(url) {
  try {
    const u = new URL(url);
    let display = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/$/, '');
    if (path && path !== '') {
      display += path;
    }
    return display;
  } catch {
    return url;
  }
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function loadStatus() {
  try {
    const data = await chrome.runtime.sendMessage({ action: 'getStatus' });
    const pinnedTabs = data.pinnedTabs || {};
    const tombstones = data.tombstones || {};
    const meta = data.meta || {};

    const tabUrls = Object.entries(pinnedTabs)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    const tombstoneUrls = Object.entries(tombstones)
      .sort((a, b) => b[1].removedAt - a[1].removedAt);

    // Show welcome if first time (no meta and no tabs)
    const isFirstRun = !meta.lastWriteAt && tabUrls.length === 0;
    const dismissed = (await chrome.storage.local.get(['welcomeDismissed'])).welcomeDismissed;

    if (isFirstRun && !dismissed) {
      welcome.style.display = 'block';
      mainContent.style.display = 'none';
      return;
    }

    welcome.style.display = 'none';
    mainContent.style.display = 'block';

    // Status
    if (meta.lastWriteAt) {
      const ago = timeAgo(meta.lastWriteAt);
      statusText.textContent = `Synced ${ago}`;
      const staleMinutes = (Date.now() - meta.lastWriteAt) / 60000;
      statusDot.className = staleMinutes > 10 ? 'dot stale' : 'dot';
    } else {
      statusText.textContent = 'Waiting for first sync...';
      statusDot.className = 'dot stale';
    }

    // Pinned tabs list
    if (tabUrls.length > 0) {
      tabsSection.style.display = 'block';
      emptyState.style.display = 'none';
      tabCountEl.textContent = tabUrls.length;
      tabListEl.innerHTML = '';
      for (const [url] of tabUrls) {
        const li = document.createElement('li');
        li.title = url;
        li.textContent = formatUrl(url);
        tabListEl.appendChild(li);
      }
    } else {
      tabsSection.style.display = 'none';
      emptyState.style.display = 'block';
    }

    // Tombstones list
    if (tombstoneUrls.length > 0) {
      tombstonesSection.style.display = 'block';
      tombstoneCountEl.textContent = tombstoneUrls.length;
      tombstoneListEl.innerHTML = '';
      for (const [url, ts] of tombstoneUrls) {
        const li = document.createElement('li');
        li.title = url;
        li.textContent = `${formatUrl(url)} — ${timeAgo(ts.removedAt)}`;
        tombstoneListEl.appendChild(li);
      }
    } else {
      tombstonesSection.style.display = 'none';
    }
  } catch (err) {
    statusText.textContent = 'Error loading status';
    statusDot.className = 'dot error';
    console.error('Popup error:', err);
  }
}

// Welcome dismiss
welcomeDismiss.addEventListener('click', async () => {
  await chrome.storage.local.set({ welcomeDismissed: true });
  welcome.style.display = 'none';
  mainContent.style.display = 'block';
  // Trigger first sync
  await chrome.runtime.sendMessage({ action: 'syncNow' });
  await loadStatus();
});

// Sync Now
syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing...';
  try {
    await chrome.runtime.sendMessage({ action: 'syncNow' });
    await loadStatus();
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  }
});

// Reset — inline confirmation instead of confirm()
resetBtn.addEventListener('click', () => {
  resetBtn.style.display = 'none';
  resetConfirm.style.display = 'block';
});

resetNo.addEventListener('click', () => {
  resetConfirm.style.display = 'none';
  resetBtn.style.display = '';
});

resetYes.addEventListener('click', async () => {
  resetYes.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'reset' });
    resetConfirm.style.display = 'none';
    resetBtn.style.display = '';
    await loadStatus();
  } finally {
    resetYes.disabled = false;
  }
});

loadStatus();
