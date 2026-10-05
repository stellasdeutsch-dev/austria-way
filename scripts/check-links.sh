#!/usr/bin/env bash
# Открывает каждую ссылку из контента сайта и печатает код ответа.
# Если все 200 — обновите CONTENT_META.linksCheckedAt в js/content.js на
# дату, которую скрипт печатает в конце. Запускать из корня сайта.
set -uo pipefail
cd "$(dirname "$0")/.."
bad=0; n=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  n=$((n+1))
  c=$(curl -sL -o /dev/null -w '%{http_code}' -m 25 -A 'Mozilla/5.0' "$u")
  [ "$c" = "200" ] || bad=$((bad+1))
  printf '  %s  %s\n' "$c" "$u"
done < <(grep -ohE "https?://[a-zA-Z0-9./_?=&%-]+" js/content.js js/plan.js | sed 's/[.,)]*$//' | sort -u)
echo "ссылок: $n, не отвечают: $bad"
[ "$bad" -eq 0 ] && echo "можно ставить linksCheckedAt: '$(date +%F)'"
exit "$bad"
