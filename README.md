# LinkedIn Message Sync

Chrome extension that extracts unread LinkedIn messages.

## Install

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder

## Use

1. Go to https://www.linkedin.com/messaging/
2. Click extension icon
3. Optionally enter **your display name** in the popup (improves `is_from_me` / `sender: "me"` detection in extracted messages)
4. Click **Sync Now** or **Test latest 10**
5. Check browser console (F12) on the LinkedIn tab for extraction logs; service worker console for orchestration logs

Stored `conversation_url` values omit query strings such as `?filter=unread` so the same thread dedupes consistently across runs.

## Output

```json
[
  {
    "participant_name": "John Smith",
    "participant_profile_url": "https://linkedin.com/in/johnsmith",
    "conversation_url": "https://www.linkedin.com/messaging/thread/...",
    "previous_message": "",
    "latest_message": "Hey, are you available?",
    "timestamp": "2h"
  }
]
```

## Files

- `manifest.json` - Extension config
- `popup.html/js` - UI (saves `dmOwnerDisplayName` to `chrome.storage.local`)
- `content.js` - Message extraction
- `styles.css` - Styling
- `agent/` - Python helpers (`reason_latest10.py`, `filter_messages.py`, `composer/compose_replies.py`)
