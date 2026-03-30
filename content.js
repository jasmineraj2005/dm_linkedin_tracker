/**
 * Content script - RAW extraction
 * Clicks each conversation directly, reads URL from browser, scrolls thread
 * for context, and extracts messages with broad selector fallbacks.
 */

let cancelled = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(...args) {
  console.log('[LinkedIn Sync]', ...args);
}

function reportProgress(pct, label) {
  try {
    chrome.runtime.sendMessage({ action: 'SYNC_PROGRESS', pct: Math.round(pct), label });
  } catch (e) {}
}

function checkCancelled() {
  if (cancelled) throw new Error('CANCELLED');
}

/* ── List container ── */

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

/* ── Conversation item discovery ── */

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

function countLoadedItems() {
  return findConversationItems().length;
}

/* ── Name extraction ── */

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

/* ── Preview extraction ── */

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

/* ── URL extraction from item ── */

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

/** `querySelector` does not pierce shadow roots; LinkedIn may nest thread links there. */
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

/* ── Timestamp extraction ── */

function extractTimestamp(item) {
  const time = item.querySelector('time');
  if (time) return time.getAttribute('datetime') || time.textContent.trim();
  const timeEl = item.querySelector('[class*="time"], [class*="date"]');
  if (timeEl) return timeEl.textContent.trim();
  return '';
}

/* ── Unread detection ── */

function isUnread(item) {
  const cls = (item.className || '').toLowerCase();
  if (cls.includes('unread')) return true;
  if (item.querySelector('[class*="unread"]')) return true;
  const aria = (item.getAttribute('aria-label') || '').toLowerCase();
  if (aria.includes('unread')) return true;
  const badge = item.querySelector('[class*="badge"], [class*="count"], [class*="notification"]');
  if (badge) {
    const t = (badge.textContent || '').trim();
    if (/^\d+$/.test(t)) return true;
  }
  const nameEl = item.querySelector('h3, h4, [class*="participant"], strong');
  if (nameEl) {
    const fw = parseInt(window.getComputedStyle(nameEl).fontWeight);
    if (fw >= 600) return true;
  }
  return false;
}

/* ── Click into a conversation and get the URL (SPA-safe) ── */

const PROCESSED_THREAD_CAP = 5000;

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

function loadProcessedThreadIds() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['processedThreadIds'], (r) => {
      const arr = Array.isArray(r.processedThreadIds) ? r.processedThreadIds : [];
      resolve(new Set(arr));
    });
  });
}

function appendProcessedThreadId(threadId) {
  if (!threadId) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.local.get(['processedThreadIds'], (r) => {
      let arr = Array.isArray(r.processedThreadIds) ? r.processedThreadIds : [];
      if (!arr.includes(threadId)) arr.push(threadId);
      if (arr.length > PROCESSED_THREAD_CAP) arr = arr.slice(-PROCESSED_THREAD_CAP);
      chrome.storage.local.set({ processedThreadIds: arr }, resolve);
    });
  });
}

/* ── Thread pane: scroll to load virtualized messages, then read bodies ── */

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
  // Intentionally disabled: LinkedIn DOM for outbound/inbound breaks often; agents infer
  // direction from message text (sign-offs, "Hey [name]", first-person framing).
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

/* ── Extract messages from the open thread ── */

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

/* ── Scrolling the DM list ── */

async function scrollToLoadAll(container, progressBase, progressSpan) {
  if (!container) return 0;

  const MAX_ROUNDS = 150;
  const SCROLL_PX = 600;
  const WAIT_MS = 1200;
  const STALL_LIMIT = 5;

  let prevCount = countLoadedItems();
  let stalls = 0;

  log(`Starting scroll. Initial items: ${prevCount}`);
  reportProgress(progressBase, `Scrolling... ${prevCount} loaded`);

  for (let i = 0; i < MAX_ROUNDS; i++) {
    checkCancelled();
    container.scrollTop = container.scrollHeight;
    await sleep(WAIT_MS);

    const now = countLoadedItems();
    const pct = progressBase + (i / MAX_ROUNDS) * progressSpan;
    reportProgress(pct, `Scrolling... ${now} loaded`);

    if (now > prevCount) {
      log(`Scroll ${i + 1}: ${prevCount} → ${now} items`);
      prevCount = now;
      stalls = 0;
    } else {
      stalls++;
      if (stalls >= STALL_LIMIT) {
        log(`No new items for ${STALL_LIMIT} consecutive scrolls. Stopping.`);
        break;
      }
      container.scrollTop += SCROLL_PX;
      await sleep(800);
    }
  }

  container.scrollTop = 0;
  await sleep(500);

  const finalCount = countLoadedItems();
  log(`Scroll complete. Total loaded: ${finalCount}`);
  return finalCount;
}

/* ── Verification ── */

async function verifyFullLoad(container) {
  if (!container) return;
  const before = countLoadedItems();
  log(`Verification pass. Items before: ${before}`);
  reportProgress(48, 'Verifying');

  for (let i = 0; i < 20; i++) {
    checkCancelled();
    container.scrollTop = container.scrollHeight;
    await sleep(1000);
  }
  container.scrollTop = 0;
  await sleep(400);

  const after = countLoadedItems();
  if (after > before) {
    log(`Verification found ${after - before} more items. Re-scrolling.`);
    await scrollToLoadAll(container, 50, 5);
  } else {
    log(`Verification passed. Count stable at ${after}.`);
  }
  reportProgress(55, 'Verified');
}

/* ── Unread filter ── */

async function tryApplyUnreadFilter() {
  reportProgress(1, 'Looking for unread filter...');

  const allBtns = document.querySelectorAll('button, [role="tab"], [role="option"], [role="radio"]');
  for (const btn of allBtns) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (text === 'unread' || label.includes('unread')) {
      btn.click();
      await sleep(1500);
      log('Applied "Unread" filter');
      return true;
    }
  }

  const filterBtns = document.querySelectorAll(
    '[class*="filter"], [aria-label*="Filter"], [aria-label*="filter"]'
  );
  for (const fb of filterBtns) {
    fb.click();
    await sleep(800);
    const menuItems = document.querySelectorAll(
      '[role="option"], [role="menuitem"], [role="menuitemradio"], li[class*="dropdown"]'
    );
    for (const mi of menuItems) {
      if ((mi.textContent || '').trim().toLowerCase().includes('unread')) {
        mi.click();
        await sleep(1500);
        log('Applied "Unread" filter from dropdown');
        return true;
      }
    }
    fb.click();
    await sleep(300);
  }

  log('Unread filter not found, proceeding with full list');
  return false;
}

async function tryClearFilter() {
  const allBtns = document.querySelectorAll('button, [role="tab"]');
  for (const btn of allBtns) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (text === 'all' || text === 'focused') {
      btn.click();
      await sleep(1000);
      return;
    }
  }
}

/* ── Main extraction ── */

async function extractRaw() {
  const listContainer = findListContainer();
  if (!listContainer) {
    return { error: 'Could not find conversation list', conversations: [], unread: [] };
  }

  reportProgress(0, 'Starting...');

  log('Phase 0: Attempting unread filter...');
  const filterApplied = await tryApplyUnreadFilter();
  const processedThreadIds = await loadProcessedThreadIds();
  const BATCH_SIZE = 10;
  const MAX_BATCH_LOOPS = 60;
  const allMap = new Map();
  const processedUnreadKeys = new Set();
  const unreadWithMessages = [];
  let maxUnreadSeen = 0;
  let batchLoop = 0;

  function snapshotUnreadItems() {
    const items = findConversationItems();
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const name = extractName(item);
      const preview = extractPreview(item);
      const rawUrl = resolveRowThreadUrl(item);
      const url = normalizeConversationStorageUrl(rawUrl) || rawUrl;
      const timestamp = extractTimestamp(item);
      const unread = filterApplied ? true : isUnread(item);
      const key = url || `${name}__${timestamp}__${preview.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row = {
        key,
        element: item,
        participant_name: name,
        conversation_url: url,
        message_preview: preview,
        timestamp,
        is_unread: unread,
        read_status: unread ? 'unread' : 'read'
      };
      out.push(row);
      allMap.set(key, {
        participant_name: name,
        conversation_url: url,
        message_preview: preview,
        timestamp,
        is_unread: unread,
        read_status: unread ? 'unread' : 'read'
      });
    }
    return out.filter(x => x.is_unread);
  }

  while (batchLoop < MAX_BATCH_LOOPS) {
    checkCancelled();
    batchLoop++;

    const liveContainer = findListContainer() || listContainer;
    log(`Batch loop ${batchLoop}: scrolling and verifying unread list...`);
    reportProgress(Math.min(10 + batchLoop * 2, 50), `Loading unread list... loop ${batchLoop}`);
    await scrollToLoadAll(liveContainer, 5, 5);
    await verifyFullLoad(liveContainer);

    const unreadSnapshot = snapshotUnreadItems();
    maxUnreadSeen = Math.max(maxUnreadSeen, unreadSnapshot.length);
    const newUnread = unreadSnapshot.filter(c => !processedUnreadKeys.has(c.key));

    log(`Batch loop ${batchLoop}: unread seen=${unreadSnapshot.length}, new=${newUnread.length}, processed=${processedUnreadKeys.size}`);

    if (newUnread.length === 0) {
      log('No new unread conversations found. Ending batch loop.');
      break;
    }

    const batch = newUnread.slice(0, BATCH_SIZE);
    reportProgress(Math.min(55 + batchLoop * 2, 90), `Processing batch ${batchLoop}: ${batch.length} threads`);

    for (let i = 0; i < batch.length; i++) {
      checkCancelled();
      const c = batch[i];
      const el = c.element;
      const rowTid = parseThreadId(c.conversation_url);
      if (rowTid && processedThreadIds.has(rowTid)) {
        processedUnreadKeys.add(c.key);
        log(`    → skip already-processed thread ${rowTid.slice(0, 24)}…`);
        continue;
      }

      el.scrollIntoView({ block: 'center' });
      await sleep(300);
      const openResult = await openThreadFromRow(el, resolveRowThreadUrl(el) || c.conversation_url);
      if (!openResult.thread_match) await sleep(400);

      const threadUrl = window.location.href;
      const source_validation = buildSourceValidation(openResult);
      const stepLabel = `Batch ${batchLoop} · ${i + 1}/${batch.length}: ${c.participant_name}${
        source_validation.navigation_failed ? ' · navigation_failed' : ''
      }`;
      reportProgress(Math.min(60 + (i / Math.max(batch.length, 1)) * 25, 95), stepLabel);
      log(`  ${stepLabel}`);
      if (source_validation.navigation_failed) {
        log('    ⚠ URL/thread id did not match expected — possible rate limit or UI lag');
      }
      if (source_validation.thread_match && source_validation.resolved_thread_id) {
        processedThreadIds.add(source_validation.resolved_thread_id);
        await appendProcessedThreadId(source_validation.resolved_thread_id);
      }

      await scrollThreadPaneForLatestMessages();
      const messages = extractThreadMessages();
      const latest10 = limitMessages(messages, 10);

      const storedConvUrl = normalizeConversationStorageUrl(
        threadUrl.includes('/messaging/') ? threadUrl : c.conversation_url
      );

      unreadWithMessages.push({
        participant_name: c.participant_name,
        conversation_url: storedConvUrl || (threadUrl.includes('/messaging/') ? threadUrl : c.conversation_url),
        message_preview: c.message_preview,
        timestamp: c.timestamp,
        is_unread: true,
        read_status: 'unread',
        messages,
        latest_messages: latest10,
        latest_message: messages.length ? messages[messages.length - 1].text : c.message_preview,
        previous_message: messages.length > 1 ? messages[messages.length - 2].text : '',
        source_validation
      });
      processedUnreadKeys.add(c.key);
      log(`    → messages=${messages.length}, latest10=${latest10.length}`);

      await sleep(1000 + Math.random() * 200);
    }
  }

  const allOutput = Array.from(allMap.values()).map((row) => ({
    ...row,
    conversation_url: normalizeConversationStorageUrl(row.conversation_url) || row.conversation_url,
  }));
  let totalInInbox = allOutput.length;
  if (filterApplied) {
    log('Clearing unread filter to count total inbox...');
    reportProgress(96, 'Counting total inbox...');
    await tryClearFilter();
    await sleep(1500);
    const inboxContainer = findListContainer();
    if (inboxContainer) {
      await scrollToLoadAll(inboxContainer, 96, 3);
      totalInInbox = countLoadedItems();
      log(`Total inbox count: ${totalInInbox}`);
    }
  }

  const missedUnreadCount = Math.max(0, maxUnreadSeen - unreadWithMessages.length);
  const finalLabel = missedUnreadCount > 0
    ? `Complete · ${unreadWithMessages.length} unread / ${totalInInbox} total · missed ${missedUnreadCount}`
    : `Complete · ${unreadWithMessages.length} unread / ${totalInInbox} total`;

  reportProgress(100, finalLabel);
  log('========== EXTRACTION COMPLETE ==========');
  log(`Unread extracted: ${unreadWithMessages.length} | Max unread seen: ${maxUnreadSeen} | Missed: ${missedUnreadCount} | Total inbox: ${totalInInbox}`);

  return {
    extracted_at: new Date().toISOString(),
    all_conversations: allOutput,
    unread_count: unreadWithMessages.length,
    total_in_inbox: totalInInbox,
    max_unread_seen: maxUnreadSeen,
    missed_unread_count: missedUnreadCount,
    unread_with_context: unreadWithMessages,
  };
}

/* ── Test extraction: first N conversations + context ── */

function limitMessages(messages, max = 10) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= max) return messages;
  // Keep the latest N messages (best-effort within what LinkedIn has rendered).
  return messages.slice(-max);
}

async function extractContextTest(limit = 10) {
  const listContainer = findListContainer();
  if (!listContainer) {
    return { error: 'Could not find conversation list', conversations: [] };
  }

  reportProgress(0, 'Starting test...');

  log('TEST: Phase 0: Attempting unread filter...');
  const filterApplied = await tryApplyUnreadFilter();

  // Load enough items to get at least `limit` conversations.
  log(`TEST: Phase 1: Loading at least ${limit} conversations...`);
  let items = findConversationItems();
  let rounds = 0;
  while (items.length < limit && rounds < 60) {
    checkCancelled();
    listContainer.scrollTop = listContainer.scrollHeight;
    await sleep(1000);
    await sleep(500);
    items = findConversationItems();
    rounds++;
  }

  const picked = items.slice(0, Math.min(limit, items.length));
  reportProgress(10, `Picked ${picked.length} threads`);

  findConversationItems().slice(0, 3).forEach((r, i) => {
    const u = extractUrl(r);
    const tid = parseThreadId(u);
    log(`[DIAG] row ${i}: url="${u}" tid="${tid}" class="${(r.className && String(r.className)) || ''}"`);
  });

  const conversations = [];
  for (let i = 0; i < picked.length; i++) {
    checkCancelled();
    const el = picked[i];
    const name = extractName(el);
    const preview = extractPreview(el);
    let url = resolveRowThreadUrl(el);
    const timestamp = extractTimestamp(el);

    const threadPct = 10 + ((i + 1) / Math.max(picked.length, 1)) * 80;
    reportProgress(threadPct, `Test thread ${i + 1}/${picked.length}: ${name}`);

    el.scrollIntoView({ block: 'center' });
    await sleep(350);
    url = resolveRowThreadUrl(el) || url;
    const openResult = await openThreadFromRow(el, url);
    if (!openResult.thread_match) await sleep(400);

    const threadUrl = window.location.href;
    const source_validation = buildSourceValidation(openResult);
    if (source_validation.navigation_failed) {
      reportProgress(threadPct, `Test thread ${i + 1}/${picked.length}: ${name} · navigation_failed`);
      log(`[TEST] navigation_failed for ${name}`);
    }

    await scrollThreadPaneForLatestMessages();
    const allMessages = extractThreadMessages();
    const latestMessages = limitMessages(allMessages, limit);

    const convUrl =
      normalizeConversationStorageUrl(threadUrl.includes('/messaging/') ? threadUrl : url)
      || (threadUrl.includes('/messaging/') ? threadUrl : url);

    conversations.push({
      index: i,
      participant_name: name,
      conversation_url: convUrl,
      message_preview: preview,
      timestamp,
      is_unread: true,
      read_status: 'unread',
      latest_messages: latestMessages,
      message_count: latestMessages.length,
      latest: {
        message_count: latestMessages.length,
        messages: latestMessages,
        latest_message: latestMessages.length ? latestMessages[latestMessages.length - 1].text : '',
        previous_message: latestMessages.length > 1 ? latestMessages[latestMessages.length - 2].text : ''
      },
      source_validation
    });

    await sleep(1000 + Math.random() * 200);
  }

  const summary = `Test complete · ${conversations.length} threads · unread filter: ${filterApplied ? 'on' : 'off'}`;
  return {
    testId: `extract_latest_${limit}`,
    extracted_at: new Date().toISOString(),
    unreadFilterApplied: filterApplied,
    conversations,
    summary,
  };
}

/* ── Message listener ── */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'EXTRACT_RAW') {
    cancelled = false;
    extractRaw()
      .then(data => sendResponse({ success: true, data }))
      .catch(err => {
        if (err.message === 'CANCELLED') {
          reportProgress(0, 'Stopped');
          sendResponse({ success: false, error: 'CANCELLED' });
        } else {
          reportProgress(0, 'Error: ' + err.message);
          sendResponse({ success: false, error: err.message });
        }
      });
    return true;
  }

  if (request.action === 'TEST_EXTRACT_CONTEXT_10') {
    cancelled = false;
    extractContextTest(10)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => {
        if (err.message === 'CANCELLED') {
          reportProgress(0, 'Stopped');
          sendResponse({ success: false, error: 'CANCELLED' });
        } else {
          reportProgress(0, 'Error: ' + err.message);
          sendResponse({ success: false, error: err.message });
        }
      });
    return true;
  }

  if (request.action === 'STOP_SYNC') {
    cancelled = true;
    sendResponse({ success: true });
    return true;
  }
});
