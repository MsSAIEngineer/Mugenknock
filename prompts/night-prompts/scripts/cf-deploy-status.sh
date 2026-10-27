#!/bin/bash
# Cloudflare Pages デプロイ状況確認スクリプト
#
# 使い方:
#   ./prompts/night-prompts/scripts/cf-deploy-status.sh          # 直近5件を表示
#   ./prompts/night-prompts/scripts/cf-deploy-status.sh prod     # 本番（master）のみ
#   ./prompts/night-prompts/scripts/cf-deploy-status.sh staging  # 検証（develop）のみ
#   ./prompts/night-prompts/scripts/cf-deploy-status.sh wait     # 最新ビルドが完了するまで待機して結果表示

CF_TOKEN="${CLOUDFLARE_API_TOKEN:-$(grep 'CLOUDFLARE_API_TOKEN' ~/.bashrc | head -1 | sed 's/.*="\(.*\)"/\1/')}"
CF_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-$(grep 'CLOUDFLARE_ACCOUNT_ID' ~/.bashrc | head -1 | sed 's/.*="\(.*\)"/\1/')}"
PROJECT="mugenknock"
FILTER="${1:-}"

if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCOUNT" ]; then
  echo "❌ CLOUDFLARE_API_TOKEN または CLOUDFLARE_ACCOUNT_ID が未設定です"
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${PROJECT}/deployments"

fetch_deployments() {
  curl -s "$API" -H "Authorization: Bearer ${CF_TOKEN}"
}

print_deployments() {
  local resp="$1"
  local filter="$2"
  echo "$resp" | python3 -c "
import json, sys
from datetime import datetime, timezone

data = json.load(sys.stdin)
filter_env = '$filter'

if not data.get('success'):
    print('❌ APIエラー:', data.get('errors'))
    sys.exit(1)

STATUS_ICON = {'skipped':'⏭ ','success':'✅','failure':'❌','canceled':'⚠️','active':'🔄','idle':'💤','queued':'⏳'}

print('📋 Cloudflare Pages — $PROJECT デプロイ状況')
print('=' * 60)

shown = 0
for d in data.get('result', []):
    env  = d.get('environment', '')
    meta = d.get('deployment_trigger', {}).get('metadata', {})
    branch = meta.get('branch', '')

    if filter_env == 'prod'    and env != 'production': continue
    if filter_env == 'staging' and env != 'preview':    continue
    if filter_env == 'wait':
        pass  # wait モードでは全件確認

    status = 'skipped' if d.get('is_skipped') else d.get('latest_stage', {}).get('status', '')
    icon   = STATUS_ICON.get(status, '❓')
    env_label = '本番' if env == 'production' else '検証'

    try:
        dt = datetime.fromisoformat(d.get('created_on','').replace('Z','+00:00'))
        time_str = dt.strftime('%m/%d %H:%M')
    except:
        time_str = d.get('created_on','')[:16]

    commit  = meta.get('commit_hash','')[:7]
    msg     = meta.get('commit_message','')
    msg     = (msg[:52] + '...') if len(msg) > 52 else msg
    url     = d.get('url','')

    print(f'{icon} [{env_label}] {time_str}  branch:{branch}  #{commit}')
    print(f'   {url}')
    if msg: print(f'   {msg}')
    print()

    shown += 1
    if shown >= 5 and filter_env not in ('prod', 'staging', 'wait'): break

if shown == 0:
    print('該当するデプロイがありません')
"
}

get_latest_status() {
  local resp="$1"
  echo "$resp" | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result', [])
if result:
    d = result[0]
    status = d.get('latest_stage', {}).get('status', '')
    print(status)
"
}

# 指定コミットのデプロイ状態を返す。まだ登録されていなければ 'notfound'。
# wait で「最新デプロイ」を見てしまうと、push直後はまだ前回のビルドが最新なので
# 「すでに success」と誤判定して即座に返る（2026-09-30 に実際に踏んだ）。
get_status_for_commit() {
  local resp="$1"
  local sha="$2"
  echo "$resp" | SHA="$sha" python3 -c "
import json, os, sys
sha = os.environ['SHA']
data = json.load(sys.stdin)
for d in data.get('result', []):
    meta = d.get('deployment_trigger', {}).get('metadata', {}) or {}
    ch = meta.get('commit_hash', '') or ''
    if not ch:
        continue
    # 片方が短縮SHAでも一致させる（APIはフルSHA・引数は7桁のことが多い）
    n = min(len(ch), len(sha))
    if n >= 7 and ch[:n] == sha[:n]:
        # Build watch paths（docs や運用スクリプトだけの変更）で飛ばされたコミットは is_skipped が立つ
        print('skipped' if d.get('is_skipped') else (d.get('latest_stage', {}).get('status', '') or 'unknown'))
        break
else:
    print('notfound')
"
}

# ── wait モード: 最新ビルドが完了するまでポーリング ──
if [ "$FILTER" = "wait" ]; then
  # 待つ対象のコミットを決める。引数で明示できる（既定はローカルの HEAD）。
  # 「最新デプロイ」ではなく「このコミットのデプロイ」を待つのが要点。
  TARGET_SHA="${2:-$(git rev-parse --short=7 HEAD 2>/dev/null)}"
  if [ -z "$TARGET_SHA" ]; then
    echo "❌ 待機対象のコミットを特定できません（git 管理外なら第2引数でSHAを指定）"
    exit 1
  fi
  # ビルドは実測 1.5〜2分（静的ページ25件）。その約5倍の10分まで待つ。
  MAX=${CF_WAIT_MAX:-40}   # 最大10分（15秒×40回）
  INTERVAL=${CF_WAIT_INTERVAL:-15}
  COUNT=0
  SEEN=0
  echo "⏳ #${TARGET_SHA} のビルド完了を待機中（最大 $((MAX * INTERVAL / 60))分）..."
  while [ $COUNT -lt $MAX ]; do
    RESP=$(fetch_deployments)
    STATUS=$(get_status_for_commit "$RESP" "$TARGET_SHA")
    case "$STATUS" in
      success|failure|canceled)
        echo ""
        print_deployments "$RESP" ""
        if [ "$STATUS" = "success" ]; then
          echo "✅ ビルド成功（#${TARGET_SHA}）"
          exit 0
        else
          echo "❌ ビルド失敗（#${TARGET_SHA} status: $STATUS）"
          exit 1
        fi
        ;;
      skipped)
        echo ""
        echo "⏭  ビルド対象外（#${TARGET_SHA}）: Build watch paths で除外したファイルだけの変更なので、Cloudflare はビルドしない"
        exit 0
        ;;
      notfound)
        # push 直後はまだ Cloudflare 側に登録されていない。登録を待つ。
        printf "_"
        sleep "$INTERVAL"
        COUNT=$((COUNT + 1))
        ;;
      active|queued|idle)
        SEEN=1
        printf "."
        sleep "$INTERVAL"
        COUNT=$((COUNT + 1))
        ;;
      *)
        echo ""
        echo "⚠️  不明なステータス: $STATUS（#${TARGET_SHA}）"
        print_deployments "$RESP" ""
        exit 1
        ;;
    esac
  done
  echo ""
  if [ $SEEN -eq 0 ]; then
    echo "⏰ タイムアウト: #${TARGET_SHA} のデプロイが登録されませんでした"
    echo "   push できているか・Cloudflare の連携が生きているか確認してください"
  else
    echo "⏰ タイムアウト: #${TARGET_SHA} のビルドが $((MAX * INTERVAL / 60))分で終わりませんでした"
  fi
  print_deployments "$(fetch_deployments)" ""
  exit 1
fi

# ── 通常表示 ──
print_deployments "$(fetch_deployments)" "$FILTER"
