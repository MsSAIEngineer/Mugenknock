#!/bin/bash
# 夜間バッチが管理 API（/admin/*）を呼ぶための Cognito ID トークンを標準出力に出す。
# 夜間バッチ専用ユーザー・専用アプリクライアント（USER_PASSWORD_AUTH はこのクライアントだけで有効）で
# パスワード認証する（2026-10-27〜。docs/10-ops-review.md 4.9）。人の管理者アカウントは MFA を付けるので使わない。
#   SSM: /quiz-app/batch-username・/quiz-app/batch-password（SecureString）・/quiz-app/batch-client-id
# 取れなければ空を出して終了コード 1。
set -uo pipefail
AWS="${AWS:-aws}"
_p() { "$AWS" ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }
USERNAME=$(_p /quiz-app/batch-username)
PASSWORD=$(_p /quiz-app/batch-password)
CLIENT_ID=$(_p /quiz-app/batch-client-id)
if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ] || [ -z "$CLIENT_ID" ]; then
  # 専用ユーザーを作る前の互換: 従来どおり本人の管理者アカウント＋Web クライアントで入る（作ったら消す）
  echo "batch-id-token: バッチ専用ユーザーの SSM が無いので従来のアカウントで認証" >&2
  USERNAME=yuzuki2002110@gmail.com; PASSWORD=$(_p /quiz-app/admin-password); CLIENT_ID=16jjrj5m28o6s2k84og8kh2vh3
fi
T=$("$AWS" cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=$USERNAME,PASSWORD=$PASSWORD" --client-id "$CLIENT_ID" \
  --query AuthenticationResult.IdToken --output text 2>/dev/null)
[ -n "$T" ] && [ "$T" != "None" ] || { echo "batch-id-token: 認証に失敗" >&2; exit 1; }
printf '%s' "$T"
