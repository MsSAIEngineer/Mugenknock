#!/bin/bash
# 日めくりAWSサービス生成スクリプト（手動実行用）
# 既存サービスと重複しない新サービスをClaudeで生成し DynamoDB に直接登録する
# 登録後、アイコンが不足していれば AWS 公式アイコンキットから自動取得する
#
# Usage:
#   ./generate-daily-services.sh           # 5件生成（デフォルト）
#   ./generate-daily-services.sh -n 10     # 10件生成
#   ./generate-daily-services.sh -h        # ヘルプ
#
# 環境変数:
#   AWS_ICON_KIT_URL   アイコンキット ZIP の URL（更新されたら差し替える）
#   AWS_ICON_KIT_CACHE アイコンキット ZIP のキャッシュパス（デフォルト: /tmp/aws-icon-kit-cache.zip）

set -uo pipefail

export PATH="/home/yuzuki/local/bin:$PATH"
unset ANTHROPIC_API_KEY

_find_claude() {
  [ -x /usr/local/bin/claude ] && { echo /usr/local/bin/claude; return; }
  local _cv; _cv=$(command -v claude 2>/dev/null)
  [ -n "$_cv" ] && [ -x "$_cv" ] && { echo "$_cv"; return; }
}
CLAUDE_CMD=$(_find_claude)
if [ -z "${CLAUDE_CMD:-}" ] || [ ! -x "${CLAUDE_CMD:-}" ]; then
  echo "❌ claude コマンドが見つかりません" >&2; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIGHT_PROMPTS_DIR="$(dirname "$SCRIPT_DIR")"
ICON_DIR="$(dirname "$(dirname "$NIGHT_PROMPTS_DIR")")/public/icons/aws"

COUNT=8

AWS_ICON_KIT_URL="${AWS_ICON_KIT_URL:-https://d1.awsstatic.com/onedam/marketing-channels/website/aws/en_US/architecture/approved/architecture-icons/Icon-package_04302026.4705b90f5aa45b019271a2699e9ce9b97b941ee1.zip}"
AWS_ICON_KIT_CACHE="${AWS_ICON_KIT_CACHE:-/tmp/aws-icon-kit-cache.zip}"

RATE_LIMIT_FILE="$NIGHT_PROMPTS_DIR/.claude_rate_limit_reset"

check_rate_limit() {
  [ -f "$RATE_LIMIT_FILE" ] || return 0
  local _rst _now _rep _disp
  _rst=$(cat "$RATE_LIMIT_FILE" 2>/dev/null)
  [ -z "$_rst" ] && { rm -f "$RATE_LIMIT_FILE"; return 0; }
  _now=$(date +%s)
  _rep=$(python3 -c "
from datetime import datetime
try: print(int(datetime.fromisoformat('$_rst').timestamp()))
except: print(0)
" 2>/dev/null || echo 0)
  if [ "$_now" -lt "$_rep" ]; then
    _disp=$(python3 -c "
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
try: print(datetime.fromisoformat('$_rst').astimezone(jst).strftime('%H:%M JST'))
except: print('$_rst')
" 2>/dev/null || echo "$_rst")
    echo "⏸  Claude レート制限中 — 復活予定: ${_disp}（$(basename "$0") をスキップ）"
    exit 2
  fi
  rm -f "$RATE_LIMIT_FILE"
}

record_rate_limit() {
  local _c="$1" _tmp _rst _disp
  _tmp=$(mktemp /tmp/rl_XXXX.txt)
  printf '%s' "$_c" > "$_tmp"
  _rst=$(python3 - "$_tmp" << 'PYEOF'
import sys, re
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
with open(sys.argv[1]) as f:
    text = f.read()
m = re.search(r'resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)', text, re.IGNORECASE)
if not m:
    print((datetime.now(jst) + timedelta(hours=6)).isoformat())
    sys.exit(0)
hour = int(m.group(1))
minute = int(m.group(2)) if m.group(2) else 0
mer = m.group(3).lower()
if mer == 'pm' and hour != 12: hour += 12
elif mer == 'am' and hour == 12: hour = 0
now = datetime.now(jst)
reset_dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
if reset_dt <= now:
    reset_dt += timedelta(days=1)
print(reset_dt.isoformat())
PYEOF
)
  rm -f "$_tmp"
  if [ -n "$_rst" ]; then
    echo "$_rst" > "$RATE_LIMIT_FILE"
    _disp=$(python3 -c "
from datetime import datetime, timezone, timedelta
jst = timezone(timedelta(hours=9))
try: print(datetime.fromisoformat('$_rst').astimezone(jst).strftime('%Y-%m-%d %H:%M JST'))
except: print('$_rst')
" 2>/dev/null || echo "$_rst")
    echo "  🔒 レート制限ロックファイル記録: $_disp"
  fi
}

show_help() {
  cat << 'EOF'
usage: generate-daily-services.sh [-n N] [-h]

  -n N    生成件数（デフォルト: 5）
  -h      このヘルプを表示

挙動:
  DailyServices テーブルの既存サービスを取得し、重複しない新サービスを Claude で生成
  生成したサービスを DynamoDB に直接登録（order は既存最大値+1 から連番）
  アイコンが不足していれば AWS 公式アイコンキット ZIP から自動取得
  それでも不足していれば一覧表示

環境変数:
  AWS_ICON_KIT_URL   アイコンキット ZIP の URL（古くなったら差し替える）
  AWS_ICON_KIT_CACHE ローカルキャッシュパス（デフォルト: /tmp/aws-icon-kit-cache.zip）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) COUNT="${2:?-n requires N}"; shift 2 ;;
    -h|--help) show_help; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; show_help >&2; exit 1 ;;
  esac
done

check_rate_limit
echo "=========================================="
echo "日めくりAWSサービス生成"
echo "生成件数: ${COUNT}件"
echo "=========================================="

# ── 1. 既存サービスを取得 ──────────────────────────────────────
echo ""
echo "--- 既存サービスを取得中 ---"
EXISTING_JSON=$(aws dynamodb scan --table-name DailyServices --output json 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$EXISTING_JSON" ]; then
  echo "❌ DynamoDB スキャン失敗" >&2; exit 1
fi

_EXISTING_TMP=$(mktemp /tmp/existing_svc_XXXX.json)
echo "$EXISTING_JSON" > "$_EXISTING_TMP"
EXISTING_INFO=$(python3 - "$_EXISTING_TMP" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

def d(v):
    if 'S' in v: return v['S']
    if 'N' in v: return v['N']
    if 'BOOL' in v: return v['BOOL']
    if 'L' in v: return [d(i) for i in v['L']]
    if 'M' in v: return {k: d(vv) for k, vv in v['M'].items()}
    return str(v)

items = [{k: d(v) for k, v in item.items()} for item in data.get('Items', [])]
items.sort(key=lambda x: int(x.get('order', 0)))

max_order = max((int(s.get('order', 0)) for s in items), default=0)

names = [s.get('name', '') for s in items]
docurls = [s.get('docUrl', '') for s in items if s.get('docUrl')]

print('__MAX_ORDER__' + str(max_order))
print('__COUNT__' + str(len(items)))
print('__NAMES__' + json.dumps(names, ensure_ascii=False))
print('__DOCURLS__' + json.dumps(docurls, ensure_ascii=False))

for s in items:
    print(f"  [{str(s.get('order', '')):>3}] {s.get('name', '')} ({s.get('category', '')})")
PYEOF
)
rm -f "$_EXISTING_TMP"

MAX_ORDER=$(echo "$EXISTING_INFO" | grep '^__MAX_ORDER__' | sed 's/^__MAX_ORDER__//')
EXISTING_COUNT=$(echo "$EXISTING_INFO" | grep '^__COUNT__' | sed 's/^__COUNT__//')
EXISTING_NAMES=$(echo "$EXISTING_INFO" | grep '^__NAMES__' | sed 's/^__NAMES__//')
EXISTING_DOCURLS=$(echo "$EXISTING_INFO" | grep '^__DOCURLS__' | sed 's/^__DOCURLS__//')
echo "$EXISTING_INFO" | grep -v '^__'
echo ""
echo "現在 ${EXISTING_COUNT}件 登録済み / 最大 order=${MAX_ORDER}"

# ── 1.6. カタログから記事化対象を確定（status==active && isArticleTarget && 未作成）──
#   service-catalog.json が単一の真実source。選定・docUrl・現行性をカタログに委ね、
#   モデルの「その場推測」を排除する。カタログ未整備時は従来どおりモデル選定にフォールバック。
CATALOG_FILE="$SCRIPT_DIR/state/service-catalog.json"
_CANDIDATES_TMP=$(mktemp /tmp/daily_svc_cand_XXXX.json)
echo '[]' > "$_CANDIDATES_TMP"
if [ -f "$CATALOG_FILE" ]; then
  CATALOG_FILE="$CATALOG_FILE" COUNT_VAL="$COUNT" EXISTING_NAMES_JSON="$EXISTING_NAMES" \
  EXISTING_DOCURLS_JSON="$EXISTING_DOCURLS" \
  python3 - "$_CANDIDATES_TMP" << 'PYEOF'
import json, os, re, sys
def norm(s):
    s = (s or '').lower().strip(); s = re.sub(r'^(amazon|aws)\s+', '', s)
    return re.sub(r'[^a-z0-9]', '', s)
def norm_url(u):
    # docUrl はサービスの正準ID。末尾スラッシュ・スキーム・大小・言語パス差を吸収して照合。
    u = (u or '').lower().strip().rstrip('/')
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'/(jp|ja|en)(/|$)', '/', u)
    return u
try:
    catalog = json.load(open(os.environ['CATALOG_FILE'], encoding='utf-8'))
except Exception:
    catalog = {'services': {}}
existing = set(norm(n) for n in json.loads(os.environ.get('EXISTING_NAMES_JSON') or '[]'))
existing_urls = set(norm_url(u) for u in json.loads(os.environ.get('EXISTING_DOCURLS_JSON') or '[]') if u)
# 同じ名前のエントリが複数ある場合は 1 つに決めてから判定する（05 のライフサイクルと同じ規則）。
# 例: 「AWS Snowball」は古い active と新しい eol の 2 件があり、そのままだと廃止で消した記事を作り直す。
#   - active と renamed が並んだら active を採る（改名先の名前は生きている）
#   - それ以外は lastVerifiedAt が新しい方を採る
def _prefer(cur, new):
    if cur is None:
        return new
    pair = {cur.get('status'), new.get('status')}
    if pair == {'active', 'renamed'}:
        return cur if cur.get('status') == 'active' else new
    return new if (new.get('lastVerifiedAt') or '') > (cur.get('lastVerifiedAt') or '') else cur
resolved = {}
for v in catalog.get('services', {}).values():
    if v.get('name') and v.get('status') not in (None, 'unknown'):
        k = norm(v['name'])
        resolved[k] = _prefer(resolved.get(k), v)
cands = []
seen_urls = set()  # 同一実行のカタログ内で docUrl 重複があっても二重生成しない
for v in catalog.get('services', {}).values():
    name = v.get('name')
    if not name or v.get('status') != 'active' or not v.get('isArticleTarget'):
        continue
    if resolved.get(norm(name)) is not v:
        continue
    # 名前一致・docUrl一致のどちらかで既存とみなしスキップ（略称⇔正式名の重複を防ぐ）
    if norm(name) in existing:
        continue
    u = norm_url(v.get('docUrl', ''))
    if u and (u in existing_urls or u in seen_urls):
        continue
    if u:
        seen_urls.add(u)
    cands.append(v)
# 試験関連度の高い順に優先
rank = {'high': 0, 'medium': 1, 'low': 2, 'none': 3, 'unknown': 4}
cands.sort(key=lambda v: rank.get(v.get('examRelevance', 'unknown'), 4))
cands = cands[:int(os.environ['COUNT_VAL'])]
json.dump([{'name': c['name'], 'category': c.get('category', ''), 'docUrl': c.get('docUrl', '')} for c in cands],
          open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False)
print(len(cands))
PYEOF
  _NCAND=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$_CANDIDATES_TMP" 2>/dev/null || echo 0)
fi
# 現行性担保: カタログで status=active かつ isArticleTarget の「未作成」サービスが無ければ生成しない。
# 以前は候補0件のときモデルの自由選定にフォールバックしていたが、それだと新規受付終了/廃止
# サービス(例: Amazon Fraud Detector)を記事化し得たため廃止。カタログ確定の現行サービスのみ生成する。
if [ "${_NCAND:-0}" -eq 0 ]; then
  echo ""
  echo "現行サービス（カタログ status=active・isArticleTarget）の新規記事化対象がありません。"
  echo "→ 非現行サービスの混入を防ぐため、今回の生成をスキップします。"
  rm -f "$_CANDIDATES_TMP"
  exit 0
fi
echo "  カタログ確定の記事化対象: ${_NCAND}件（status=active・検証済みdocUrl）"

# ── 1.5. アイコンキット ZIP の確保＋未取得アイコンのプリフェッチ ─────
if [ ! -f "$AWS_ICON_KIT_CACHE" ]; then
  echo ""
  echo "--- アイコンキット ZIP をダウンロード中 ---"
  curl -sL --retry 3 --max-time 120 -o "$AWS_ICON_KIT_CACHE" "$AWS_ICON_KIT_URL" \
    && echo "✓ ダウンロード完了 ($(du -h "$AWS_ICON_KIT_CACHE" | cut -f1))" \
    || { echo "⚠️  ダウンロード失敗（アイコン自動取得はスキップ）"; rm -f "$AWS_ICON_KIT_CACHE"; }
fi

if [ -f "$AWS_ICON_KIT_CACHE" ]; then
  _PREFETCH_COUNT=$(python3 - "$ICON_DIR" "$AWS_ICON_KIT_CACHE" << 'PYEOF'
import os, sys, zipfile

icon_dir  = sys.argv[1]
zip_cache = sys.argv[2]

# dest_filename → zip 内パス（拡張子なし）
ICON_ZIP_MAP = {
    "WorkSpaces":              "Architecture-Service-Icons_04302026/Arch_End-User-Computing/64/Arch_Amazon-WorkSpaces_64",
    "WorkDocs":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-WorkDocs_64",
    "WorkMail":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-WorkMail_64",
    "Outposts":                "Architecture-Service-Icons_04302026/Arch_Compute/64/Arch_AWS-Outposts-family_64",
    "Amplify":                 "Architecture-Service-Icons_04302026/Arch_Front-End-Web-Mobile/64/Arch_AWS-Amplify_64",
    "LocationService":         "Architecture-Service-Icons_04302026/Arch_Front-End-Web-Mobile/64/Arch_Amazon-Location-Service_64",
    "IoTCore":                 "Architecture-Service-Icons_04302026/Arch_Internet-of-Things/64/Arch_AWS-IoT-Core_64",
    "Connect":                 "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-Connect_64",
    "Pinpoint":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-Pinpoint_64",
    "AppSync":                 "Architecture-Service-Icons_04302026/Arch_Application-Integration/64/Arch_AWS-AppSync_64",
    "DirectoryService":        "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_AWS-Directory-Service_64",
    "Artifact":                "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_AWS-Artifact_64",
    "VerifiedPermissions":     "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_Amazon-Verified-Permissions_64",
    "SecurityLake":            "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_Amazon-Security-Lake_64",
    "FraudDetector":           "Architecture-Service-Icons_04302026/Arch_Artificial-Intelligence/64/Arch_Amazon-Fraud-Detector_64",
    "AmazonQ":                 "Architecture-Service-Icons_04302026/Arch_Artificial-Intelligence/64/Arch_Amazon-Q_64",
    "VPCLattice":              "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_Amazon-VPC-Lattice_64",
    "CloudWAN":                "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-Cloud-WAN_64",
    "CloudMap":                "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-Cloud-Map_64",
    "AppMesh":                 "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-App-Mesh_64",
    "ElasticDisasterRecovery": "Architecture-Service-Icons_04302026/Arch_Storage/64/Arch_AWS-Elastic-Disaster-Recovery_64",
    "ApplicationDiscovery":    "Architecture-Service-Icons_04302026/Arch_Migration-Modernization/64/Arch_AWS-Application-Discovery-Service_64",
    "AppMigrationService":     "Architecture-Service-Icons_04302026/Arch_Migration-Modernization/64/Arch_AWS-Application-Migration-Service_64",
    "SNS":                     "Architecture-Service-Icons_04302026/Arch_Application-Integration/64/Arch_Amazon-Simple-Notification-Service_64",
    "SQS":                     "Architecture-Service-Icons_04302026/Arch_Application-Integration/64/Arch_Amazon-Simple-Queue-Service_64",
    "ManagedBlockchain":       "Architecture-Service-Icons_04302026/Arch_Blockchain/64/Arch_Amazon-Managed-Blockchain_64",
    "EC2ImageBuilder":         "Architecture-Service-Icons_04302026/Arch_Compute/64/Arch_Amazon-EC2-Image-Builder_64",
    "CDK":                     "Architecture-Service-Icons_04302026/Arch_Developer-Tools/64/Arch_AWS-Cloud-Development-Kit_64",
    "CloudShell":              "Architecture-Service-Icons_04302026/Arch_Developer-Tools/64/Arch_AWS-CloudShell_64",
}

count = 0
try:
    with zipfile.ZipFile(zip_cache) as zf:
        zip_names = set(zf.namelist())
        for dest_key, zip_base in ICON_ZIP_MAP.items():
            for ext in ('png', 'svg'):
                dest_file = os.path.join(icon_dir, f'{dest_key}.{ext}')
                if os.path.exists(dest_file):
                    continue
                src = f'{zip_base}.{ext}'
                if src in zip_names:
                    with zf.open(src) as sf, open(dest_file, 'wb') as df:
                        df.write(sf.read())
                    if ext == 'png':
                        print(f'  → {dest_key}.png/svg を取得')
                        count += 1
except Exception as e:
    pass
print(f'__COUNT__{count}')
PYEOF
  )
  _PC=$(echo "$_PREFETCH_COUNT" | grep '^__COUNT__' | sed 's/^__COUNT__//')
  echo "$_PREFETCH_COUNT" | grep -v '^__'
  [ "${_PC:-0}" -gt 0 ] && echo "✓ ${_PC}件のアイコンをプリフェッチ"
fi

# ── 2. 利用可能なアイコンファイル一覧を取得（PNG があれば OK。SVG は優先表示されるが必須ではない）
ICON_FILES=$(find "$ICON_DIR" -name "*.png" 2>/dev/null | while read p; do
  basename "$p" .png
done | sort | tr '\n' ',' | sed 's/,$//')

# ── 3. Claude にサービスを生成させる ──────────────────────────
echo ""
echo "--- Claude でサービスを生成中 ---"

NEXT_ORDER=$(( MAX_ORDER + 1 ))

_NAMES_TMP=$(mktemp /tmp/daily_svc_names_XXXX.json)
printf '%s' "$EXISTING_NAMES" > "$_NAMES_TMP"

_ICONS_TMP=$(mktemp /tmp/daily_svc_icons_XXXX.txt)
printf '%s' "$ICON_FILES" > "$_ICONS_TMP"

PROMPT_FILE=$(mktemp /tmp/daily_svc_prompt_XXXX.txt)
COUNT_VAL="$COUNT" NEXT_ORDER_VAL="$NEXT_ORDER" \
python3 - "$_NAMES_TMP" "$_ICONS_TMP" "$_CANDIDATES_TMP" > "$PROMPT_FILE" << 'PYEOF'
import json, sys, os

with open(sys.argv[1]) as f:
    existing_names = json.load(f)

with open(sys.argv[2]) as f:
    available_files = set(x.strip() for x in f.read().split(',') if x.strip())

count = int(os.environ['COUNT_VAL'])
start_order = int(os.environ['NEXT_ORDER_VAL'])

existing_list = '\n'.join(f'  - {n}' for n in existing_names)

# サービス名 → アイコンファイルの対応表（AWS公式アイコンパック 2026年4月版）
# 優先度: 新しいファイル名（_new サフィックスなし）を選択
SERVICE_ICON_MAP = [
    # ── コンピューティング ──
    ("Amazon EC2",                          "EC2_new"),
    ("AWS Lambda",                          "Lambda_new"),
    ("Amazon ECR",                          "ECR"),
    ("Amazon ECS",                          "ECS"),
    ("Amazon EKS",                          "EKS"),
    ("AWS Fargate",                         "Fargate"),
    ("AWS Elastic Beanstalk",               "ElasticBeanstalk"),
    ("AWS Batch",                           "Batch"),
    ("Amazon Lightsail",                    "Lightsail"),
    ("AWS App Runner",                      "AppRunner"),
    ("AWS Wavelength",                      "Wavelength"),
    # ── ストレージ ──
    ("Amazon S3",                           "S3"),
    ("Amazon EBS",                          "EBS"),
    ("Amazon EFS",                          "EFS"),
    ("Amazon FSx",                          "FSx"),
    ("AWS Storage Gateway",                 "StorageGateway"),
    ("Amazon S3 Glacier",                   "Glacier"),
    ("AWS Backup",                          "Backup"),
    ("AWS Snowball",                        "Snowball"),
    # ── データベース ──
    ("Amazon RDS",                          "RDS_new"),
    ("Amazon Aurora",                       "Aurora"),
    ("Amazon DynamoDB",                     "DynamoDB_new"),
    ("Amazon ElastiCache",                  "ElastiCache_new"),
    ("Amazon Redshift",                     "Redshift"),
    ("Amazon DocumentDB",                   "DocumentDB"),
    ("Amazon Neptune",                      "Neptune"),
    ("Amazon Timestream",                   "Timestream"),
    ("Amazon MemoryDB",                     "MemoryDB"),
    # ── ネットワーキング ──
    ("Amazon VPC",                          "VPCVirtualprivatecloudVPC"),
    ("Amazon Route 53",                     "Route53_new"),
    ("Amazon CloudFront",                   "CloudFront_new"),
    ("Elastic Load Balancing",              "ElasticLoadBalancing"),
    ("Amazon API Gateway",                  "APIGateway_new"),
    ("AWS Transit Gateway",                 "TransitGateway"),
    ("AWS Direct Connect",                  "DirectConnect"),
    ("AWS Global Accelerator",              "GlobalAccelerator"),
    ("AWS PrivateLink",                     "PrivateLink"),
    ("AWS Auto Scaling",                    "AutoScaling"),
    # ── セキュリティ・アイデンティティ ──
    ("AWS IAM",                             "IAM"),
    ("Amazon Cognito",                      "Cognito_new"),
    ("AWS KMS",                             "KMS"),
    ("AWS Secrets Manager",                 "SecretsManager"),
    ("AWS Certificate Manager",             "CertificateManager"),
    ("AWS WAF",                             "WAF"),
    ("AWS Shield",                          "Shield"),
    ("Amazon GuardDuty",                    "GuardDuty"),
    ("Amazon Inspector",                    "Inspector"),
    ("Amazon Macie",                        "Macie"),
    ("AWS Security Hub",                    "SecurityHub"),
    ("Amazon Detective",                    "Detective"),
    ("AWS Firewall Manager",                "FirewallManager"),
    ("AWS Network Firewall",                "NetworkFirewall"),
    ("AWS IAM Identity Center",             "IAMIdentityCenter_new"),
    # ── 分析 ──
    ("Amazon Athena",                       "Athena"),
    ("AWS Glue",                            "Glue"),
    ("Amazon Kinesis",                      "Kinesis"),
    ("Amazon Kinesis Data Streams",         "KinesisDataStreams"),
    ("Amazon EMR",                          "EMR"),
    ("Amazon OpenSearch Service",           "OpenSearch"),
    ("Amazon QuickSight",                   "QuickSight"),
    ("AWS Lake Formation",                  "LakeFormation"),
    ("AWS Data Exchange",                   "DataExchange"),
    ("Amazon MSK",                          "MSK"),
    # ── 管理・ガバナンス ──
    ("Amazon CloudWatch",                   "CloudWatch_new"),
    ("AWS CloudTrail",                      "CloudTrail_new"),
    ("AWS Config",                          "Config"),
    ("AWS Systems Manager",                 "SystemsManager"),
    ("AWS CloudFormation",                  "CloudFormation_new"),
    ("AWS Control Tower",                   "ControlTower"),
    ("AWS Organizations",                   "Organizations"),
    ("AWS Trusted Advisor",                 "TrustedAdvisor"),
    ("AWS Health Dashboard",                "HealthDashboard"),
    # ── アプリケーション統合 ──
    ("Amazon SQS",                          "SQS"),
    ("Amazon SNS",                          "SNS"),
    ("Amazon EventBridge",                  "EventBridge_new"),
    ("AWS Step Functions",                  "StepFunctions"),
    ("Amazon MQ",                           "MQ"),
    ("Amazon AppFlow",                      "AppFlow"),
    ("Amazon SES",                          "SES"),
    # ── 開発者ツール ──
    ("AWS CodeCommit",                      "CodeCommit"),
    ("AWS CodeBuild",                       "CodeBuild"),
    ("AWS CodeDeploy",                      "CodeDeploy"),
    ("AWS CodePipeline",                    "CodePipeline_new"),
    ("AWS CodeArtifact",                    "CodeArtifact"),
    ("AWS Cloud9",                          "Cloud9"),
    ("AWS X-Ray",                           "XRay"),
    # ── 機械学習・AI ──
    ("Amazon SageMaker",                    "SageMakerAI"),
    ("Amazon Bedrock",                      "Bedrock_new"),
    ("Amazon Rekognition",                  "Rekognition"),
    ("Amazon Comprehend",                   "Comprehend"),
    ("Amazon Translate",                    "Translate"),
    ("Amazon Polly",                        "Polly"),
    ("Amazon Transcribe",                   "Transcribe"),
    ("Amazon Lex",                          "Lex"),
    ("Amazon Textract",                     "Textract"),
    ("Amazon Forecast",                     "Forecast"),
    ("Amazon Personalize",                  "Personalize"),
    ("Amazon Kendra",                       "Kendra"),
    # ── 移行・転送 ──
    ("AWS DMS",                             "DMS"),
    ("AWS DataSync",                        "DataSync"),
    ("AWS Transfer Family",                 "TransferFamily"),
    ("AWS Migration Hub",                   "MigrationHub"),
    ("AWS Application Migration Service",   "AppMigrationService"),
    # ── コスト管理 ──
    ("AWS Cost Explorer",                   "CostExplorer"),
    ("AWS Budgets",                         "Budgets"),
    ("AWS Savings Plans",                   "SavingsPlans"),
    ("AWS Compute Optimizer",               "ComputeOptimizer"),
    # ── エンドユーザーコンピューティング ──
    ("Amazon WorkSpaces",                   "WorkSpaces"),
    ("Amazon WorkDocs",                     "WorkDocs"),
    ("Amazon WorkMail",                     "WorkMail"),
    # ── ハイブリッド・エッジ ──
    ("AWS Outposts",                        "Outposts"),
    # ── フロントエンド・モバイル ──
    ("AWS Amplify",                         "Amplify"),
    ("Amazon Location Service",             "LocationService"),
    # ── IoT ──
    ("AWS IoT Core",                        "IoTCore"),
    # ── ビジネスアプリケーション ──
    ("Amazon Connect",                      "Connect"),
    ("Amazon Pinpoint",                     "Pinpoint"),
    # ── アプリケーション統合（追加） ──
    ("AWS AppSync",                         "AppSync"),
    # ── セキュリティ（追加） ──
    ("AWS Directory Service",               "DirectoryService"),
    ("AWS Artifact",                        "Artifact"),
    ("Amazon Verified Permissions",         "VerifiedPermissions"),
    ("Amazon Security Lake",                "SecurityLake"),
    # ── 機械学習（追加） ──
    ("Amazon Fraud Detector",               "FraudDetector"),
    ("Amazon Q",                            "AmazonQ"),
    # ── ネットワーキング（追加） ──
    ("Amazon VPC Lattice",                  "VPCLattice"),
    ("AWS Cloud WAN",                       "CloudWAN"),
    ("AWS Cloud Map",                       "CloudMap"),
    # ── コンテナ（追加） ──
    ("AWS App Mesh",                        "AppMesh"),
    # ── 移行（追加） ──
    ("AWS Elastic Disaster Recovery",       "ElasticDisasterRecovery"),
    ("AWS Application Discovery Service",   "ApplicationDiscovery"),
    # ── ブロックチェーン ──
    ("Amazon Managed Blockchain",           "ManagedBlockchain"),
    # ── コンピューティング（追加） ──
    ("Amazon EC2 Image Builder",            "EC2ImageBuilder"),
    # ── 開発者ツール（追加） ──
    ("AWS Cloud Development Kit",           "CDK"),
    ("AWS CloudShell",                      "CloudShell"),
]

# 利用可能なファイルのみに絞り込んで対応表を作成
icon_table_lines = []
mapped_files = set()
for svc_name, fname in SERVICE_ICON_MAP:
    if fname in available_files:
        icon_table_lines.append(f'  {svc_name:<45} → /icons/aws/{fname}.png')
        mapped_files.add(fname)

icon_table = '\n'.join(icon_table_lines)

# カタログ確定の記事化対象（あれば、選定・docUrl・現行性はカタログ確定。モデルは記事本文のみ作成）
catalog_candidates = []
try:
    with open(sys.argv[3], encoding='utf-8') as f:
        catalog_candidates = json.load(f)
except Exception:
    catalog_candidates = []
if catalog_candidates:
    count = len(catalog_candidates)
    _cl = '\n'.join(
        f'  - {c["name"]}（category: {c.get("category","") or "（カタログ未設定・最適なものを選ぶ）"} / docUrl: {c.get("docUrl","") or "（公式URLを設定）"}）'
        for c in catalog_candidates)
    target_block = (
        '【今回作成する対象サービス（カタログで現行性・docUrlを検証済み。これら“のみ”作成）】\n'
        + _cl
        + '\n\n※ 上記サービスを1件ずつ作成する。docUrl は上記の検証済みURLをそのまま使用（推測・改変しない）。'
        + 'category も上記に従う。上記以外のサービスは作成しないこと。'
    )
else:
    target_block = '【選定基準】現行サービスのみ。AWS認定試験出題範囲優先。カテゴリバランスよく。'

print(f"""AWSクイズサイトの「日めくりAWSサービス」コンテンツを{count}件生成してください。

【重複禁止（登録済み）】
{existing_list}

【アイコン対応表】icon フィールドに使用。該当なしは "" にすること。
{icon_table}

【フィールド仕様】
- name: 正式名称 / shortName: 短縮名
- category（いずれか）: コンピューティング/ストレージ/データベース/ネットワーキング/メッセージング/コンテナ/セキュリティ/モニタリング/アプリケーション統合/DevOps/データ分析/機械学習/生成AI/マネジメント/移行
- description: 80〜120字。何ができるか・どんな場面で使うかを試験受験者向けに。複数の特徴は\\nで区切る。本アプリ使用サービス（Cognito/API Gateway/Lambda/DynamoDB/Amplify Hosting/CodeCommit/S3）なら末尾に「本アプリでも利用しています」を追加。
- trivia: 80〜150字。名前の由来・覚え方・試験ポイント・有名企業活用事例（Netflix/Airbnb/NASA等）など。複数事実は\\nで区切る。
- icon: 対応表からパスをコピー（形式: "/icons/aws/ファイル名.png"）
- docUrl: "https://aws.amazon.com/jp/サービス名/" 形式
- order: {start_order} から連番

{target_block}

【出力】JSONのみ。前置き・コードブロック不要。
{{"services":[{{"name":"...","shortName":"...","category":"...","description":"...","trivia":"...","icon":"...","docUrl":"...","order":{start_order}}},...]}}
""")
PYEOF
rm -f "$_NAMES_TMP" "$_ICONS_TMP" "$_CANDIDATES_TMP"

_STDOUT_F=$(mktemp /tmp/claude_out_XXXX)
_STDERR_F=$(mktemp /tmp/claude_err_XXXX)
CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 timeout -k 30 "${CLAUDE_TIMEOUT:-1800}" "$CLAUDE_CMD" --strict-mcp-config -p --model sonnet --tools "" < "$PROMPT_FILE" > "$_STDOUT_F" 2> "$_STDERR_F"
AI_EXIT=$?
RESULT=$(cat "$_STDOUT_F")
_STDERR_OUT=$(cat "$_STDERR_F")
rm -f "$_STDOUT_F" "$_STDERR_F" "$PROMPT_FILE"

if echo "$_STDERR_OUT" | grep -qiE "rate.?limit|too many requests|overload|quota exceeded|session.?limit|hit your" || \
   echo "$RESULT" | grep -qiE "You've hit|rate.?limit|too many requests"; then
  echo "⚠️  レート制限を検出"
  echo "stderr: $(echo "$_STDERR_OUT" | head -3)"
  record_rate_limit "$(echo "$RESULT $_STDERR_OUT" | head -10)"
  exit 1
fi

if [ $AI_EXIT -ne 0 ]; then
  echo "❌ Claude 実行エラー (exit=$AI_EXIT)"
  echo "stderr: $(echo "$_STDERR_OUT" | head -5)"
  exit 1
fi

# ── 4. JSON 抽出 ───────────────────────────────────────────────
SERVICES_JSON=$(echo "$RESULT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
cb = re.search(r'\`\`\`(?:json)?\s*(\{)', text, re.DOTALL)
if cb:
    text = text[cb.start(1):]
    text = re.sub(r'\s*\`\`\`.*$', '', text, flags=re.DOTALL)
start = text.find('{')
if start == -1: print('{}'); exit(0)
try:
    obj, _ = json.JSONDecoder().raw_decode(text, start)
    print(json.dumps(obj) if 'services' in obj else '{}')
except: print('{}')
")

SVC_COUNT=$(echo "$SERVICES_JSON" | python3 -c "
import sys, json
print(len(json.loads(sys.stdin.read()).get('services', [])))
" 2>/dev/null || echo 0)

if [ "$SVC_COUNT" -eq 0 ]; then
  echo "❌ JSON 抽出失敗"
  echo "$RESULT" | head -c 400
  exit 1
fi

echo "✓ ${SVC_COUNT}件 生成完了"

# ── 5. DynamoDB に登録 ────────────────────────────────────────
echo ""
echo "--- DynamoDB に登録中 ---"

IMPORT_RESULT=$(python3 - "$SERVICES_JSON" "$ICON_DIR" "$AWS_ICON_KIT_CACHE" "$EXISTING_NAMES" << 'PYEOF'
import json, sys, subprocess, os, re, zipfile
from datetime import datetime, timezone

data      = json.loads(sys.argv[1])
icon_dir  = sys.argv[2]
zip_cache = sys.argv[3] if len(sys.argv) > 3 else ''
services  = data.get('services', [])

# AIが「重複禁止」指示を無視して既存サービスを再度提案することがあるため、
# プロンプトのソフト制約とは別に、登録直前に機械的な正規化名重複チェックで弾く。
def _norm_name(s):
    s = (s or '').lower().strip()
    s = re.sub(r'^(amazon|aws)\s+', '', s)
    return re.sub(r'[^a-z0-9]', '', s)

_existing_names_json = sys.argv[4] if len(sys.argv) > 4 else '[]'
try:
    _existing_norm = {_norm_name(n) for n in json.loads(_existing_names_json)}
except Exception:
    _existing_norm = set()

_seen_norm = set()
_deduped = []
for svc in services:
    n = _norm_name(svc.get('name', ''))
    if n and (n in _existing_norm or n in _seen_norm):
        print(f"  ⏭  重複のためスキップ: {svc.get('name', '')}")
        continue
    if n:
        _seen_norm.add(n)
    _deduped.append(svc)
services = _deduped

now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
slug_re = re.compile(r'[^a-z0-9]+')

ICON_ZIP_MAP = {
    "WorkSpaces":              "Architecture-Service-Icons_04302026/Arch_End-User-Computing/64/Arch_Amazon-WorkSpaces_64",
    "WorkDocs":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-WorkDocs_64",
    "WorkMail":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-WorkMail_64",
    "Outposts":                "Architecture-Service-Icons_04302026/Arch_Compute/64/Arch_AWS-Outposts-family_64",
    "Amplify":                 "Architecture-Service-Icons_04302026/Arch_Front-End-Web-Mobile/64/Arch_AWS-Amplify_64",
    "LocationService":         "Architecture-Service-Icons_04302026/Arch_Front-End-Web-Mobile/64/Arch_Amazon-Location-Service_64",
    "IoTCore":                 "Architecture-Service-Icons_04302026/Arch_Internet-of-Things/64/Arch_AWS-IoT-Core_64",
    "Connect":                 "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-Connect_64",
    "Pinpoint":                "Architecture-Service-Icons_04302026/Arch_Business-Applications/64/Arch_Amazon-Pinpoint_64",
    "AppSync":                 "Architecture-Service-Icons_04302026/Arch_Application-Integration/64/Arch_AWS-AppSync_64",
    "DirectoryService":        "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_AWS-Directory-Service_64",
    "Artifact":                "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_AWS-Artifact_64",
    "VerifiedPermissions":     "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_Amazon-Verified-Permissions_64",
    "SecurityLake":            "Architecture-Service-Icons_04302026/Arch_Security-Identity/64/Arch_Amazon-Security-Lake_64",
    "FraudDetector":           "Architecture-Service-Icons_04302026/Arch_Artificial-Intelligence/64/Arch_Amazon-Fraud-Detector_64",
    "AmazonQ":                 "Architecture-Service-Icons_04302026/Arch_Artificial-Intelligence/64/Arch_Amazon-Q_64",
    "VPCLattice":              "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_Amazon-VPC-Lattice_64",
    "CloudWAN":                "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-Cloud-WAN_64",
    "CloudMap":                "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-Cloud-Map_64",
    "AppMesh":                 "Architecture-Service-Icons_04302026/Arch_Networking-Content-Delivery/64/Arch_AWS-App-Mesh_64",
    "ElasticDisasterRecovery": "Architecture-Service-Icons_04302026/Arch_Storage/64/Arch_AWS-Elastic-Disaster-Recovery_64",
    "ApplicationDiscovery":    "Architecture-Service-Icons_04302026/Arch_Migration-Modernization/64/Arch_AWS-Application-Discovery-Service_64",
    "ManagedBlockchain":       "Architecture-Service-Icons_04302026/Arch_Blockchain/64/Arch_Amazon-Managed-Blockchain_64",
    "EC2ImageBuilder":         "Architecture-Service-Icons_04302026/Arch_Compute/64/Arch_Amazon-EC2-Image-Builder_64",
    "CDK":                     "Architecture-Service-Icons_04302026/Arch_Developer-Tools/64/Arch_AWS-Cloud-Development-Kit_64",
    "CloudShell":              "Architecture-Service-Icons_04302026/Arch_Developer-Tools/64/Arch_AWS-CloudShell_64",
}

def _norm_zip(path):
    """ZIP 内パスのベース名を正規化: Arch_ / Amazon- / AWS- プレフィクスと _64 サフィックスを除去して英数字小文字化。"""
    fn = os.path.basename(path)
    fn = re.sub(r'^Arch_', '', fn)
    fn = re.sub(r'^(Amazon|AWS)-', '', fn, flags=re.IGNORECASE)
    fn = re.sub(r'_64\.(png|svg)$', '', fn)
    return re.sub(r'[^a-z0-9]', '', fn.lower())

def _norm_key(s):
    """アイコンキーまたはサービス名を同じ空間に正規化。"""
    s = re.sub(r'^(Amazon|AWS)\s+', '', s, flags=re.IGNORECASE)
    return re.sub(r'[^a-z0-9]', '', s.lower())

def _extract_paths(zf, zip_names, zip_base_or_png_path, dest_fname):
    """ZIP から PNG+SVG を抽出して icon_dir へ保存。PNG が取れたら True。"""
    # zip_base_or_png_path は拡張子なし（ICON_ZIP_MAP用）か .png パス（自動検出用）
    if zip_base_or_png_path.endswith('.png'):
        base = zip_base_or_png_path[:-4]
    else:
        base = zip_base_or_png_path
    extracted_png = False
    for ext in ('png', 'svg'):
        src  = f'{base}.{ext}'
        dest = os.path.join(icon_dir, f'{dest_fname}.{ext}')
        if src in zip_names and not os.path.exists(dest):
            with zf.open(src) as sf, open(dest, 'wb') as df:
                df.write(sf.read())
            if ext == 'png':
                extracted_png = True
    return extracted_png

def try_extract_from_zip(fname):
    """ICON_ZIP_MAP → ZIP自動検索 の順でアイコンを取得。PNG が取れたら True。"""
    if not zip_cache or not os.path.exists(zip_cache):
        return False
    try:
        with zipfile.ZipFile(zip_cache) as zf:
            zip_names = set(zf.namelist())
            # ── 1. ICON_ZIP_MAP（手書きマッピング）で試みる ──
            zip_base = ICON_ZIP_MAP.get(fname)
            if zip_base and _extract_paths(zf, zip_names, zip_base, fname):
                return True
            # ── 2. フォールバック: ファイル名を正規化してZIPを自動検索 ──
            target = _norm_key(fname)
            candidates = [p for p in zip_names
                         if p.endswith('_64.png') and '/64/' in p and '__MACOSX' not in p
                         and _norm_zip(p) == target]
            if len(candidates) == 1:
                if _extract_paths(zf, zip_names, candidates[0], fname):
                    print(f'    → 自動検出: {os.path.basename(candidates[0])} → {fname}.png/svg')
                    return True
    except Exception:
        pass
    return False

def try_auto_detect_icon(service_name):
    """サービス名からアイコンキーを生成。まずローカル icon_dir の既存PNGを確認し、
    無ければ ZIP を自動検索する。ZIP未収録で手動追加した新サービスのアイコンにも対応。"""
    # "AWS AppConfig" → "AppConfig", "Amazon GameLift Streams" → "GameLiftStreams"
    # 末尾/途中の括弧注記（例: "(ARC)", "(MongoDB 互換)"）はアイコン名に含まれないため除去。
    base = re.sub(r'^(Amazon|AWS)\s+', '', service_name, flags=re.IGNORECASE)
    base = re.sub(r'\s*[（(].*?[）)]', '', base)
    auto_key = re.sub(r'\s+', '', base)
    if not auto_key:
        return None
    # ① ローカルに既存の同名PNGがあれば即採用（手動追加・ZIP未収録の新サービス対応）
    if os.path.exists(os.path.join(icon_dir, f'{auto_key}.png')):
        return auto_key
    # ② ZIP から自動検索
    if not zip_cache or not os.path.exists(zip_cache):
        return None
    try:
        with zipfile.ZipFile(zip_cache) as zf:
            zip_names = set(zf.namelist())
            target = _norm_key(auto_key)
            candidates = [p for p in zip_names
                         if p.endswith('_64.png') and '/64/' in p and '__MACOSX' not in p
                         and _norm_zip(p) == target]
            if len(candidates) == 1:
                if _extract_paths(zf, zip_names, candidates[0], auto_key):
                    print(f'    → 自動検出: {os.path.basename(candidates[0])} → {auto_key}.png/svg')
                    return auto_key
    except Exception:
        pass
    return None

def ensure_both_formats(fname):
    """PNG があれば True。SVG もあれば自動的に優先表示されるが必須ではない。
    欠けている形式があれば ZIP から補完を試みる。"""
    p = os.path.join(icon_dir, f'{fname}.png')
    s = os.path.join(icon_dir, f'{fname}.svg')
    if not (os.path.exists(p) and os.path.exists(s)):
        try_extract_from_zip(fname)  # 欠けている方を ZIP から補完（失敗しても PNG があれば続行）
    return os.path.exists(p)  # PNG のみで十分

skipped_no_icon = []  # アイコン(png+svg両方)が解決できず記事を作成しなかったサービス
imported = []

for svc in services:
    name        = svc.get('name', '')
    short_name  = svc.get('shortName', '')
    category    = svc.get('category', '')
    description = svc.get('description', '')
    trivia      = svc.get('trivia', '')
    icon        = svc.get('icon', '')
    doc_url     = svc.get('docUrl', '')
    order       = svc.get('order', 0)

    slug       = slug_re.sub('-', short_name.lower()).strip('-')
    service_id = f'svc-{slug}-{order}'

    # PNG がないサービスは記事を作成しない。SVG はあれば優先表示されるが必須ではない。
    if icon:
        fname = os.path.splitext(os.path.basename(icon))[0]
    else:
        # アイコン未指定 → サービス名でZIPを自動検索（png/svg両方を抽出）
        fname = try_auto_detect_icon(name)
    if not fname or not ensure_both_formats(fname):
        skipped_no_icon.append({'name': name, 'icon': icon or '(未指定)'})
        print(f'  ⏭  [{order:>3}] {name}: PNG が無いため記事を作成しません')
        continue
    # icon は常に .png パスに正規化（フロントの ServiceIconImg は .png 前提で svg を優先読み込み）
    icon = f'/icons/aws/{fname}.png'

    item = {
        'serviceId':   {'S': service_id},
        'name':        {'S': name},
        'shortName':   {'S': short_name},
        'category':    {'S': category},
        'description': {'S': description},
        'trivia':      {'S': trivia},
        'icon':        {'S': icon},
        'docUrl':      {'S': doc_url},
        'order':       {'S': str(order)},
        'isActive':    {'BOOL': True},
        'createdAt':   {'S': now},
    }

    result = subprocess.run([
        'aws', 'dynamodb', 'put-item',
        '--table-name', 'DailyServices',
        '--item', json.dumps(item),
    ], capture_output=True, text=True)

    if result.returncode == 0:
        print(f'  ✓ [{order:>3}] {name} ({category})')
        imported.append(name)
    else:
        print(f'  ❌ [{order:>3}] {name}: {result.stderr.strip()[:100]}')

print(f'__IMPORTED__{len(imported)}')
print('__SKIPPED_NO_ICON__' + json.dumps(skipped_no_icon, ensure_ascii=False))
PYEOF
)

IMPORTED_COUNT=$(echo "$IMPORT_RESULT" | grep '^__IMPORTED__' | sed 's/^__IMPORTED__//')
SKIPPED_ICONS=$(echo "$IMPORT_RESULT" | grep '^__SKIPPED_NO_ICON__' | sed 's/^__SKIPPED_NO_ICON__//')
echo "$IMPORT_RESULT" | grep -v '^__'

echo ""
echo "登録完了: ${IMPORTED_COUNT}件"

# ── 6. アイコン未解決でスキップしたサービスの警告 ──────────────────
#   方針: アイコンが無いサービスは記事を作成しない（画像なし日めくりを生まない）。
#   下記は今回スキップしたもの。記事化したい場合はアイコンを用意して再実行する。
SKIPPED_COUNT=$(echo "$SKIPPED_ICONS" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo 0)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  echo "⏭  アイコン(png+svg両方)が揃わず記事を作成しなかったサービス（${SKIPPED_COUNT}件）:"
  echo "$SKIPPED_ICONS" | python3 -c "
import json, sys
items = json.loads(sys.stdin.read())
for item in items:
    print(f\"  - {item['name']}: {item['icon']}\")
print()
print('  記事化するには ICON_ZIP_MAP に ZIP 内パスを追加するか、')
print('  public/icons/aws/ に PNG/SVG を手動配置して再実行してください。')
"
fi

echo ""
echo "=========================================="
echo "完了: $(date)"
echo "=========================================="
