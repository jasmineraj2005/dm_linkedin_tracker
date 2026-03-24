#!/usr/bin/env python3
"""
OpenAI-powered filter for LinkedIn raw export.
- Drops conversations where the latest message is from YOU (user).
- Flags and filters out promotional / spam.
- Outputs a list of incoming messages (cold DMs / messages from others).
"""

import os
import json
import sys
from pathlib import Path

# Load .env from agent/ or project root
try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("Set OPENAI_API_KEY in .env or environment.")
    sys.exit(1)


def load_raw(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def is_from_you(preview: str) -> bool:
    if not preview:
        return False
    p = (preview or "").strip().lower()
    return p.startswith("you:") or p.startswith("you sent")


def call_openai(raw_data: dict) -> list:
    import openai
    client = openai.OpenAI(api_key=OPENAI_API_KEY)

    # Build a compact input: only what we need for filtering
    conversations = raw_data.get("all_conversations", []) or []
    # Also include unread_with_context so we have latest_message
    unread = {c["participant_name"]: c for c in raw_data.get("unread_with_context", [])}

    items = []
    for c in conversations:
        name = c.get("participant_name", "")
        preview = (c.get("message_preview") or "").strip()
        ts = c.get("timestamp", "")
        unread_entry = unread.get(name, {})
        latest = (unread_entry.get("latest_message") or preview or "").strip()
        items.append({
            "participant_name": name,
            "message_preview": preview,
            "latest_message": latest,
            "timestamp": ts,
            "is_unread": c.get("is_unread", False),
        })

    prompt = """You are filtering LinkedIn message exports. Your job is to return ONLY conversations that are:
1. INCOMING to the user (messages FROM the other person, not from "You").
2. NOT promotional or spam (no sales pitches, generic outreach, "connect with me", survey links, etc.).
3. Worth following up: cold DMs, genuine requests, feedback asks, or meaningful replies from others.

Rules:
- If the latest/preview message starts with "You:" or "You sent", EXCLUDE the conversation (user sent it).
- Exclude obvious spam: "insert meaningful message", pure links, "Thanks for connecting" with nothing else, marketing blurb.
- Exclude sponsored or automated-looking content.
- INCLUDE: cold DMs where someone is reaching out, asking for feedback, coffee chat, collaboration, or replying meaningfully.

Input (JSON array of conversations):
"""
    prompt += json.dumps(items, indent=2)
    prompt += """

Return a JSON array of the conversations to KEEP. Each object must have: participant_name, latest_message (or message_preview), timestamp, is_unread (boolean, copy from input), read_status ("unread" or "read", from is_unread), and a short reason (one line) why it was kept. No other text, no markdown, just the JSON array."""

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=4096,
    )
    text = response.choices[0].message.content
    # Strip markdown if present
    start = text.find("[")
    end = text.rfind("]") + 1
    if start != -1 and end > start:
        text = text[start:end]
    return json.loads(text)


def unread_only(filtered: list) -> list:
    """Keep only conversations where is_unread is True."""
    return [m for m in filtered if m.get("is_unread") is True]


def extract_all_with_read_status(raw_data: dict) -> list:
    """Return all conversations with explicit read_status (no AI filter)."""
    conversations = raw_data.get("all_conversations", []) or []
    unread_ctx = {c["participant_name"]: c for c in raw_data.get("unread_with_context", [])}
    out = []
    for c in conversations:
        u = unread_ctx.get(c.get("participant_name"), {})
        is_unread = c.get("is_unread", False)
        out.append({
            "participant_name": c.get("participant_name", ""),
            "conversation_url": c.get("conversation_url", ""),
            "message_preview": c.get("message_preview", ""),
            "latest_message": u.get("latest_message") or c.get("message_preview", ""),
            "timestamp": c.get("timestamp", ""),
            "is_unread": is_unread,
            "read_status": "unread" if is_unread else "read",
        })
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    unread_only_flag = "--unread-only" in sys.argv or "--unread" in sys.argv
    all_messages_mode = "--all-messages" in sys.argv or "--all" in sys.argv

    if not args:
        default = Path.home() / "Downloads" / "linkedin_raw_2026-03-15.json"
        path = str(default)
        print(f"Using default path: {path}")
    else:
        path = args[0]

    if not os.path.isfile(path):
        print(f"File not found: {path}")
        sys.exit(1)

    raw = load_raw(path)
    if all_messages_mode:
        print("Extracting all messages with read_status (no AI filter)...")
        filtered = extract_all_with_read_status(raw)
        print(f"\nAll messages: {len(filtered)} total\n")
    else:
        print("Calling OpenAI to filter messages...")
        filtered = call_openai(raw)

    # By default output ONLY unread (when using AI filter); use --all to get full filtered list
    if not all_messages_mode and (unread_only_flag or "--all" not in sys.argv):
        filtered = unread_only(filtered)
        print(f"\nUnread only: {len(filtered)} messages\n")
    else:
        print(f"\nFiltered to {len(filtered)} incoming messages:\n")

    for i, m in enumerate(filtered, 1):
        unread_label = " [unread]" if m.get("is_unread") else ""
        print(f"{i}. {m.get('participant_name', '')}{unread_label} ({m.get('timestamp', '')})")
        print(f"   {(m.get('latest_message') or m.get('message_preview') or '')[:100]}...")
    print("\n--- Full JSON ---")
    print(json.dumps(filtered, indent=2))

    for m in filtered:
        m["read_status"] = m.get("read_status") or ("unread" if m.get("is_unread") else "read")

    suffix = "_all_messages.json" if all_messages_mode else "_filtered.json"
    out_path = path.replace(".json", "") + suffix
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"filtered_messages": filtered, "count": len(filtered)}, f, indent=2)
    print(f"\nSaved to {out_path}")


if __name__ == "__main__":
    main()
