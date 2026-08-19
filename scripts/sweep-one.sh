#!/bin/bash
# Run one Fitness Report sweep entry and append to the spend ledger.
# Usage: scripts/sweep-one.sh <slug> <url>
# The API key is fetched from 1Password at runtime and never written to disk.
set -u
SLUG="$1"; URL="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -a; source ~/.config/op/service-account.env; set +a
export ANTHROPIC_API_KEY="$(op item get 'FOIL Anthropic API key' --vault Civqo --fields credential --reveal 2>/dev/null)"
if [ -z "$ANTHROPIC_API_KEY" ]; then echo "LEDGER {\"slug\":\"$SLUG\",\"error\":\"no-key\"}"; exit 1; fi
timeout 1500 npx tsx src/cli.ts run "$URL" --max-tasks 12 --out "runs/sweep/$SLUG" 2>&1 | grep -v "sk-"
EC=$?
unset ANTHROPIC_API_KEY
python3 - "$SLUG" "$EC" <<'EOF'
import json, sys, os
slug, ec = sys.argv[1], int(sys.argv[2])
OPUS_EST = 0.15  # synthesis allowance per run (opus-5, not recorded in agent plane)
entry = {"slug": slug, "exit": ec, "outcome": None, "sonnetUsd": None, "estUsd": None,
         "firstTry": None, "tasks": None, "refusedAt": None}
path = f"runs/sweep/{slug}/report.json"
if os.path.exists(path):
    r = json.load(open(path))
    entry["outcome"] = r.get("outcome")
    entry["refusedAt"] = (r.get("gates") or {}).get("refusedAt")
    ts = r.get("trace_stats") or {}
    models = (ts.get("models") or {}) if isinstance(ts.get("models"), dict) else {}
    per = models.get("perModel") or []
    sonnet = sum(m.get("estCostUsd") or 0 for m in per)
    entry["sonnetUsd"] = round(sonnet, 4)
    entry["estUsd"] = round(sonnet + OPUS_EST, 4)
    sc = r.get("score")
    if sc:
        ft = sc.get("firstTrySuccess") or {}
        entry["firstTry"] = f"{ft.get('k')}/{ft.get('n')}"
        entry["tasks"] = len(sc.get("tasks") or [])
else:
    entry["estUsd"] = OPUS_EST  # assume at least the synthesis attempt
ledger_path = "runs/sweep/ledger.json"
ledger = json.load(open(ledger_path)) if os.path.exists(ledger_path) else []
ledger = [e for e in ledger if e.get("slug") != slug] + [entry]
os.makedirs("runs/sweep", exist_ok=True)
json.dump(ledger, open(ledger_path, "w"), indent=1)
cum = sum(e.get("estUsd") or 0 for e in ledger)
print("LEDGER " + json.dumps({**entry, "cumUsd": round(cum, 4)}))
EOF
