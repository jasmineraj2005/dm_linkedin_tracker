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

    messages = latest.get("messages") or conv.get("latest_messages") or []
    if not messages and "messages" in conv:
        messages = conv["messages"] or []
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


THREE_POINTER_TASK = """You are reviewing a LinkedIn DM conversation. Based on the latest messages below,
provide exactly 3 bullet points (as the `pointers` array), in this order:
1. What they want or why they reached out
2. Where the conversation currently stands
3. Suggested next reply (one sentence, in the inbox owner's voice — warm, concise, actionable)

Keep each string under 15 words. Be direct.

Direction: `sender` / `is_from_me` from the export may be wrong or unlabeled. Infer who is the inbox owner
(Sara) vs the other person from the message text — e.g. openings like "Hey [name]", closings like "Cheers, Sara",
first-person voice. Treat `participant_name` as always the other person (not Sara)."""

NARRATIVE_THREE_POINTER_TASK = """You are summarizing a LinkedIn DM thread for an inbox triage view.
Produce exactly 3 strings in `pointers` (same JSON shape as usual), each one a factual narrative sentence
(like short case notes — who did what, what changed, where it landed). Use the other person's first name
from `participant_name` where natural; refer to the inbox owner as Sara when needed.

Order:
1. How they opened / what they wanted or offered
2. What Sara did or how the thread moved (if visible in messages)
3. Current state or latest turn (who said what last, any open ask)

Do not add a "suggested reply". Each sentence may be up to 40 words. Be concrete; no bullet prefixes inside strings."""


def build_prompt(item: Dict[str, Any], *, narrative: bool = False) -> str:
    msgs = item["messages"]

    # Keep the prompt compact: we already extracted latest-10, but messages can still be long.
    compact_msgs: List[Dict[str, Any]] = []
    for m in msgs:
        text = (m.get("text") or "").strip()
        # Hard cap per-message to avoid giant prompts.
        if len(text) > 1200:
            text = text[:1200] + "..."
        compact_msgs.append({
            "sender": m.get("sender", ""),
            "is_from_me": bool(m.get("is_from_me", False)),
            "timestamp": m.get("timestamp", ""),
            "text": text,
        })

    task = NARRATIVE_THREE_POINTER_TASK if narrative else THREE_POINTER_TASK
    tail = (
        "matching the three narrative roles above (opening / movement / latest state)."
        if narrative
        else "matching the three bullets above"
    )
    return f"""{task}

Conversation with: {item['participant_name']}
Conversation URL: {item['conversation_url']}

Messages (oldest -> newest):
{json.dumps(compact_msgs, ensure_ascii=False, indent=2)}

Output ONLY valid JSON with keys:
- participant_name (string) — must exactly match "Conversation with:" above (full name from export)
- pointers (array of exactly 3 strings {tail})

Rules:
- No extra keys besides participant_name and pointers
- No markdown
- Use your inferred direction (above), not `is_from_me` alone, when reasoning about who spoke last.
"""


def call_openai(
    items: List[Dict[str, Any]], model: str, *, narrative: bool = False
) -> List[Dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)

    results: List[Dict[str, Any]] = []
    for item in items:
        prompt = build_prompt(item, narrative=narrative)
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
    ap.add_argument(
        "--narrative",
        action="store_true",
        help="Factual timeline-style pointers (not triage + suggested reply).",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        metavar="N",
        help="Process only the first N conversations (after normalize). 0 = all.",
    )
    args = ap.parse_args()

    if args.input:
        raw = load_json_from_path(args.input)
    else:
        raw = load_json_from_stdin()

    conversations = raw.get("conversations") or raw.get("unread_with_context") or []
    normalized = [normalize_conversation(c) for c in conversations]
    if args.limit and args.limit > 0:
        normalized = normalized[: args.limit]
    if not normalized:
        print("No conversations found in input JSON.", file=sys.stderr)
        sys.exit(1)

    results = call_openai(normalized, model=args.model, narrative=args.narrative)
    out = {"count": len(results), "results": results}
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

