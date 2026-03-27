const statusEl = document.getElementById('status');
const tabsSection = document.getElementById('tabs-section');
const tabCountEl = document.getElementById('tab-count');
const tabListEl = document.getElementById('tab-list');
const tombstonesSection = document.getElementById('tombstones-section');
const tombstoneCountEl = document.getElementById('tombstone-count');
const tombstoneListEl = document.getElementById('tombstone-list');
const syncBtn = document.getElementById('sync-btn');
const resetBtn = document.getElementById('reset-btn');

function formatUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.replace(/\/$/, '');
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

    // Status
    if (meta.lastWriteAt) {
      statusEl.textContent = `Last synced: ${timeAgo(meta.lastWriteAt)}`;
    } else {
      statusEl.textContent = 'Not yet synced';
    }

    // Pinned tabs list
    if (tabUrls.length > 0) {
      tabsSection.style.display = 'block';
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
    }

    // Tombstones list
    if (tombstoneUrls.length > 0) {
      tombstonesSection.style.display = 'block';
      tombstoneCountEl.textContent = tombstoneUrls.length;
      tombstoneListEl.innerHTML = '';
      for (const [url, ts] of tombstoneUrls) {
        const li = document.createElement('li');
        li.title = url;
        li.textContent = `${formatUrl(url)} (${timeAgo(ts.removedAt)})`;
        tombstoneListEl.appendChild(li);
      }
    } else {
      tombstonesSection.style.display = 'none';
    }
  } catch (err) {
    statusEl.textContent = 'Error loading status';
    console.error('Popup error:', err);
  }
}

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

resetBtn.addEventListener('click', async () => {
  if (!confirm('Clear all sync data? Pinned tabs will not be removed, but sync state will be reset.')) {
    return;
  }
  resetBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'reset' });
    await loadStatus();
  } finally {
    resetBtn.disabled = false;
  }
});

loadStatus();
