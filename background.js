/**
 * Background - Raw extraction + progress relay + stop support + optional AI format
 * Persists sync state in chrome.storage.local so the popup survives being closed.
 */

/** Temporary: Sync Now skips lastSync when true (batch files only). Keep in sync with content.js. */
const SYNC_TEMP_BATCH_DOWNLOAD_NO_PERSIST = true;

let activeSyncTabId = null;

function setSyncState(obj) {
  chrome.storage.local.set({ syncState: obj });
}

async function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function getStoredOpenAIKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['openaiApiKey'], (result) => {
      const key = (result?.openaiApiKey || '').trim();
      resolve(key);
    });
  });
}

async function formatWithAITextOnly(rawJson, options) {
  const apiKey = await getStoredOpenAIKey();
  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Save it in chrome.storage.local as "openaiApiKey".');
  }

  const raw = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const conversations = raw.all_conversations || [];
  const unread = (raw.unread_with_context || []).reduce((acc, c) => { acc[c.participant_name] = c; return acc; }, {});

  const items = conversations.map(c => ({
    participant_name: c.participant_name,
    message_preview: (c.message_preview || '').trim(),
    latest_message: (unread[c.participant_name]?.latest_message || c.message_preview || '').trim(),
    timestamp: c.timestamp || '',
    is_unread: c.is_unread
  }));

  const prompt = `You are filtering LinkedIn messages. Return ONLY conversations that are:
1. INCOMING to the user (message FROM the other person). EXCLUDE any where the latest message starts with "You:" or "You sent" (the user sent it).
2. NOT promotional or spam: no sales pitches, generic "connect with me", survey/form links, "insert meaningful message", pure marketing.
3. Worth following up: cold DMs, genuine requests, feedback asks, collaboration, or meaningful replies from others.

Conversations to filter (JSON array):
${JSON.stringify(items, null, 2)}

Return a JSON array only. Each object must have: participant_name, latest_message, timestamp, is_unread (boolean from the data), read_status ("unread" or "read" from is_unread), reason (one short line why kept). No markdown, no extra text, just the array.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096
    })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Format failed');
  }
  const data = await response.json();
  let text = data.choices[0].message.content;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']') + 1;
  if (start !== -1 && end > start) {
    let filtered = JSON.parse(text.slice(start, end));
    const unreadOnly = options && options.unreadOnly !== false;
    if (unreadOnly) {
      filtered = filtered.filter(m => m.is_unread === true);
    }
    filtered.forEach(m => { if (!m.read_status) m.read_status = m.is_unread ? 'unread' : 'read'; });
    const label = unreadOnly ? 'unread' : 'incoming';
    return { filtered, summary: `Filtered to ${filtered.length} ${label} messages (excluded You: and spam).` };
  }
  return { filtered: [], summary: text };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'SYNC_PROGRESS') {
    setSyncState({ running: true, pct: request.pct, label: request.label });
    return false;
  }

  if (request.action === 'SYNC_BATCH_FILE') {
    (async () => {
      try {
        const payload = request.payload;
        if (!payload || typeof payload !== 'object') {
          sendResponse({ success: false, error: 'Missing payload' });
          return;
        }
        const json = JSON.stringify(payload, null, 2);
        const base64 = btoa(unescape(encodeURIComponent(json)));
        const dataUrl = 'data:application/json;base64,' + base64;
        const date = new Date().toISOString().slice(0, 10);
        const batchIdx = payload.batchIndex != null ? String(payload.batchIndex) : 'batch';
        await chrome.downloads.download({
          url: dataUrl,
          filename: `linkedin_sync_batch_${batchIdx}_${date}.json`,
          saveAs: false,
        });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'COUNT_UNREAD_ONLY') {
    setSyncState({ running: true, pct: 0, label: 'Counting unreads...' });
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.includes('linkedin.com/messaging')) {
          setSyncState({ running: false, pct: 0, label: 'Open LinkedIn Messaging first' });
          sendResponse({ success: false, error: 'Open LinkedIn Messaging first' });
          return;
        }
        activeSyncTabId = tab.id;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch (e) {}
        await new Promise(r => setTimeout(r, 400));

        const response = await sendToContentScript(tab.id, { action: 'COUNT_UNREAD_ONLY' });
        activeSyncTabId = null;

        if (!response?.success) {
          const stopped = response?.error === 'CANCELLED';
          setSyncState({ running: false, pct: 0, label: stopped ? 'Stopped' : 'Error' });
          sendResponse({ success: false, error: response?.error || 'Count failed' });
          return;
        }

        const d = response.data;
        const n = d.initial_unread_count ?? 0;
        const est = d.estimated_batches ?? 1;
        const label = `Count · ${n} unreads (~${est} batches)`;
        setSyncState({ running: false, pct: 100, label });
        chrome.storage.local.set({ lastUnreadCount: { timestamp: Date.now(), data: d } });
        sendResponse({ success: true, data: d });
      } catch (err) {
        activeSyncTabId = null;
        setSyncState({ running: false, pct: 0, label: 'Error' });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'EXTRACT_RAW') {
    setSyncState({ running: true, pct: 0, label: 'Starting...' });
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.includes('linkedin.com/messaging')) {
          setSyncState({ running: false, pct: 0, label: 'Open LinkedIn Messaging first' });
          sendResponse({ success: false, error: 'Open LinkedIn Messaging first' });
          return;
        }
        activeSyncTabId = tab.id;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch (e) {}
        await new Promise(r => setTimeout(r, 400));

        const response = await sendToContentScript(tab.id, { action: 'EXTRACT_RAW' });
        activeSyncTabId = null;

        if (!response?.success) {
          const stopped = response?.error === 'CANCELLED';
          setSyncState({ running: false, pct: 0, label: stopped ? 'Stopped' : 'Error' });
          sendResponse({ success: false, error: response?.error || 'Extraction failed' });
          return;
        }

        const d = response.data;
        const total = d.total_in_inbox || d.all_conversations?.length || 0;
        const unread = d.unread_with_context?.length || 0;
        const missed = d.missed_unread_count || 0;
        const label = missed > 0
          ? `Complete · ${unread} unread / ${total} total · missed ${missed}`
          : `Complete · ${unread} unread / ${total} total`;
        setSyncState({ running: false, pct: 100, label });
        if (!SYNC_TEMP_BATCH_DOWNLOAD_NO_PERSIST) {
          chrome.storage.local.set({ lastSync: { timestamp: Date.now(), data: d } });
        }
        sendResponse({ success: true, data: d });
      } catch (err) {
        activeSyncTabId = null;
        setSyncState({ running: false, pct: 0, label: 'Error' });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'TEST_EXTRACT_CONTEXT_10') {
    setSyncState({ running: true, pct: 0, label: 'Testing...' });
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.includes('linkedin.com/messaging')) {
          setSyncState({ running: false, pct: 0, label: 'Open LinkedIn Messaging first' });
          sendResponse({ success: false, error: 'Open LinkedIn Messaging first' });
          return;
        }

        activeSyncTabId = tab.id;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch (e) {}

        await new Promise(r => setTimeout(r, 400));

        const response = await sendToContentScript(tab.id, { action: 'TEST_EXTRACT_CONTEXT_10' });
        activeSyncTabId = null;

        if (!response?.success) {
          const stopped = response?.error === 'CANCELLED';
          setSyncState({ running: false, pct: 0, label: stopped ? 'Stopped' : 'Error' });
          sendResponse({ success: false, error: response?.error || 'Test extraction failed' });
          return;
        }

        const d = response.data;
        const count = Array.isArray(d?.conversations) ? d.conversations.length : 0;
        setSyncState({ running: false, pct: 100, label: `Test complete · ${count} threads` });
        chrome.storage.local.set({ testLastResult: { timestamp: Date.now(), data: d } });
        sendResponse({ success: true, data: d });
      } catch (err) {
        activeSyncTabId = null;
        setSyncState({ running: false, pct: 0, label: 'Error' });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'STOP_SYNC') {
    (async () => {
      try {
        if (activeSyncTabId) {
          await sendToContentScript(activeSyncTabId, { action: 'STOP_SYNC' });
        }
      } catch (e) {}
      activeSyncTabId = null;
      setSyncState({ running: false, pct: 0, label: 'Stopped' });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'FORMAT_WITH_AI') {
    (async () => {
      try {
        const result = await formatWithAITextOnly(request.rawData, { unreadOnly: request.unreadOnly !== false });
        sendResponse({ success: true, filteredList: result.filtered, summary: result.summary });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});

console.log('Background worker loaded');
