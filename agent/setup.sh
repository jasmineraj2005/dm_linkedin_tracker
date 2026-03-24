#!/bin/bash
# Create venv and install dependencies (avoids externally-managed-environment)
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
echo "Done. Activate with: source agent/venv/bin/activate"
