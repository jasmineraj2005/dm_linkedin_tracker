#!/usr/bin/env python3
"""
Compose personality-aligned LinkedIn replies from latest-10 message test JSON.

Input:
  - extension test JSON with top-level "conversations"
  - each conversation contains "latest.messages" (oldest -> newest)

Output:
  {
    "count": N,
    "results": [
      {
        "participant_name": "...",
        "conversation_url": "...",
        "key_discussions": ["...", "...", "..."],
        "suggested_reply": "..."
      }
    ]
  }
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
except Exception:
    pass

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("Set OPENAI_API_KEY in .env or environment.", file=sys.stderr)
    sys.exit(1)


PERSONALITY_BRIEF = """You are writing as Sara Singh Tak.

Style and personality constraints:
- Warm, high-energy, positive, and helpful.
- Professional but not corporate. Friendly startup-casual tone.
- Concise and action-oriented.
- Default to short paragraphs and clear next steps.
- Prefer direct, practical responses over long explanations.
- Use gratitude naturally where relevant.
- When event/logistics context appears, answer directly and clearly.
- If appropriate, close naturally in Sara's style (for example: "Cheers, Sara").

Do NOT:
- Sound robotic, stiff, or overly formal.
- Over-commit to things not stated in the thread.
- Invent facts not present in the messages.
"""


def load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_messages(conv: Dict[str, Any]) -> List[Dict[str, Any]]:
    latest = conv.get("latest") or conv.get("after") or {}
    msgs = (
        latest.get("messages")
        or conv.get("latest_messages")
        or conv.get("messages")
        or []
    )
    out: List[Dict[str, Any]] = []
    for m in msgs:
        text = (m.get("text") or "").strip()
        if not text:
            continue
        if len(text) > 1200:
            text = text[:1200] + "..."
        out.append(
            {
                "sender": m.get("sender", ""),
                "is_from_me": bool(m.get("is_from_me", False)),
                "timestamp": m.get("timestamp", ""),
                "text": text,
            }
        )
    return out


def build_prompt(participant_name: str, conversation_url: str, messages: List[Dict[str, Any]]) -> str:
    return f"""{PERSONALITY_BRIEF}

Note: `sender` / `is_from_me` in the export may be unlabeled or unreliable. Infer Sara vs the other person from
context (e.g. "Hey [name]", "Cheers, Sara", first-person framing). `participant_name` is always the other person.

Conversation participant: {participant_name}
Conversation URL: {conversation_url}
Latest messages (oldest -> newest):
{json.dumps(messages, ensure_ascii=False, indent=2)}

Task:
1) Extract exactly 3 key discussion points from the thread.
2) Write one suggested reply in Sara's voice.

Output ONLY valid JSON with keys:
- participant_name
- key_discussions (array of exactly 3 strings)
- suggested_reply (string)
"""


def call_openai(items: List[Dict[str, Any]], model: str) -> List[Dict[str, Any]]:
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)
    results: List[Dict[str, Any]] = []

    for item in items:
        prompt = build_prompt(item["participant_name"], item["conversation_url"], item["messages"])
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.45,
        )
        text = resp.choices[0].message.content

        try:
            parsed = json.loads(text)
        except Exception:
            start = text.find("{")
            end = text.rfind("}")
            if start == -1 or end <= start:
                raise RuntimeError(f"Non-JSON response for {item['participant_name']}")
            parsed = json.loads(text[start : end + 1])

        # Guardrails on shape
        # Always trust the source payload for participant identity.
        parsed["participant_name"] = item["participant_name"]
        k = parsed.get("key_discussions")
        if not isinstance(k, list):
            k = [str(parsed.get("summary", "")).strip()] if parsed.get("summary") else []
        k = [str(x).strip() for x in k if str(x).strip()]
        while len(k) < 3:
            k.append("No additional key point extracted from the latest window.")
        parsed["key_discussions"] = k[:3]
        parsed["suggested_reply"] = str(parsed.get("suggested_reply", "")).strip()

        results.append(
            {
                "participant_name": parsed["participant_name"],
                "conversation_url": item["conversation_url"],
                "key_discussions": parsed["key_discussions"],
                "suggested_reply": parsed["suggested_reply"],
            }
        )

    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Path to linkedin_test_latest10 JSON")
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--output", default="")
    args = parser.parse_args()

    raw = load_json(args.input)
    convs = raw.get("conversations") or raw.get("unread_with_context") or []
    if not convs:
        print("No conversations found in input.", file=sys.stderr)
        sys.exit(1)

    items: List[Dict[str, Any]] = []
    for conv in convs:
        participant = conv.get("participant_name", "Unknown")
        url = conv.get("conversation_url", "")
        messages = normalize_messages(conv)
        if not messages:
            continue
        items.append(
            {
                "participant_name": participant,
                "conversation_url": url,
                "messages": messages,
            }
        )

    if not items:
        print("No message windows found in input.", file=sys.stderr)
        sys.exit(1)

    results = call_openai(items, args.model)
    output = {"count": len(results), "results": results}

    out_json = json.dumps(output, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_json)
    else:
        print(out_json)


if __name__ == "__main__":
    main()

