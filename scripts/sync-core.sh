#!/usr/bin/env bash
# Общее ядро планировщика живёт здесь, в austria-way, и копируется в
# сайты-сёстры. Сборки нет (GitHub Pages отдаёт файлы как есть), поэтому
# ядро — это просто одинаковые файлы, а этот скрипт следит, чтобы они
# оставались одинаковыми. До него исправления попадали в один сайт и
# месяцами не доезжали до другого.
#
#   scripts/sync-core.sh            скопировать ядро во все сайты
#   scripts/sync-core.sh --check    только сравнить; код 1, если разошлись
#
# Своё у каждого сайта: js/site.js (идентичность), js/plan.js (шаги и
# фазы), js/content.js (тексты), js/app.js (анкета), index.html и
# tests/fixtures.mjs (какие анкеты перебирать в тестах).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGETS=("${SYNC_TARGETS:-$HERE/../ai-roadmap}")

CORE=(
  js/utils.js js/store.js js/assistant.js js/timeline.js js/stepview.js
  js/exporter.js js/calendar.js js/pdf.js
  css/app.css
  fonts/inter-cyrillic.woff2 fonts/inter-latin.woff2 fonts/inter-latin-ext.woff2
  fonts/pdf-regular.ttf fonts/pdf-semibold.ttf
  tests/core.test.mjs package.json scripts/sync-core.sh
)

mode="${1:-sync}"
drift=0
for target in "${TARGETS[@]}"; do
  [ -d "$target" ] || { echo "нет каталога: $target" >&2; exit 2; }
  for f in "${CORE[@]}"; do
    if [ "$mode" = "--check" ]; then
      if ! cmp -s "$HERE/$f" "$target/$f"; then
        echo "РАЗОШЛОСЬ: $f  ($(basename "$target"))"
        drift=1
      fi
    else
      mkdir -p "$target/$(dirname "$f")"
      cp "$HERE/$f" "$target/$f"
    fi
  done
done

if [ "$mode" = "--check" ]; then
  [ "$drift" -eq 0 ] && echo "ядро совпадает: ${#CORE[@]} файлов × ${#TARGETS[@]} сайт(ов)"
  exit "$drift"
fi
echo "скопировано: ${#CORE[@]} файлов → ${TARGETS[*]}"
