# LinkedIn message filter (OpenAI)

Filters raw LinkedIn export JSON: drops "You:" (your messages), promotional and spam; keeps incoming cold DMs and meaningful messages.

## Setup (use a virtual environment)

From the project root:

```bash
cd agent
python3 -m venv venv
source venv/bin/activate   # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Or run the setup script:

```bash
cd agent && bash setup.sh
```

Set `OPENAI_API_KEY` in `.env` in the project root (or in `agent/`) or in your environment.

## Run on a file

Activate the venv first, then:

```bash
source venv/bin/activate
python filter_messages.py
# uses ~/Downloads/linkedin_raw_2026-03-15.json by default

python filter_messages.py /path/to/linkedin_raw_YYYY-MM-DD.json

# All messages only (no AI): every conversation with read_status "unread" or "read"
python filter_messages.py /path/to/linkedin_raw_YYYY-MM-DD.json --all-messages

# Full filtered list (AI), not just unread
python filter_messages.py /path/to/file.json --all
```

Prints the filtered list and writes `linkedin_raw_YYYY-MM-DD_filtered.json`.

## Extension

In the extension popup, use **Filter with AI** after a raw sync. It uses the same logic and shows the filtered list; **Download filtered list** saves it as JSON.
