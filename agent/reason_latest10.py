#!/usr/bin/env python3
"""
AI reasoning over LinkedIn latest-10 message extracts.

Expected input JSON:
- Either the extension test payload:
  {
    "conversations": [
      {
        "participant_name": "...",
        "conversation_url": "...",
        "latest": {
          "message_count": 10,
          "messages": [ { "sender": "...", "text": "...", "timestamp": "...", ... }, ... ],
          "latest_message": "...",
          "previous_message": "..."
        }
      },
      ...
    ]
  }

or older payloads that used `after` / `messages`.

How to run:
1) set OPENAI_API_KEY in .env
2) python reason_latest10.py /path/to/linkedin_test_context.json

Or pipe JSON via stdin:
cat file.json | python reason_latest10.py
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List

try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except Exception:
    pass

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("Set OPENAI_API_KEY in .env or environment.", file=sys.stderr)
    sys.exit(1)


def load_json_from_path(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_json_from_stdin() -> Dict[str, Any]:
    raw = sys.stdin.read()
    return json.loads(raw)


def normalize_conversation(conv: Dict[str, Any]) -> Dict[str, Any]:
    # Prefer `latest` (new extension test output).
    latest = conv.get("latest")
    if not latest:
        # Back-compat: if the payload has `after`, use it as the "latest window".
        latest = conv.get("after")

    # Back-compat: if payload stores messages directly.
    if not latest and "messages" in conv:
        latest = {"messages": conv["messages"]}

    if not latest:
        latest = {"messages": []}

    messages = latest.get("messages", []) or []
    latest_message = latest.get("latest_message") or (messages[-1].get("text") if messages else "")
    previous_message = latest.get("previous_message") or (messages[-2].get("text") if len(messages) >= 2 else "")

    return {
        "participant_name": conv.get("participant_name", "Unknown"),
        "conversation_url": conv.get("conversation_url", ""),
        "latest_message": latest_message,
        "previous_message": previous_message,
        "messages": messages,
        "message_count": len(messages),
    }


def build_prompt(item: Dict[str, Any]) -> str:
    msgs = item["messages"]

    # Keep the prompt compact: we already extracted latest-10, but messages can still be long.
    compact_msgs: List[Dict[str, str]] = []
    for m in msgs:
        text = (m.get("text") or "").strip()
        # Hard cap per-message to avoid giant prompts.
        if len(text) > 1200:
            text = text[:1200] + "..."
        compact_msgs.append({
            "sender": m.get("sender", ""),
            "timestamp": m.get("timestamp", ""),
            "text": text,
        })

    return f"""You are an expert LinkedIn conversation assistant.
From the latest 10 messages (oldest -> newest), extract the key discussion points so they can be quickly understood.

Conversation participant: {item['participant_name']}
Conversation URL: {item['conversation_url']}

Latest 10 messages (oldest -> newest):
{json.dumps(compact_msgs, ensure_ascii=False, indent=2)}

Task:
Return exactly 3 pointers that capture the key discussion topics and context needed to understand the latest message.

Output ONLY valid JSON with keys:
- participant_name
- pointers (array of exactly 3 strings, in priority order)

Rules:
- No extra keys besides `participant_name` and `pointers`
- No markdown
"""


def call_openai(items: List[Dict[str, Any]], model: str) -> List[Dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)

    results: List[Dict[str, Any]] = []
    for item in items:
        prompt = build_prompt(item)
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )

        text = resp.choices[0].message.content
        # Be forgiving: try to parse JSON directly, else extract first {...} block.
        try:
            data = json.loads(text)
        except Exception:
            start = text.find("{")
            end = text.rfind("}")
            if start != -1 and end > start:
                data = json.loads(text[start:end + 1])
            else:
                raise
        results.append(data)
    return results


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", nargs="?", default=None, help="Path to JSON file. If omitted, reads from stdin.")
    ap.add_argument("--model", default="gpt-4o-mini", help="OpenAI model")
    args = ap.parse_args()

    if args.input:
        raw = load_json_from_path(args.input)
    else:
        raw = load_json_from_stdin()

    conversations = raw.get("conversations") or raw.get("unread_with_context") or []
    normalized = [normalize_conversation(c) for c in conversations]
    if not normalized:
        print("No conversations found in input JSON.", file=sys.stderr)
        sys.exit(1)

    results = call_openai(normalized, model=args.model)
    out = {"count": len(results), "results": results}
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

