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
3. Click **Sync Now**
4. Check browser console (F12) for extracted data

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
- `popup.html/js` - UI
- `content.js` - Message extraction
- `styles.css` - Styling
