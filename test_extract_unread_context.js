/**
 * Console test script — aligned with extension content.js extraction logic.
 *
 * Fixes applied vs older version:
 * - Trailing-slash-safe thread IDs (parseThreadId)
 * - openThreadFromRow: synthetic click + pushState fallback (tabs.update only in extension)
 * - Participant names: [data-anonymize="person-name"] first (avoids "2h", "You:" as names)
 * - Message bodies: .msg-s-event-listitem__body only (avoids nav/modal noise)
 * - source_validation: expected_thread_id, thread_match, navigation_attempt, navigation_failed
 *
 * How to use:
 * 1) Open https://www.linkedin.com/messaging/ in Chrome
 * 2) DevTools → Console → paste this file → Enter
 * 3) is_from_me / sender are not set from DOM (agents infer direction from message text)
 * 4) runTestLatest10() — mirrors extension 10-thread test (thread pane scroll + latest 10)
 *    runTest({ limit: 5, withContextScroll: true }) — before/after scroll comparison
 *
 * Output: JSON logged to console; return value is the results array/object.
 */

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  console.log('[LinkedIn Unread Test]', ...args);
}

function findListContainer() {
  const selectors = [
    '.msg-conversations-container__conversations-list',
    '[class*="conversations-list"]',
    '.msg-conversations-container__convo-item-list',
    'ul[class*="msg-conversations"]',
  ];
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  const aside = document.querySelector('aside');
  if (aside) {
    const ul = aside.querySelector('ul');
    if (ul) return ul;
  }
  const lists = document.querySelectorAll('ul');
  for (const ul of lists) {
    if (ul.querySelectorAll('a[href*="/messaging/"]').length > 2) return ul;
  }
  return null;
}

function findConversationItems() {
  let items = document.querySelectorAll('.msg-conversation-listitem');
  if (items.length > 0) return [...items];

  items = document.querySelectorAll('li.msg-conversation-card');
  if (items.length > 0) return [...items];

  const links = document.querySelectorAll('a[href*="/messaging/thread/"], a[href*="/messaging/"]');
  const set = new Set();
  links.forEach(link => {
    const li = link.closest('li') || link.closest('[class*="conversation"]') || link;
    set.add(li);
  });
  if (set.size > 0) return [...set];

  const container = findListContainer();
  if (container) {
    const lis = container.querySelectorAll('li');
    if (lis.length > 0) return [...lis];
  }

  return [];
}

function extractName(item) {
  const nameSelectors = [
    '[data-anonymize="person-name"]',
    'h3', 'h4',
    '[class*="participant"]',
    '[class*="entity-name"]',
    '[class*="msg-conversation"]  span[class*="truncate"]',
    'strong',
  ];
  for (const s of nameSelectors) {
    const el = item.querySelector(s);
    if (el) {
      const t = el.textContent.trim();
      if (t && t.length > 1 && t.length < 120 && !t.includes('\n')) return t;
    }
  }
  const aria = item.getAttribute('aria-label') || '';
  if (aria) {
    const match = aria.match(/^(.+?)(?:\s*,|\s+\d|$)/);
    if (match && match[1].length > 1) return match[1].trim();
  }
  const spans = item.querySelectorAll('span');
  for (const sp of spans) {
    const t = sp.textContent.trim();
    if (t.length >= 2 && t.length <= 80 && !t.includes(':') && !t.includes('\n') && sp.children.length === 0) {
      return t;
    }
  }
  return 'Unknown';
}

function extractPreview(item) {
  const previewSelectors = [
    '[class*="snippet"]',
    '[class*="message-preview"]',
    '[class*="msg-conversation-card__message"]',
    'p',
  ];
  for (const s of previewSelectors) {
    const el = item.querySelector(s);
    if (el) {
      const t = el.textContent.trim();
      if (t && t.length > 0 && t.length < 500) return t;
    }
  }
  return '';
}

function toAbsoluteLinkedInMessagingUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t) return '';
  try {
    if (/^https?:\/\//i.test(t)) {
      const u = new URL(t);
      if (u.pathname.includes('/messaging/')) return u.href.split('#')[0];
      return '';
    }
    if (t.startsWith('//')) {
      const u = new URL(t, 'https://www.linkedin.com');
      if (u.pathname.includes('/messaging/')) return u.href.split('#')[0];
      return '';
    }
    const u = new URL(t, 'https://www.linkedin.com');
    if (u.pathname.includes('/messaging/')) return u.href.split('#')[0];
    return '';
  } catch (e) {
    return '';
  }
}

function threadIdLikeFromString(s) {
  if (!s || typeof s !== 'string') return '';
  const m = s.match(/2-[A-Za-z0-9+/=_-]{8,}/);
  return m ? m[0] : '';
}

function getConversationRowRoot(item) {
  if (!item) return null;
  return item.closest('li.msg-conversation-listitem')
    || item.closest('.msg-conversation-listitem')
    || item.closest('aside li')
    || item.closest('li')
    || item;
}

function resolveRowThreadUrl(el) {
  return extractUrl(el);
}

function deepQuerySelectorAll(root, selector) {
  const out = [];
  if (!root || root.nodeType !== 1) return out;
  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === 1) {
      try {
        node.querySelectorAll(selector).forEach((el) => out.push(el));
        const kids = node.children;
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
        if (node.shadowRoot) visit(node.shadowRoot);
      } catch (e) {}
    }
  };
  visit(root);
  return out;
}

function threadAnchorBelongsToRow(anchor, rowRoot) {
  if (!anchor || !rowRoot) return false;
  if (rowRoot.contains(anchor)) return true;
  const li = anchor.closest('li');
  if (!li) return false;
  return li === rowRoot || rowRoot.contains(li) || li.contains(rowRoot);
}

function findFirstThreadAnchorInRow(rowEl) {
  const rowRoot = getConversationRowRoot(rowEl) || rowEl;
  if (rowRoot.querySelector) {
    const shallow = rowRoot.querySelector('a[href*="/messaging/thread/"]');
    if (shallow) return shallow;
  }
  const deep = deepQuerySelectorAll(rowRoot, 'a[href*="/messaging/thread/"]');
  if (deep.length) return deep[0];
  const container = findListContainer() || document.querySelector('aside');
  if (container) {
    const links = deepQuerySelectorAll(container, 'a[href*="/messaging/thread/"]');
    for (const a of links) {
      if (threadAnchorBelongsToRow(a, rowRoot)) return a;
    }
  }
  return null;
}

function extractUrlFromListScopedThreadLinks(item, rowRoot, finish) {
  const container = findListContainer() || document.querySelector('aside');
  if (!container) return '';
  const links = deepQuerySelectorAll(container, 'a[href*="/messaging/thread/"]');
  for (const a of links) {
    if (!threadAnchorBelongsToRow(a, rowRoot)) continue;
    const href = a.getAttribute('href') || a.href;
    if (!href) continue;
    const abs = finish('listScope:deep(thread)', href);
    if (abs) return abs;
  }
  return '';
}

function extractUrl(item) {
  if (!item) {
    log('[extractUrl]', 'none', '(no item)');
    return '';
  }

  const finish = (strategy, href) => {
    const abs = toAbsoluteLinkedInMessagingUrl(href);
    if (abs) log('[extractUrl]', strategy, abs);
    return abs;
  };

  const hrefLooksThread = (h) => h && String(h).includes('/messaging/thread/');

  const rowRoot = getConversationRowRoot(item) || item;

  if (item.tagName === 'A') {
    const href = item.getAttribute('href') || item.href;
    if (hrefLooksThread(href)) {
      const abs = finish('self:a', href);
      if (abs) return abs;
    }
  }

  if (rowRoot.querySelector) {
    const down = rowRoot.querySelector('a[href*="/messaging/thread/"]');
    if (down) {
      const href = down.getAttribute('href') || down.href;
      const abs = finish('rowRoot:child(thread)', href);
      if (abs) return abs;
    }
  }

  for (const link of deepQuerySelectorAll(rowRoot, 'a[href*="/messaging/thread/"]')) {
    const href = link.getAttribute('href') || link.href;
    const abs = finish('rowRoot:deep(thread)', href);
    if (abs) return abs;
  }

  let node = item.parentElement;
  while (node && node !== document.body) {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || node.href;
      if (hrefLooksThread(href)) {
        const abs = finish('ancestor:a(self)', href);
        if (abs) return abs;
      }
    }
    if (node.querySelector) {
      const a = node.querySelector('a[href*="/messaging/thread/"]');
      if (a) {
        const href = a.getAttribute('href') || a.href;
        const abs = finish('ancestor:querySelector(thread)', href);
        if (abs) return abs;
      }
    }
    node = node.parentElement;
  }

  if (item.querySelector) {
    const child = item.querySelector('a[href*="/messaging/thread/"]');
    if (child) {
      const href = child.getAttribute('href') || child.href;
      const abs = finish('item:child(thread)', href);
      if (abs) return abs;
    }
  }

  if (item.closest) {
    const ca = item.closest('a[href*="/messaging/thread/"]');
    const href = ca && (ca.getAttribute('href') || ca.href);
    if (href) {
      const abs = finish('closest:a[thread]', href);
      if (abs) return abs;
    }
  }

  const dataHrefAttrs = ['data-href', 'data-url', 'data-href-thread', 'data-link', 'data-to'];
  let n = item;
  for (let depth = 0; depth < 16 && n; depth++) {
    for (const attr of dataHrefAttrs) {
      const v = n.getAttribute && n.getAttribute(attr);
      if (v) {
        const abs = finish(`data:${attr}@depth${depth}`, v);
        if (abs) return abs;
      }
    }
    n = n.parentElement;
  }

  let loggedUrnNoTid = false;
  n = item;
  for (let depth = 0; depth < 16 && n; depth++) {
    const urn = n.getAttribute && n.getAttribute('data-entity-urn');
    if (urn) {
      const tid = threadIdLikeFromString(urn);
      if (tid) {
        const abs = finish(`data-entity-urn@depth${depth}`, `/messaging/thread/${tid}/`);
        if (abs) return abs;
      }
      if (!loggedUrnNoTid) {
        log('[extractUrl] found URN, no thread URL from it:', urn);
        loggedUrnNoTid = true;
      }
    }
    n = n.parentElement;
  }

  const urnClosest = item.closest && item.closest('[data-entity-urn]');
  const urn2 = urnClosest && urnClosest.getAttribute('data-entity-urn');
  if (urn2) {
    const tid = threadIdLikeFromString(urn2);
    if (tid) {
      const abs = finish('closest:data-entity-urn', `/messaging/thread/${tid}/`);
      if (abs) return abs;
    }
    log('[extractUrl] found URN (closest), no thread id:', urn2);
  }

  const fromList = extractUrlFromListScopedThreadLinks(item, rowRoot, finish);
  if (fromList) return fromList;

  const cls = (item.className && String(item.className)) || '';
  let snippet = '';
  try {
    snippet = item.outerHTML ? item.outerHTML.slice(0, 300) : '';
  } catch (e) {}
  log('[extractUrl] FAILED on row:', cls, snippet);
  return '';
}

function extractTimestamp(item) {
  const time = item.querySelector('time');
  if (time) return time.getAttribute('datetime') || time.textContent.trim();
  const timeEl = item.querySelector('[class*="time"], [class*="date"]');
  if (timeEl) return timeEl.textContent.trim();
  return '';
}

function getClickTarget(rowEl) {
  const a = findFirstThreadAnchorInRow(rowEl);
  if (a) return a;
  const overlay = rowEl.querySelector('[data-control-name="message_overlay"]');
  if (overlay) return overlay;
  const tab0 = rowEl.querySelector('[tabindex="0"]');
  if (tab0) return tab0;
  return rowEl.closest('li') || rowEl;
}

function syntheticClick(el) {
  if (!el || typeof el.dispatchEvent !== 'function') return;
  const base = { bubbles: true, cancelable: true, view: window };
  const seq = [
    ['pointerdown', 1],
    ['mousedown', 1],
    ['pointerup', 0],
    ['mouseup', 0],
    ['click', 0],
  ];
  for (const [type, buttons] of seq) {
    try {
      el.dispatchEvent(new MouseEvent(type, { ...base, button: 0, buttons }));
    } catch (e) {}
  }
}

function parseThreadId(url) {
  if (!url) return '';
  try {
    const clean = url.split('#')[0].split('?')[0].trim().replace(/\/+$/, '');
    const m = clean.match(/\/messaging\/thread\/([^/?#]+)/);
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}

function normalizeConversationStorageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const id = parseThreadId(url);
  if (id) return `https://www.linkedin.com/messaging/thread/${id}/`;
  let u = url.split('#')[0].split('?')[0].trim().replace(/\/+$/, '');
  return u ? `${u}/` : '';
}

function normalizeMessagingPath(url) {
  if (!url) return '';
  try {
    const id = parseThreadId(url);
    if (!id) return '';
    return `/messaging/thread/${id}/`;
  } catch (e) {
    return '';
  }
}

async function waitForExpectedThread(expectedThreadId, previousThreadId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = parseThreadId(window.location.href);
    if (expectedThreadId) {
      if (cur === expectedThreadId) {
        return { thread_match: true, resolved: cur, switched: cur !== previousThreadId };
      }
    } else if (cur && cur !== previousThreadId) {
      return { thread_match: true, resolved: cur, switched: true };
    }
    await sleep(150);
  }
  const cur = parseThreadId(window.location.href);
  if (expectedThreadId) {
    return { thread_match: cur === expectedThreadId, resolved: cur, switched: cur !== previousThreadId };
  }
  return { thread_match: false, resolved: cur, switched: cur !== previousThreadId };
}

function navigateViaBackground(url, expectedThreadId) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('No extension context'));
      return;
    }
    chrome.runtime.sendMessage(
      { action: 'NAVIGATE_TO_THREAD', url, expectedThreadId },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) resolve();
        else reject(new Error(response?.error || 'NAVIGATE_TO_THREAD failed'));
      }
    );
  });
}

async function openThreadFromRow(rowEl, rowConversationUrl) {
  let rowUrl = (rowConversationUrl || '').trim();
  if (!parseThreadId(rowUrl)) {
    await sleep(200);
    rowUrl = resolveRowThreadUrl(rowEl);
    log('openThreadFromRow:retry-extractUrl', rowUrl || '(still empty)');
  }

  const expectedThreadId = parseThreadId(rowUrl);
  const prevThreadId = parseThreadId(window.location.href);
  let navigation_attempt = 'none';

  const afterPushState = async (timeoutMs) => {
    await sleep(400);
    return waitForExpectedThread(expectedThreadId || null, prevThreadId, timeoutMs);
  };

  const clickTarget = getClickTarget(rowEl);
  navigation_attempt = 'native_click';
  try {
    clickTarget.click();
  } catch (e) {
    log('openThreadFromRow: native click failed, synthetic', e);
    navigation_attempt = 'synthetic_click';
    syntheticClick(clickTarget);
  }
  let w = await waitForExpectedThread(expectedThreadId || null, prevThreadId, 5500);
  if (w.thread_match) {
    return {
      ...w,
      navigation_attempt,
      previous_thread_id: prevThreadId,
      expected_thread_id: expectedThreadId,
    };
  }

  if (expectedThreadId && rowUrl) {
    navigation_attempt = 'pushState';
    try {
      const path = normalizeMessagingPath(rowUrl);
      if (path) {
        history.pushState({}, '', path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        w = await afterPushState(8000);
        if (w.thread_match) {
          return {
            ...w,
            navigation_attempt,
            previous_thread_id: prevThreadId,
            expected_thread_id: expectedThreadId,
          };
        }
      }
    } catch (e) {
      log('pushState navigation failed', e);
    }
  }

  if (expectedThreadId && rowUrl) {
    navigation_attempt = 'anchor_click';
    try {
      const fullUrl = rowUrl.startsWith('http')
        ? rowUrl
        : new URL(rowUrl, 'https://www.linkedin.com').href;
      const a = document.createElement('a');
      a.href = fullUrl;
      a.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:auto;';
      document.body.appendChild(a);
      syntheticClick(a);
      await sleep(600);
      a.remove();
      w = await waitForExpectedThread(expectedThreadId, prevThreadId, 10000);
      if (w.thread_match) {
        return {
          ...w,
          navigation_attempt,
          previous_thread_id: prevThreadId,
          expected_thread_id: expectedThreadId,
        };
      }
    } catch (e) {
      log('anchor_click navigation failed', e);
    }
  }

  if (expectedThreadId && rowUrl) {
    navigation_attempt = 'tabs_update';
    try {
      const fullUrl = rowUrl.startsWith('http')
        ? rowUrl
        : new URL(rowUrl, 'https://www.linkedin.com').href;
      await navigateViaBackground(fullUrl, expectedThreadId);
      await sleep(500);
      w = await waitForExpectedThread(expectedThreadId, prevThreadId, 12000);
      if (w.thread_match) {
        return {
          ...w,
          navigation_attempt,
          previous_thread_id: prevThreadId,
          expected_thread_id: expectedThreadId,
        };
      }
    } catch (e) {
      log('tabs_update navigation failed', e);
    }
  }

  const resolved = parseThreadId(window.location.href);
  return {
    thread_match: expectedThreadId ? resolved === expectedThreadId : false,
    resolved,
    switched: resolved !== prevThreadId,
    navigation_attempt,
    previous_thread_id: prevThreadId,
    expected_thread_id: expectedThreadId,
  };
}

function buildSourceValidation(openResult) {
  const resolved = parseThreadId(window.location.href);
  const expected = openResult.expected_thread_id || '';
  const thread_match = expected ? resolved === expected : !!openResult.thread_match;
  let expectedOut = expected;
  if (!expectedOut && thread_match && resolved) {
    expectedOut = resolved;
  }
  return {
    previous_thread_id: openResult.previous_thread_id,
    resolved_thread_id: resolved,
    expected_thread_id: expectedOut,
    thread_match,
    switched: resolved !== openResult.previous_thread_id,
    navigation_failed: !thread_match,
    navigation_attempt: openResult.navigation_attempt,
  };
}

async function tryApplyUnreadFilter() {
  const allBtns = document.querySelectorAll('button, [role="tab"], [role="option"], [role="radio"]');
  for (const btn of allBtns) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (text === 'unread' || label.includes('unread')) {
      btn.click();
      await sleep(1500);
      log('Applied Unread filter (button/tab).');
      return true;
    }
  }

  const filterBtns = document.querySelectorAll('[class*="filter"], [aria-label*="Filter"], [aria-label*="filter"]');
  for (const fb of filterBtns) {
    fb.click();
    await sleep(800);
    const menuItems = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li[class*="dropdown"]');
    for (const mi of menuItems) {
      if ((mi.textContent || '').trim().toLowerCase().includes('unread')) {
        mi.click();
        await sleep(1500);
        log('Applied Unread filter (dropdown).');
        return true;
      }
    }
    fb.click();
    await sleep(300);
  }

  log('Unread filter not found; proceeding with visible items.');
  return false;
}

async function scrollThreadPaneForLatestMessages() {
  let box = document.querySelector('.msg-s-message-list__event-list');
  if (!box) box = document.querySelector('[class*="msg-s-message-list"]');
  if (!box) {
    const body = document.querySelector('.msg-s-event-listitem__body');
    let p = body && body.parentElement;
    while (p) {
      if (p.scrollHeight > p.clientHeight + 2) {
        box = p;
        break;
      }
      p = p.parentElement;
    }
  }
  if (!box) return;

  for (let c = 0; c < 3; c++) {
    box.scrollTop = 0;
    await sleep(600);
    box.scrollTop = box.scrollHeight;
    await sleep(300);
  }
}

function isFromMeMessageBody(_bodyEl) {
  // Match extension: no DOM sender detection; agents infer from message text.
  return false;
}

function findTimestampNearBody(bodyEl) {
  let n = bodyEl;
  for (let i = 0; i < 10 && n; i++) {
    const t = n.querySelector && n.querySelector('time');
    if (t) {
      return t.getAttribute('datetime') || t.textContent.trim() || '';
    }
    n = n.parentElement;
  }
  return '';
}

function extractThreadMessages() {
  const messages = [];
  const bodies = document.querySelectorAll('.msg-s-event-listitem__body');

  bodies.forEach(body => {
    const text = body.textContent.trim();
    if (!text || text.length < 2) return;

    const timestamp = findTimestampNearBody(body);

    const isMe = isFromMeMessageBody(body);
    messages.push({
      sender: isMe ? 'me' : 'them',
      text,
      timestamp,
      is_from_me: isMe,
    });
  });

  if (messages.length === 0) {
    const main = document.querySelector('main');
    if (main) {
      main.querySelectorAll('p').forEach(p => {
        const t = p.textContent.trim();
        if (t && t.length > 1 && t.length < 2000) {
          messages.push({ sender: 'them', text: t, timestamp: '', is_from_me: false });
        }
      });
    }
  }

  return messages;
}

function limitMessages(messages, max = 10) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= max) return messages;
  return messages.slice(-max);
}

async function scrollThreadToTop() {
  const threadContainerSelectors = [
    '.msg-s-message-list-container',
    '[class*="message-list-container"]',
    '[class*="msg-thread"]',
    'main [class*="messages"]',
    'main ul',
  ];

  let threadBox = null;
  for (const s of threadContainerSelectors) {
    const el = document.querySelector(s);
    if (el) {
      threadBox = el;
      break;
    }
  }
  if (!threadBox) return;

  for (let i = 0; i < 5; i++) {
    threadBox.scrollTop = 0;
    await sleep(800);
  }
}

function summarizeMessages(messages) {
  if (!messages || messages.length === 0) return { count: 0 };
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    count: messages.length,
    firstText: (first.text || '').slice(0, 80),
    lastText: (last.text || '').slice(0, 80),
  };
}

/**
 * @param {object} opts
 * @param {number} [opts.limit=10] — how many list rows to open
 * @param {boolean} [opts.unreadFilter=true]
 * @param {boolean} [opts.withContextScroll=false] — if true, compare message count before/after scroll-to-top
 * @param {number} [opts.latestMessageCap=10] — max messages kept per thread in latest payload
 */
async function runTest(opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 10;
  const unreadFilter = opts.unreadFilter !== false;
  const withContextScroll = opts.withContextScroll === true;
  const latestMessageCap = typeof opts.latestMessageCap === 'number' ? opts.latestMessageCap : 10;

  log('Starting test...', { limit, unreadFilter, withContextScroll, latestMessageCap });

  const filterApplied = unreadFilter ? await tryApplyUnreadFilter() : false;
  if (unreadFilter) await sleep(1200);

  const allItems = findConversationItems();
  if (!allItems.length) {
    log('No conversation items found in the list.');
    return { error: 'no_items', conversations: [] };
  }

  const picked = allItems.slice(0, Math.min(limit, allItems.length));
  log(`Found ${allItems.length} items; opening first ${picked.length}... (unread filter: ${filterApplied})`);

  findConversationItems().slice(0, 3).forEach((r, i) => {
    const u = extractUrl(r);
    const tid = parseThreadId(u);
    log(`[DIAG] row ${i}: url="${u}" tid="${tid}" class="${(r.className && String(r.className)) || ''}"`);
  });

  const results = [];

  for (let i = 0; i < picked.length; i++) {
    const item = picked[i];
    const participant_name = extractName(item);
    log(`Opening conversation ${i + 1}/${picked.length}: ${participant_name}`);

    let rowUrl = resolveRowThreadUrl(item);
    item.scrollIntoView({ block: 'center' });
    await sleep(350);
    rowUrl = resolveRowThreadUrl(item) || rowUrl;
    const openResult = await openThreadFromRow(item, rowUrl);
    if (!openResult.thread_match) await sleep(400);

    const threadUrl = window.location.href;
    const source_validation = buildSourceValidation(openResult);
    const convUrl =
      normalizeConversationStorageUrl(threadUrl.includes('/messaging/') ? threadUrl : rowUrl)
      || (threadUrl.includes('/messaging/') ? threadUrl : rowUrl);

    if (withContextScroll) {
      await scrollThreadPaneForLatestMessages();
    const beforeMessages = extractThreadMessages();
    const beforeSummary = summarizeMessages(beforeMessages);

    await scrollThreadToTop();
    await sleep(1500);

    const afterMessages = extractThreadMessages();
    const afterSummary = summarizeMessages(afterMessages);

    results.push({
      index: i,
        participant_name,
        conversation_url: convUrl,
        message_preview: extractPreview(item),
        timestamp: extractTimestamp(item),
        source_validation,
      before: beforeSummary,
      after: afterSummary,
      expanded: afterMessages.length > beforeMessages.length,
    });

    log(
        `Conversation ${i + 1}: before ${beforeSummary.count} msgs, after ${afterSummary.count} msgs, expanded=${afterMessages.length > beforeMessages.length}, navigation_failed=${source_validation.navigation_failed}`
      );
    } else {
      await scrollThreadPaneForLatestMessages();
      const allMessages = extractThreadMessages();
      const latestMessages = limitMessages(allMessages, latestMessageCap);

      results.push({
        index: i,
        participant_name,
        conversation_url: convUrl,
        message_preview: extractPreview(item),
        timestamp: extractTimestamp(item),
        source_validation,
        latest_messages: latestMessages,
        message_count: latestMessages.length,
        latest: {
          message_count: latestMessages.length,
          messages: latestMessages,
          latest_message: latestMessages.length ? latestMessages[latestMessages.length - 1].text : '',
          previous_message: latestMessages.length > 1 ? latestMessages[latestMessages.length - 2].text : '',
        },
      });

      log(
        `Conversation ${i + 1}: messages=${allMessages.length}, latest kept=${latestMessages.length}, navigation_failed=${source_validation.navigation_failed}`
      );
    }
  }

  const out = {
    testId: withContextScroll ? 'extract_context_compare' : `extract_latest_${latestMessageCap}`,
    extracted_at: new Date().toISOString(),
    unreadFilterApplied: filterApplied,
    conversations: results,
    summary: `Test complete · ${results.length} threads · unread filter: ${filterApplied ? 'on' : 'off'}`,
  };

  log('Test complete. Results:');
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/** Same shape as extension TEST_EXTRACT_CONTEXT_10: latest messages only, no thread scroll-for-context. */
function runTestLatest10() {
  return runTest({ limit: 10, unreadFilter: true, withContextScroll: false, latestMessageCap: 10 });
}

window.runTest = runTest;
window.runTestLatest10 = runTestLatest10;
