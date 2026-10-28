#!/bin/bash
# Lambda デプロイスクリプト
# 現在のブランチに応じて dev/prod Lambda へデプロイ
#
# 使い方:
#   ./scripts/deploy-lambda.sh                 # ブランチ自動判定
#   ./scripts/deploy-lambda.sh dev             # 強制的に dev へ
#   ./scripts/deploy-lambda.sh prod            # 強制的に prod へ
#   ./scripts/deploy-lambda.sh status [dev|prod]          # live が指している版とコミット
#   ./scripts/deploy-lambda.sh rollback <dev|prod> [版]   # live を1つ前（または指定の版）へ戻す
#
# 版とエイリアス（2026-10-27〜）:
#   デプロイのたびに publish-version し、説明に git の SHA を入れ、エイリアス live をその版へ向ける。
#   API Gateway のステージ変数 lambdaFn は "<dev|prod>:live"（= awsquizHandler-<env>:live を呼ぶ）。
#   不具合が出たら rollback で live を前の版へ向けるだけで戻せる（コードを戻してデプロイし直さなくてよい）。
#   デプロイの前に lambda/test を走らせ、失敗したらデプロイしない。

set -e

AWS=/home/yuzuki/local/bin/aws
REGION=ap-northeast-1
ALIAS=live
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAMBDA_SRC="$REPO_ROOT/lambda/src"
ZIP=/tmp/lambda-deploy.zip

_alias_version() {  # $1=関数名 → live の版（無ければ空）
  $AWS lambda get-alias --function-name "$1" --name $ALIAS --region $REGION \
    --query FunctionVersion --output text 2>/dev/null || true
}

case "${1:-}" in
  status)
    for env in ${2:-dev prod}; do
      fn="awsquizHandler-$env"; v=$(_alias_version "$fn")
      if [ -z "$v" ]; then echo "$fn: エイリアス $ALIAS なし"; continue; fi
      desc=$($AWS lambda get-function-configuration --function-name "$fn" --qualifier "$v" --region $REGION --query Description --output text)
      echo "$fn: $ALIAS → 版 $v  ($desc)"
    done
    exit 0 ;;
  rollback)
    env="${2:?rollback <dev|prod> [版]}"; fn="awsquizHandler-$env"
    cur=$(_alias_version "$fn"); [ -n "$cur" ] || { echo "❌ $fn にエイリアス $ALIAS がありません"; exit 1; }
    to="${3:-}"
    if [ -z "$to" ]; then
      to=$($AWS lambda list-versions-by-function --function-name "$fn" --region $REGION \
        --query 'Versions[?Version!=`$LATEST`].Version' --output text | tr '\t' '\n' | sort -n | awk -v c="$cur" '$1<c' | tail -1)
    fi
    [ -n "$to" ] || { echo "❌ 戻す先の版がありません（今は版 $cur）"; exit 1; }
    $AWS lambda update-alias --function-name "$fn" --name $ALIAS --function-version "$to" --region $REGION \
      --query '[Name,FunctionVersion,Description]' --output text >/dev/null
    echo "✓ $fn: $ALIAS を版 $cur → $to に戻しました"
    "$0" status "$env"
    exit 0 ;;
esac

# ターゲット判定
if [ -n "$1" ]; then
  TARGET="$1"
else
  BRANCH=$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "develop")
  if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
    TARGET="prod"
  else
    TARGET="dev"
  fi
fi

FUNCTION_NAME="awsquizHandler-${TARGET}"
echo "→ Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null) → Deploying to: $FUNCTION_NAME"

# ドメインマスタを単一ソース（src/data/examDomains.json）から Lambda へ同期
cp "$REPO_ROOT/src/data/examDomains.json" "$LAMBDA_SRC/examDomains.json"
echo "✓ Synced examDomains.json"

# テスト（失敗したらデプロイしない）
(cd "$REPO_ROOT/lambda" && node --test test/*.test.js >/tmp/lambda-test.log 2>&1) || {
  echo "❌ lambda/test が失敗したのでデプロイしません（ログ: /tmp/lambda-test.log）"; tail -20 /tmp/lambda-test.log; exit 1; }
echo "✓ lambda/test: $(grep -E '^# pass' /tmp/lambda-test.log | sed 's/# //')"

# 版の説明に入れるコミット。lambda/ に未コミットの変更があれば +dirty を付ける
SHA=$(cd "$REPO_ROOT" && git rev-parse --short=7 HEAD)
if [ -n "$(cd "$REPO_ROOT" && git status --porcelain -- lambda/ src/data/examDomains.json)" ]; then SHA="${SHA}+dirty"; fi
DESC="git ${SHA} $(git rev-parse --abbrev-ref HEAD 2>/dev/null) $(TZ=Asia/Tokyo date '+%F %T')"

# ZIP 作成
cd "$LAMBDA_SRC"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$ZIP', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d != 'node_modules']
        for f in files:
            z.write(os.path.join(root, f))
    for root, dirs, files in os.walk('node_modules'):
        for f in files:
            z.write(os.path.join(root, f))
print('ZIP created')
"
cd - > /dev/null

# デプロイ → 版を切る → live を向ける
$AWS lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP" \
  --region $REGION \
  --query 'FunctionName' --output text
$AWS lambda wait function-updated --function-name "$FUNCTION_NAME" --region $REGION
VER=$($AWS lambda publish-version --function-name "$FUNCTION_NAME" --description "$DESC" --region $REGION \
  --query Version --output text)
if [ -n "$(_alias_version "$FUNCTION_NAME")" ]; then
  $AWS lambda update-alias --function-name "$FUNCTION_NAME" --name $ALIAS --function-version "$VER" --region $REGION >/dev/null
else
  $AWS lambda create-alias --function-name "$FUNCTION_NAME" --name $ALIAS --function-version "$VER" --region $REGION >/dev/null
  # API Gateway からエイリアスを呼ぶ許可（初回だけ）
  $AWS lambda add-permission --function-name "$FUNCTION_NAME:$ALIAS" --statement-id apigateway-live \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:570827308321:a0q3656qw4/*/*/*" --region $REGION >/dev/null
fi

echo "✓ Deployed to $FUNCTION_NAME（版 $VER・$ALIAS → $VER・$DESC）"
