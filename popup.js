document.addEventListener('DOMContentLoaded', () => {
  const syncBtn = document.getElementById('syncBtn');
  const testBtn = document.getElementById('testBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const percentEl = document.getElementById('percent');
  const statusLabel = document.getElementById('statusLabel');
  const progressFill = document.getElementById('progressFill');

  let pollTimer = null;

  function setProgress(pct, label) {
    const p = Math.min(100, Math.max(0, pct));
    percentEl.textContent = Math.round(p);
    progressFill.style.width = p + '%';
    if (label) statusLabel.textContent = label;
  }

  function showSyncing() {
    syncBtn.classList.add('hidden');
    testBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    downloadBtn.classList.add('hidden');
  }

  function showIdle(hasData) {
    syncBtn.classList.remove('hidden');
    testBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    if (hasData) downloadBtn.classList.remove('hidden');
    else downloadBtn.classList.add('hidden');
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      chrome.storage.local.get(['syncState'], (result) => {
        const s = result.syncState;
        if (!s) return;
        setProgress(s.pct || 0, s.label || '');
        if (s.running) {
          showSyncing();
        } else {
          stopPolling();
          chrome.storage.local.get(['lastSync', 'testLastResult'], (r) => {
            const hasData = !!r.testLastResult?.data || !!r.lastSync?.data;
            showIdle(hasData);
          });
        }
      });
    }, 500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  chrome.storage.local.get(['syncState', 'lastSync', 'testLastResult'], (result) => {
    const s = result.syncState;
    const hasData = !!result.testLastResult?.data || !!result.lastSync?.data;

    if (s?.running) {
      setProgress(s.pct || 0, s.label || 'Syncing...');
      showSyncing();
      startPolling();
    } else if (s?.pct === 100 && hasData) {
      setProgress(100, s.label || 'Complete');
      showIdle(true);
    } else if (hasData) {
      const d = result.testLastResult?.data || result.lastSync?.data;
      if (d && Array.isArray(d.unread_with_context)) {
        const total = d.total_in_inbox || d.all_conversations?.length || 0;
        const unread = d.unread_with_context?.length || 0;
        const missed = d.missed_unread_count || 0;
        const label = missed > 0
          ? `Complete · ${unread} unread / ${total} total · missed ${missed}`
          : `Complete · ${unread} unread / ${total} total`;
        setProgress(100, label);
      } else if (d && Array.isArray(d.conversations)) {
        setProgress(100, `Test complete · ${d.conversations.length} threads`);
      } else {
        setProgress(100, 'Complete');
      }
      showIdle(true);
    } else {
      showIdle(false);
    }
  });

  syncBtn.addEventListener('click', () => {
    setProgress(0, 'Starting...');
    showSyncing();
    startPolling();

    chrome.runtime.sendMessage({ action: 'EXTRACT_RAW' }, (response) => {
      stopPolling();
      if (chrome.runtime.lastError || !response?.success) {
        const stopped = response?.error === 'CANCELLED';
        setProgress(0, stopped ? 'Stopped' : 'Error');
        showIdle(false);
        chrome.storage.local.get(['lastSync'], (r) => {
          if (r.lastSync?.data) showIdle(true);
        });
        return;
      }
      const d = response.data;
      const total = d.total_in_inbox || d.all_conversations?.length || 0;
      const unread = d.unread_with_context?.length || 0;
      const missed = d.missed_unread_count || 0;
      const label = missed > 0
        ? `Complete · ${unread} unread / ${total} total · missed ${missed}`
        : `Complete · ${unread} unread / ${total} total`;
      setProgress(100, label);
      chrome.storage.local.set({ lastSync: { timestamp: Date.now(), data: d } });
      showIdle(true);
    });
  });

  testBtn.addEventListener('click', () => {
    setProgress(0, 'Testing...');
    showSyncing();
    startPolling();

    chrome.runtime.sendMessage({ action: 'TEST_EXTRACT_CONTEXT_10' }, (response) => {
      stopPolling();
      if (chrome.runtime.lastError || !response?.success) {
        const stopped = response?.error === 'CANCELLED';
        setProgress(0, stopped ? 'Stopped' : 'Error');
        showIdle(false);
        return;
      }

      const data = response.data;
      const convCount = Array.isArray(data?.conversations) ? data.conversations.length : 0;
      setProgress(100, `Test complete · ${convCount} threads`);
      chrome.storage.local.set({ testLastResult: { timestamp: Date.now(), data } });
      showIdle(true);
    });
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_SYNC' });
    stopPolling();
    setProgress(0, 'Stopping...');
    showIdle(false);
    chrome.storage.local.get(['lastSync', 'testLastResult'], (r) => {
      if (r.lastSync?.data || r.testLastResult?.data) showIdle(true);
    });
  });

  downloadBtn.addEventListener('click', () => {
    chrome.storage.local.get(['testLastResult', 'lastSync'], (result) => {
      const payload = result.testLastResult?.data || result.lastSync?.data;
      if (!payload) return;
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = result.testLastResult?.data ? `linkedin_test_latest10_${date}.json` : `linkedin_raw_${date}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });
});
