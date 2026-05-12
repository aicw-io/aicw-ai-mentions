#!/bin/bash

# Build the open-source static demo report.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBJECT="${AICW_DEMO_SUBJECT:-Y Combinator}"
OUTPUT_DIR="${AICW_DEMO_OUTPUT_DIR:-${AICW_DEMO_DOCS_DIR:-$ROOT_DIR/.demo-data/report}}"
DATA_DIR="${AICW_DEMO_DATA_DIR:-$ROOT_DIR/.demo-data/data}"

if [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = "/" ]; then
  echo "Refusing to write to OUTPUT_DIR=$OUTPUT_DIR" >&2
  exit 1
fi

if [ -z "$DATA_DIR" ] || [ "$DATA_DIR" = "/" ]; then
  echo "Refusing to write to DATA_DIR=$DATA_DIR" >&2
  exit 1
fi

if [ "$DATA_DIR" = "$OUTPUT_DIR" ]; then
  echo "DATA_DIR must be a subfolder or separate working folder, not OUTPUT_DIR" >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Building aicw-ai-mentions..."
npm run build

mkdir -p "$DATA_DIR"

echo "Running demo scan for: $SUBJECT"
env \
  AICW_DATA_FOLDER="$DATA_DIR" \
  AICW_SKIP_UPDATE_CHECK=true \
  node "$ROOT_DIR/bin/aicw-ai-mentions.js" scan "$SUBJECT"

REPORT_DIR="$DATA_DIR/reports/$SUBJECT"
if [ ! -f "$REPORT_DIR/index.html" ]; then
  REPORT_INDEX=""
  while IFS= read -r candidate; do
    REPORT_INDEX="$candidate"
  done < <(find "$DATA_DIR/reports" -mindepth 2 -maxdepth 2 -name index.html -print | sort)

  if [ -n "$REPORT_INDEX" ]; then
    REPORT_DIR="$(dirname "$REPORT_INDEX")"
  fi
fi

if [ ! -f "$REPORT_DIR/index.html" ]; then
  echo "Could not find generated report under $DATA_DIR/reports" >&2
  exit 1
fi

echo "Publishing report to: $OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd -P)"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd -P)"

if [ "$REPORT_DIR" != "$OUTPUT_DIR" ]; then
  if [ "${AICW_DEMO_KEEP_DATA:-false}" != "true" ]; then
    echo "Resetting demo output folder: $OUTPUT_DIR"
    find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  fi
  cp -R "$REPORT_DIR"/. "$OUTPUT_DIR"/
fi
rm -rf "$DATA_DIR/logs" "$DATA_DIR/cache"
touch "$OUTPUT_DIR/.nojekyll"

echo "Demo report ready:"
echo "  $OUTPUT_DIR/index.html"
echo "  Demo data is stored in $DATA_DIR"
