/**
 * Background - Raw extraction + progress relay + stop support + optional AI format
 * Persists sync state in chrome.storage.local so the popup survives being closed.
 */

/** Set false to silence service-worker step logs (chrome://extensions → Service worker → Console). */
const BG_DEBUG = true;

let activeSyncTabId = null;
/** Throttle noisy SYNC_PROGRESS lines in the SW console */
let lastLoggedProgressPct = -999;

function bgLog(step, ...args) {
  if (!BG_DEBUG) return;
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[LinkedIn Sync BG ${t}] ${step}`, ...args);
}

function shortUrl(u, max = 80) {
  if (!u || typeof u !== 'string') return '(none)';
  return u.length <= max ? u : `${u.slice(0, max)}…`;
}

/** For SW diagnostics only (matches content.js parseThreadId logic). */
function parseThreadIdFromUrl(url) {
  if (!url) return '';
  try {
    const clean = url.split('#')[0].split('?')[0].trim().replace(/\/+$/, '');
    const m = clean.match(/\/messaging\/thread\/([^/?#]+)/);
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}

function setSyncState(obj) {
  chrome.storage.local.set({ syncState: obj });
}

async function sendToContentScript(tabId, message) {
  bgLog('sendToContentScript →', message.action || '(no action)', 'tabId=', tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        bgLog('sendToContentScript ✗', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        bgLog('sendToContentScript ←', message.action, 'response=', response?.success, response?.error || '');
        resolve(response);
      }
    });
  });
}

async function pingContentScript(tabId) {
  try {
    const res = await sendToContentScript(tabId, { action: 'PING' });
    return res?.success === true;
  } catch (e) {
    bgLog('pingContentScript failed', e.message);
    return false;
  }
}

async function ensureContentScript(tabId) {
  bgLog('ensureContentScript: start', 'tabId=', tabId);
  try {
    if (await pingContentScript(tabId)) {
      bgLog('ensureContentScript: PING ok, already injected');
      return;
    }
  } catch (e) {
    bgLog('ensureContentScript: initial PING threw', e.message);
  }

  bgLog('ensureContentScript: injecting content.js…');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await new Promise(r => setTimeout(r, 200));

  if (!(await pingContentScript(tabId))) {
    bgLog('ensureContentScript: FAIL — no PING after inject');
    throw new Error('Content script did not respond after injection');
  }
  bgLog('ensureContentScript: OK after inject');
}

/** Poll tab URL until thread id appears (for optional NAVIGATE_TO_THREAD; not used mid-extractRaw). */
async function waitForTabUrlContains(tabId, fragment, timeoutMs = 25000) {
  bgLog('waitForTabUrlContains: start', 'tabId=', tabId, 'fragment=', shortUrl(fragment, 40), 'timeoutMs=', timeoutMs);
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const u = tab.url || '';
      polls++;
      if (polls === 1 || polls % 25 === 0) {
        bgLog('waitForTabUrlContains: poll', polls, 'url=', shortUrl(u, 100));
      }
      if (fragment && u.includes(fragment) && u.includes('/messaging/thread/')) {
        bgLog('waitForTabUrlContains: OK', 'after', polls, 'polls', Date.now() - start, 'ms');
        return true;
      }
    } catch (e) {
      bgLog('waitForTabUrlContains: tabs.get error', e.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  bgLog('waitForTabUrlContains: TIMEOUT', 'polls=', polls, 'elapsed=', Date.now() - start, 'ms');
  return false;
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
1. INCOMING to the user (message FROM the other person). participant_name is always the other party. If direction is ambiguous, infer from message text (sign-offs, "Hey [name]", first-person voice), not from metadata alone. EXCLUDE when the latest message clearly starts with "You:" or "You sent" (the user sent it).
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
  const action = request.action || '(missing action)';
  bgLog('onMessage', action, {
    fromTab: sender.tab?.id,
    url: shortUrl(sender.tab?.url, 70),
  });

  if (request.action === 'NAVIGATE_TO_THREAD') {
    const tabId = sender.tab?.id;
    if (!tabId || !request.url || !request.expectedThreadId) {
      bgLog('NAVIGATE_TO_THREAD ✗ bad args', { tabId, hasUrl: !!request.url, hasExpected: !!request.expectedThreadId });
      sendResponse({ success: false, error: 'NAVIGATE_TO_THREAD: missing tab, url, or expectedThreadId' });
      return false;
    }
    bgLog('NAVIGATE_TO_THREAD: begin', 'tabId=', tabId, 'url=', shortUrl(request.url, 90), 'expectedId=', shortUrl(request.expectedThreadId, 36));
    (async () => {
      try {
        bgLog('NAVIGATE_TO_THREAD: tabs.update');
        await chrome.tabs.update(tabId, { url: request.url });
        const ok = await waitForTabUrlContains(tabId, request.expectedThreadId, 25000);
        if (!ok) {
          bgLog('NAVIGATE_TO_THREAD ✗ URL never matched expected thread');
          sendResponse({ success: false, error: 'Tab URL did not reach expected thread' });
          return;
        }
        await ensureContentScript(tabId);
        bgLog('NAVIGATE_TO_THREAD ✓ done');
        sendResponse({ success: true });
      } catch (e) {
        bgLog('NAVIGATE_TO_THREAD ✗ exception', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'SYNC_PROGRESS') {
    const p = Number(request.pct);
    const label = request.label != null ? String(request.label) : '';
    if (label.includes('navigation_failed')) {
      bgLog('SYNC_PROGRESS navigation_failed', request.pct, label);
    } else if (p === 0 || p >= 100 || Math.abs(p - lastLoggedProgressPct) >= 8) {
      lastLoggedProgressPct = p;
      bgLog('SYNC_PROGRESS', request.pct, label);
    }
    setSyncState({ running: true, pct: request.pct, label: request.label });
    return false;
  }

  if (request.action === 'EXTRACT_RAW') {
    bgLog('EXTRACT_RAW: handler start');
    setSyncState({ running: true, pct: 0, label: 'Starting...' });
    (async () => {
      try {
        bgLog('EXTRACT_RAW: querying active tab');
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        bgLog('EXTRACT_RAW: active tab', tab?.id, shortUrl(tab?.url, 90));
        if (!tab?.url?.includes('linkedin.com/messaging')) {
          bgLog('EXTRACT_RAW ✗ wrong page — need linkedin.com/messaging');
          setSyncState({ running: false, pct: 0, label: 'Open LinkedIn Messaging first' });
          sendResponse({ success: false, error: 'Open LinkedIn Messaging first' });
          return;
        }
        activeSyncTabId = tab.id;
        await ensureContentScript(tab.id);

        bgLog('EXTRACT_RAW: dispatching to content…');
        const response = await sendToContentScript(tab.id, { action: 'EXTRACT_RAW' });
        activeSyncTabId = null;

        if (!response?.success) {
          const stopped = response?.error === 'CANCELLED';
          bgLog('EXTRACT_RAW ✗ content failed', response?.error || '(no error string)', 'cancelled=', stopped);
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
        bgLog('EXTRACT_RAW ✓ success', { total, unread, missed });
        setSyncState({ running: false, pct: 100, label });
        chrome.storage.local.set({ lastSync: { timestamp: Date.now(), data: d } });
        sendResponse({ success: true, data: d });
      } catch (err) {
        activeSyncTabId = null;
        bgLog('EXTRACT_RAW ✗ exception', err.message, err.stack);
        setSyncState({ running: false, pct: 0, label: 'Error' });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'TEST_EXTRACT_CONTEXT_10') {
    bgLog('TEST_EXTRACT_CONTEXT_10: handler start');
    setSyncState({ running: true, pct: 0, label: 'Testing...' });
    (async () => {
      try {
        bgLog('TEST_EXTRACT_CONTEXT_10: querying active tab');
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        bgLog('TEST_EXTRACT_CONTEXT_10: active tab', tab?.id, shortUrl(tab?.url, 90));
        if (!tab?.url?.includes('linkedin.com/messaging')) {
          bgLog('TEST_EXTRACT_CONTEXT_10 ✗ wrong page');
          setSyncState({ running: false, pct: 0, label: 'Open LinkedIn Messaging first' });
          sendResponse({ success: false, error: 'Open LinkedIn Messaging first' });
          return;
        }

        activeSyncTabId = tab.id;
        await ensureContentScript(tab.id);

        const tabUrlAtStart = tab.url || '';
        const threadIdAtStart = parseThreadIdFromUrl(tabUrlAtStart);
        bgLog('TEST_EXTRACT_CONTEXT_10: tab before content run', {
          threadId: threadIdAtStart ? `${threadIdAtStart.slice(0, 28)}…` : '(none)',
          url: shortUrl(tabUrlAtStart, 100),
        });

        bgLog('TEST_EXTRACT_CONTEXT_10: dispatching to content…');
        const response = await sendToContentScript(tab.id, { action: 'TEST_EXTRACT_CONTEXT_10' });
        activeSyncTabId = null;

        if (!response?.success) {
          const stopped = response?.error === 'CANCELLED';
          bgLog('TEST_EXTRACT_CONTEXT_10 ✗ content failed', response?.error, 'cancelled=', stopped);
          setSyncState({ running: false, pct: 0, label: stopped ? 'Stopped' : 'Error' });
          sendResponse({ success: false, error: response?.error || 'Test extraction failed' });
          return;
        }

        let tabUrlAtEnd = tabUrlAtStart;
        let threadIdAtEnd = threadIdAtStart;
        try {
          const tAfter = await chrome.tabs.get(tab.id);
          tabUrlAtEnd = tAfter.url || '';
          threadIdAtEnd = parseThreadIdFromUrl(tabUrlAtEnd);
        } catch (e) {
          bgLog('TEST_EXTRACT_CONTEXT_10: could not re-read tab URL', e.message);
        }
        const navigationLikelyWorked = threadIdAtStart !== threadIdAtEnd;
        bgLog('TEST_EXTRACT_CONTEXT_10: tab after content run', {
          threadId: threadIdAtEnd ? `${threadIdAtEnd.slice(0, 28)}…` : '(none)',
          url: shortUrl(tabUrlAtEnd, 100),
          sameThreadAsStart: threadIdAtStart === threadIdAtEnd,
          hint: navigationLikelyWorked
            ? '(tab thread id changed at least once during run — check JSON for per-row ids)'
            : '⚠ Tab URL thread id never changed — list clicks likely did not switch threads; see page console [DIAG]/[extractUrl]',
        });

        const d = response.data;
        const count = Array.isArray(d?.conversations) ? d.conversations.length : 0;
        bgLog('TEST_EXTRACT_CONTEXT_10 ✓ success', 'conversations=', count);
        setSyncState({ running: false, pct: 100, label: `Test complete · ${count} threads` });
        chrome.storage.local.set({ testLastResult: { timestamp: Date.now(), data: d } });
        sendResponse({ success: true, data: d });
      } catch (err) {
        activeSyncTabId = null;
        bgLog('TEST_EXTRACT_CONTEXT_10 ✗ exception', err.message, err.stack);
        setSyncState({ running: false, pct: 0, label: 'Error' });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'STOP_SYNC') {
    bgLog('STOP_SYNC', 'activeSyncTabId=', activeSyncTabId);
    (async () => {
      try {
        if (activeSyncTabId) {
          await sendToContentScript(activeSyncTabId, { action: 'STOP_SYNC' });
          bgLog('STOP_SYNC: sent STOP_SYNC to tab', activeSyncTabId);
        } else {
          bgLog('STOP_SYNC: no active sync tab');
        }
      } catch (e) {
        bgLog('STOP_SYNC: send failed', e.message);
      }
      activeSyncTabId = null;
      setSyncState({ running: false, pct: 0, label: 'Stopped' });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'FORMAT_WITH_AI') {
    bgLog('FORMAT_WITH_AI: start');
    (async () => {
      try {
        const result = await formatWithAITextOnly(request.rawData, { unreadOnly: request.unreadOnly !== false });
        bgLog('FORMAT_WITH_AI ✓', 'filtered count=', result.filtered?.length);
        sendResponse({ success: true, filteredList: result.filtered, summary: result.summary });
      } catch (err) {
        bgLog('FORMAT_WITH_AI ✗', err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  bgLog('onMessage: UNHANDLED action', action);
  return false;
});

bgLog('startup', 'Background worker loaded (BG_DEBUG=', BG_DEBUG, ')');
