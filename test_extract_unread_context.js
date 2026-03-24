/**
 * Test script: extract first 5 conversations after Unread filter
 * and verify "past message" context by extracting messages
 * before and after scrolling to the top of the thread pane.
 *
 * How to use:
 * 1) Open https://www.linkedin.com/messaging/ in Chrome
 * 2) Open DevTools -> Console
 * 3) Paste this file contents and run `runTest()`
 *
 * Output:
 * - Logs per-conversation message counts: before vs after context scroll
 * - Logs a short sample of earliest/most-recent message texts
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
    'aside ul',
  ];
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  return null;
}

function findConversationItems() {
  let items = document.querySelectorAll('.msg-conversation-listitem');
  if (items.length > 0) return [...items];

  items = document.querySelectorAll('li.msg-conversation-card');
  if (items.length > 0) return [...items];

  const container = findListContainer();
  if (container) {
    const lis = container.querySelectorAll('li');
    if (lis.length > 0) return [...lis];
  }

  const links = document.querySelectorAll('a[href*="/messaging/"]');
  const set = new Set();
  links.forEach(link => set.add(link.closest('li') || link));
  return [...set].filter(Boolean);
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

function getClickTarget(item) {
  const link = item.querySelector && (item.querySelector('a[href*="/messaging/"]') || item.querySelector('a'));
  return link || item;
}

function extractThreadMessages() {
  const messageBlocksSelectors = [
    '.msg-s-message-list__event',
    '.msg-s-event-listitem',
    '[class*="msg-s-event"]',
    '[class*="message-list"] li',
  ];

  let blocks = [];
  for (const s of messageBlocksSelectors) {
    const found = document.querySelectorAll(s);
    if (found && found.length) {
      blocks = [...found];
      break;
    }
  }

  if (blocks.length === 0) {
    const main = document.querySelector('main');
    if (main) blocks = [...main.querySelectorAll('li, div, p')].slice(0, 200);
  }

  const bodySelectors = [
    '.msg-s-event-listitem__body',
    '[class*="event-body"]',
    '[class*="message-body"]',
    'p',
  ];

  const out = [];
  for (const block of blocks) {
    let text = '';
    for (const bs of bodySelectors) {
      const body = block.querySelector ? block.querySelector(bs) : null;
      if (body) {
        text = (body.textContent || '').trim();
        if (text && text.length >= 2) break;
      }
    }
    if (!text || text.length < 2) continue;

    const timeEl = block.querySelector ? block.querySelector('time') : null;
    const timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';

    const cls = (block.className || '').toLowerCase();
    const parentCls = (block.parentElement && block.parentElement.className ? block.parentElement.className : '').toLowerCase();
    const isMe = cls.includes('outbound') || parentCls.includes('outbound') || cls.includes('sent');

    out.push({
      sender: isMe ? 'me' : 'them',
      text,
      timestamp,
      is_from_me: isMe,
    });
  }

  return out;
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

  // Repeatedly set scrollTop to 0 to trigger lazy loading older messages.
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

async function runTest() {
  log('Starting test...');

  const filterApplied = await tryApplyUnreadFilter();
  await sleep(1200);

  const allItems = findConversationItems();
  if (!allItems.length) {
    log('No conversation items found in the list.');
    return;
  }

  const first5 = allItems.slice(0, 5);
  log(`Found ${allItems.length} items; opening first 5... (unread filter applied: ${filterApplied})`);

  const results = [];
  for (let i = 0; i < first5.length; i++) {
    const item = first5[i];
    log(`Opening conversation ${i + 1}/5...`);

    const clickTarget = getClickTarget(item);
    clickTarget.scrollIntoView({ block: 'center' });
    await sleep(400);
    clickTarget.click();

    // Wait for thread to load
    await sleep(2200);

    const urlBefore = window.location.href;
    const beforeMessages = extractThreadMessages();
    const beforeSummary = summarizeMessages(beforeMessages);

    await scrollThreadToTop();
    await sleep(1500);

    const afterMessages = extractThreadMessages();
    const afterSummary = summarizeMessages(afterMessages);

    results.push({
      index: i,
      urlBefore,
      before: beforeSummary,
      after: afterSummary,
      expanded: afterMessages.length > beforeMessages.length,
    });

    log(
      `Conversation ${i + 1}: before ${beforeSummary.count} msgs, after ${afterSummary.count} msgs, expanded=${afterMessages.length > beforeMessages.length}`
    );
  }

  log('Test complete. Results:');
  console.log(JSON.stringify(results, null, 2));
  return results;
}

// Expose to console
window.runTest = runTest;

