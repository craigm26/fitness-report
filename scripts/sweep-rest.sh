#!/bin/bash
# Re-run the remaining roster under generator v2/v3, stopping BEFORE the
# ledger floor crosses the ceiling. The ledger is a floor, not a total (older
# rows carry a fallback judge figure), so the guard is deliberately
# conservative: it stops when the floor plus one worst-case run would cross.
set -u
cd "$(dirname "$0")/.."
CEILING="${CEILING:-17.00}"
WORST_CASE_RUN=1.60

# Highest leaderboard value first: the broken-server finding, then the
# well-known surfaces, then the thin ones that refuse cheaply.
SERVERS=(
  "aws-knowledge-v3 https://knowledge-mcp.global.api.aws/mcp"
  "context7-v3 https://mcp.context7.com/mcp"
  "microsoft-learn-v3 https://learn.microsoft.com/api/mcp"
  "deepwiki-v3 https://mcp.deepwiki.com/mcp"
  "better-auth-v3 https://mcp.better-auth.com/mcp"
  "huggingface-v3 https://huggingface.co/mcp"
  "convex-v3 https://mcp.convex.dev/mcp"
  "cloudflare-docs-v3 https://docs.mcp.cloudflare.com/mcp"
  "astro-v3 https://mcp.docs.astro.build/mcp"
  "exa-v3 https://mcp.exa.ai/mcp"
  "vercel-docs-v3 https://mcp.vercel.com/docs/mcp"
)

floor() {
  python3 -c "
import json
try:
    print(sum(e.get('estUsd') or 0 for e in json.load(open('runs/sweep/ledger.json'))))
except Exception:
    print(0)"
}

for entry in "${SERVERS[@]}"; do
  set -- $entry
  SLUG="$1"; URL="$2"
  SPENT=$(floor)
  ROOM=$(python3 -c "print(1 if $SPENT + $WORST_CASE_RUN <= $CEILING else 0)")
  if [ "$ROOM" != "1" ]; then
    echo "BUDGET STOP before $SLUG: ledger floor \$$SPENT plus a worst case run would cross \$$CEILING"
    echo "REMAINING: $SLUG $URL"
    for rest in "${SERVERS[@]}"; do
      set -- $rest
      [ -d "runs/sweep/$1" ] || echo "  not run: $1"
    done
    exit 0
  fi
  echo "### $SLUG (ledger floor before: \$$SPENT)"
  bash scripts/sweep-one.sh "$SLUG" "$URL" 2>&1 | grep -E "LEDGER|suite |null |construct|extension|outcome " | tail -8
done
echo "ROSTER COMPLETE: ledger floor \$$(floor)"
