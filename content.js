/**
 * Content script - RAW extraction
 * Sync uses unread-only batches, test-style shallow thread capture, and optional per-batch downloads.
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

/** Temporary: auto-download each batch; skip clearing Unread filter / full inbox count. Keep in sync with background.js. */
const SYNC_TEMP_BATCH_DOWNLOAD_NO_PERSIST = true;

function sendSyncBatchFile(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'SYNC_BATCH_FILE', payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || 'SYNC_BATCH_FILE failed'));
        return;
      }
      resolve(response);
    });
  });
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

function extractUrl(item) {
  const threads = item.querySelectorAll('a[href*="/messaging/thread/"]');
  for (const link of threads) {
    const h = link.href || '';
    if (h && !h.includes('/messaging/thread/new')) return h;
  }
  const linkSelectors = ['a[href*="/messaging/"]', 'a'];
  for (const s of linkSelectors) {
    const link = item.querySelector(s);
    if (link && link.href && link.href.includes('/messaging/thread/') && !link.href.includes('/thread/new')) {
      return link.href;
    }
  }
  if (item.tagName === 'A' && item.href && item.href.includes('/messaging/thread/')) return item.href;
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

/* ── Click into a conversation and get the URL ── */

function getClickTarget(item) {
  const threadA = item.querySelector('a[href*="/messaging/thread/"]:not([href*="/thread/new"])');
  if (threadA) return threadA;
  const link = item.querySelector('a[href*="/messaging/"]') || item.querySelector('a');
  if (link) return link;
  return item;
}

function stripThreadUrlQuery(href) {
  if (!href) return '';
  const s = href.split('?')[0].split('#')[0];
  return s;
}

/** First /messaging/thread/ link outside the conversation list (detail pane / header). */
function readThreadUrlFromDetailPanel() {
  const listContainer = findListContainer();
  for (const a of document.querySelectorAll('a[href*="/messaging/thread/"]')) {
    const u = stripThreadUrlQuery(a.href || '');
    if (!u || u.includes('/messaging/thread/new')) continue;
    if (listContainer && listContainer.contains(a)) continue;
    return u;
  }
  return '';
}

/**
 * LinkedIn often keeps window.location on the wrong thread; row href can be missing or shared.
 * Read URL from the detail pane (outside sidebar list) until it stabilizes.
 */
async function openThreadAndGetConversationUrl(el) {
  const target = getClickTarget(el);
  const rowHrefFull = extractUrl(el) || target.href || '';
  const rowNorm = stripThreadUrlQuery(rowHrefFull);
  target.click();

  let prev = '';
  let same = 0;
  const t0 = Date.now();
  const deadline = 10000;

  while (Date.now() - t0 < deadline) {
    checkCancelled();
    await sleep(250);
    const panel = readThreadUrlFromDetailPanel();
    const loc = stripThreadUrlQuery(window.location.href);
    let u = '';
    if (panel && panel.includes('/messaging/thread/')) u = panel;
    else if (loc.includes('/messaging/thread/') && !loc.includes('/new')) u = loc;
    if (!u && rowNorm.includes('/messaging/thread/')) u = rowNorm;
    if (!u || u.includes('/new')) continue;

    if (u === prev) same++;
    else {
      prev = u;
      same = 1;
    }
    if (same >= 2 && Date.now() - t0 > 500) return u;
  }

  const lastPanel = readThreadUrlFromDetailPanel();
  if (lastPanel) return lastPanel;
  if (rowNorm.includes('/messaging/thread/')) return rowNorm;
  return stripThreadUrlQuery(window.location.href);
}

/* ── Scroll UP in thread to load older messages for context ── */

async function scrollThreadForContext() {
  const threadContainerSelectors = [
    '.msg-s-message-list-container',
    '[class*="message-list-container"]',
    '[class*="msg-thread"]',
    'main [class*="messages"]',
    'main ul',
  ];
  let threadBox = null;
  for (const s of threadContainerSelectors) {
    threadBox = document.querySelector(s);
    if (threadBox) break;
  }
  if (!threadBox) return;

  for (let i = 0; i < 5; i++) {
    threadBox.scrollTop = 0;
    await sleep(800);
  }
}

/* ── Extract messages from the open thread ── */

function extractThreadMessages() {
  const messages = [];
  const blockSelectors = [
    '.msg-s-message-list__event',
    '.msg-s-event-listitem',
    '[class*="msg-s-event"]',
    '[class*="message-list"] li',
  ];

  let blocks = [];
  for (const s of blockSelectors) {
    blocks = document.querySelectorAll(s);
    if (blocks.length > 0) break;
  }

  if (blocks.length === 0) {
    const main = document.querySelector('main, [class*="thread"], [class*="conversation"]');
    if (main) blocks = main.querySelectorAll('li, [class*="event"], div[class*="message"]');
  }

  for (const block of blocks) {
    const bodySelectors = [
      '.msg-s-event-listitem__body',
      '[class*="event-body"]',
      '[class*="message-body"]',
      'p',
    ];
    let text = '';
    for (const bs of bodySelectors) {
      const body = block.querySelector(bs);
      if (body) {
        text = body.textContent.trim();
        if (text && text.length >= 2) break;
      }
    }
    if (!text || text.length < 2) continue;

    const timeEl = block.querySelector('time');
    const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';

    const cls = (block.className || '').toLowerCase();
    const parentCls = (block.parentElement?.className || '').toLowerCase();
    const isMe = cls.includes('outbound') || parentCls.includes('outbound') ||
                 cls.includes('sent') || cls.includes('from-me');

    const senderEl = block.querySelector('[class*="sender"], [class*="actor"], [class*="name"]');
    let senderName = senderEl ? senderEl.textContent.trim() : '';

    messages.push({
      sender: isMe ? 'me' : (senderName || 'them'),
      text,
      timestamp,
      is_from_me: isMe
    });
  }

  if (messages.length === 0) {
    const main = document.querySelector('main');
    if (main) {
      const ps = main.querySelectorAll('p');
      ps.forEach(p => {
        const t = p.textContent.trim();
        if (t && t.length > 1 && t.length < 2000) {
          messages.push({ sender: 'unknown', text: t, timestamp: '', is_from_me: false });
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

async function tryApplyUnreadFilter(options = {}) {
  const required = options.required === true;
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

  if (required) {
    log('Unread filter not found (required for sync)');
  } else {
    log('Unread filter not found, proceeding with full list');
  }
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

/* ── Count unreads only (sidebar, no thread open) ── */

async function countUnreadOnly() {
  const listContainer = findListContainer();
  if (!listContainer) {
    throw new Error('Could not find conversation list');
  }

  reportProgress(0, 'Count unread: filter...');
  const filterApplied = await tryApplyUnreadFilter({ required: true });
  if (!filterApplied) {
    throw new Error(
      'Unread filter could not be applied. Open LinkedIn Messaging and ensure you can switch to the Unread view.'
    );
  }

  const allMap = new Map();

  function snapshotUnreadItems() {
    const items = findConversationItems();
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const name = extractName(item);
      const preview = extractPreview(item);
      const url = extractUrl(item);
      const timestamp = extractTimestamp(item);
      const unread = true;
      const key = url || `${name}__${timestamp}__${preview.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const row = {
        key,
        participant_name: name,
        conversation_url: url ? stripThreadUrlQuery(url) : '',
        message_preview: preview,
        timestamp,
        is_unread: unread,
        read_status: 'unread'
      };
      out.push(row);
      allMap.set(key, {
        participant_name: name,
        conversation_url: row.conversation_url,
        message_preview: preview,
        timestamp,
        is_unread: unread,
        read_status: 'unread'
      });
    }
    return out;
  }

  reportProgress(25, 'Count unread: loading list...');
  const container = findListContainer() || listContainer;
  await scrollToLoadAll(container, 5, 5);
  await verifyFullLoad(container);

  const rows = snapshotUnreadItems();
  const initial_unread_count = rows.length;
  const estimated_batches = Math.max(1, Math.ceil(initial_unread_count / 10));
  const label = `Count · ${initial_unread_count} unreads (~${estimated_batches} batches)`;
  reportProgress(100, label);
  log(`COUNT UNREAD: ${initial_unread_count} unique rows (est. ${estimated_batches} batches × 10)`);

  return {
    extracted_at: new Date().toISOString(),
    unreadFilterApplied: true,
    initial_unread_count,
    estimated_batches,
    all_conversations: Array.from(allMap.values()),
    participant_names: rows.map(r => r.participant_name),
    list_row_keys: rows.map(r => r.key),
  };
}

/* ── Main extraction ── */

async function extractRaw() {
  const listContainer = findListContainer();
  if (!listContainer) {
    throw new Error('Could not find conversation list');
  }

  reportProgress(0, 'Starting...');

  log('Phase 0: Unread filter (required for sync)...');
  const filterApplied = await tryApplyUnreadFilter({ required: true });
  if (!filterApplied) {
    throw new Error(
      'Unread filter could not be applied. Open LinkedIn Messaging and ensure you can switch to the Unread view.'
    );
  }

  const BATCH_SIZE = 10;
  const MAX_MSG_SNIPPET = 10;
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
      const url = extractUrl(item);
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

  reportProgress(8, 'Loading unread list for initial count...');
  const countContainer = findListContainer() || listContainer;
  await scrollToLoadAll(countContainer, 5, 5);
  await verifyFullLoad(countContainer);
  const initialUnreadSnapshot = snapshotUnreadItems();
  const initial_unread_count = initialUnreadSnapshot.length;
  const estimated_batches = Math.max(1, Math.ceil(initial_unread_count / BATCH_SIZE));
  maxUnreadSeen = Math.max(maxUnreadSeen, initial_unread_count);
  log(`Initial unread count: ${initial_unread_count} (~${estimated_batches} batches)`);

  while (batchLoop < MAX_BATCH_LOOPS) {
    checkCancelled();
    batchLoop++;

    const liveContainer = findListContainer() || listContainer;
    log(`Batch loop ${batchLoop}: scrolling and verifying unread list...`);
    reportProgress(
      Math.min(10 + batchLoop * 2, 50),
      `Loading unread list · batch ${batchLoop}/~${estimated_batches}`
    );
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
    reportProgress(
      Math.min(55 + batchLoop * 2, 90),
      `Processing batch ${batchLoop}/~${estimated_batches}: ${batch.length} threads`
    );

    const batchConversations = [];
    for (let i = 0; i < batch.length; i++) {
      checkCancelled();
      const c = batch[i];
      const stepLabel = `Batch ${batchLoop}/~${estimated_batches} · ${i + 1}/${batch.length}: ${c.participant_name}`;
      reportProgress(Math.min(60 + (i / Math.max(batch.length, 1)) * 25, 95), stepLabel);
      log(`  ${stepLabel}`);

      const el = c.element;
      el.scrollIntoView({ block: 'center' });
      await sleep(300);
      const tOpen = Date.now();
      const conversationUrl = await openThreadAndGetConversationUrl(el);
      const openMs = Date.now() - tOpen;
      if (openMs < 2400) await sleep(2400 - openMs);

      const allMessages = extractThreadMessages();
      const latestMessages = limitMessages(allMessages, MAX_MSG_SNIPPET);
      const latestText = latestMessages.length ? latestMessages[latestMessages.length - 1].text : '';
      const prevText = latestMessages.length > 1 ? latestMessages[latestMessages.length - 2].text : '';

      const idx = unreadWithMessages.length;
      const row = {
        index: idx,
        participant_name: c.participant_name,
        conversation_url: conversationUrl || stripThreadUrlQuery(c.conversation_url),
        message_preview: c.message_preview,
        timestamp: c.timestamp,
        is_unread: true,
        read_status: 'unread',
        latest_message: latestText || (c.message_preview || '').trim(),
        latest: {
          message_count: latestMessages.length,
          messages: latestMessages,
          latest_message: latestText,
          previous_message: prevText
        }
      };

      unreadWithMessages.push(row);
      batchConversations.push(JSON.parse(JSON.stringify(row)));
      processedUnreadKeys.add(c.key);
      log(`    → rendered=${allMessages.length}, latest kept=${latestMessages.length}`);
    }

    await sendSyncBatchFile({
      batchIndex: batchLoop,
      estimatedBatches: estimated_batches,
      initialUnreadCount: initial_unread_count,
      extracted_at: new Date().toISOString(),
      unreadFilterApplied: true,
      conversations: batchConversations,
    });
  }

  const allOutput = Array.from(allMap.values());
  let totalInInbox;
  if (SYNC_TEMP_BATCH_DOWNLOAD_NO_PERSIST) {
    // Avoid switching away from Unread or re-scrolling full inbox; total is best-effort from unread list.
    totalInInbox = maxUnreadSeen;
    log('Temp mode: skipping filter clear and full inbox count (Unread view unchanged).');
  } else {
    totalInInbox = allOutput.length;
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
    unreadFilterApplied: true,
    initial_unread_count,
    estimated_batches,
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

  const conversations = [];
  for (let i = 0; i < picked.length; i++) {
    checkCancelled();
    const el = picked[i];
    const name = extractName(el);
    const preview = extractPreview(el);
    const url = extractUrl(el);
    const timestamp = extractTimestamp(el);

    const threadPct = 10 + ((i + 1) / Math.max(picked.length, 1)) * 80;
    reportProgress(threadPct, `Test thread ${i + 1}/${picked.length}: ${name}`);

    el.scrollIntoView({ block: 'center' });
    await sleep(350);
    const tOpen = Date.now();
    const conversationUrl = await openThreadAndGetConversationUrl(el);
    const openMs = Date.now() - tOpen;
    if (openMs < 2400) await sleep(2400 - openMs);

    // Only collect latest N messages (no older-context scrolling).
    const allMessages = extractThreadMessages();
    const latestMessages = limitMessages(allMessages, limit);

    const latestText = latestMessages.length ? latestMessages[latestMessages.length - 1].text : '';
    conversations.push({
      index: i,
      participant_name: name,
      conversation_url: conversationUrl || stripThreadUrlQuery(url),
      message_preview: preview,
      timestamp,
      is_unread: true,
      read_status: 'unread',
      latest_message: latestText,
      latest: {
        message_count: latestMessages.length,
        messages: latestMessages,
        latest_message: latestText,
        previous_message: latestMessages.length > 1 ? latestMessages[latestMessages.length - 2].text : ''
      },
    });
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

  if (request.action === 'COUNT_UNREAD_ONLY') {
    cancelled = false;
    countUnreadOnly()
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
