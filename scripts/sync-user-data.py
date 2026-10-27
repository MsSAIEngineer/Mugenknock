#!/usr/bin/env python3
"""検証(-dev)と本番(-prod)のユーザーデータを、本人のアカウントだけ同期する（2026-10-28 本人決定）。

本人は普段は検証で演習し、ときどき本番の画面を見て比べる。テーブルは dev/prod で分けたまま
（検証のコードが本番の全ユーザーの記録に書き込まないように）、本人のアカウントだけを写す。

  （引数なし） 検証 → 本番。夜間の保守バッチ（mugenknock-nightly-noai）から毎晩。
               解答履歴(UserAnswers)・セッション(Sessions)は足し合わせ（本番にしかない記録も残す）。
               問題別の正誤・ブックマーク(UserQuestionStats)・ドメイン別成績(UserTagStats)・
               ポイント(UserPoints)は、検証にある項目で本番を上書きする。
               図鑑(EncyclopediaUnlocks)は解放済みのサービスを足し合わせる（どちらで解放したものも残す）。
  --init       本番 → 検証。最初の1回だけ。検証にある本人の記録を消して、本番の記録で置き換える。
  --dry-run    書き込まずに件数だけ出す

おひねりの購入記録(UserEntitlements)と日次カウント(UserDailyCounts)は写さない
（検証は Stripe のテスト用キーなので、テスト購入を本番の購入にしないため）。
書き込む前に、書き込み先の本人の記録を state/user-sync-backup/ に JSON で残す（本番は PITR でも戻せる）。
"""
import json
import os
import sys
from datetime import datetime, timezone

from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

USER_IDS = ['0734fa28-60c1-707d-f888-f2cb860e561d']  # yuzukisera00@gmail.com
TABLES = ['Sessions', 'UserAnswers', 'UserQuestionStats', 'UserTagStats', 'UserPoints', 'EncyclopediaUnlocks']
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'prompts', 'night-prompts', 'scripts', 'state', 'user-sync-backup')

ddb = boto3.resource('dynamodb', region_name='ap-northeast-1')
init = '--init' in sys.argv
dry = '--dry-run' in sys.argv
src_env, dst_env = ('prod', 'dev') if init else ('dev', 'prod')


def items_of(table, uid):
    out, kw = [], {'KeyConditionExpression': Key('userId').eq(uid)}
    while True:
        r = table.query(**kw)
        out += r['Items']
        if 'LastEvaluatedKey' not in r:
            return out
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def to_json(o):  # 書き込み前の記録の保存用。数値を文字列にせず数値のまま残す
    if isinstance(o, Decimal):
        return int(o) if o == int(o) else float(o)
    if isinstance(o, set):
        return sorted(o)
    return str(o)


def merge_unlocks(s_items, d_items):
    """図鑑: 解放の一覧（unlocks の JSON）は両方を合わせ、日付は早いほうを残す。ほかの項目は写す元のまま。"""
    if not s_items or not d_items:
        return s_items
    src, dst = dict(s_items[0]), d_items[0]
    try:
        a, b = json.loads(src.get('unlocks') or '{}'), json.loads(dst.get('unlocks') or '{}')
    except ValueError:
        return s_items
    for k, v in b.items():
        if k not in a or v < a[k]:
            a[k] = v
    src['unlocks'] = json.dumps(a, ensure_ascii=False, separators=(',', ':'))
    return [src]


def key_of(table, item):
    return {k['AttributeName']: item[k['AttributeName']] for k in table.key_schema}


stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
print(f'ユーザーデータの同期: {src_env} → {dst_env}' + ('（初回・置き換え）' if init else '') + ('（dry-run）' if dry else ''))
for uid in USER_IDS:
    backup = {}
    for name in TABLES:
        src, dst = ddb.Table(f'{name}-{src_env}'), ddb.Table(f'{name}-{dst_env}')
        s_items, d_items = items_of(src, uid), items_of(dst, uid)
        if name == 'EncyclopediaUnlocks':
            s_items = merge_unlocks(s_items, d_items)
        backup[name] = d_items
        stale = []
        if init:
            keep = {json.dumps(key_of(src, i), sort_keys=True, default=str) for i in s_items}
            stale = [i for i in d_items if json.dumps(key_of(dst, i), sort_keys=True, default=str) not in keep]
        same = {json.dumps(i, sort_keys=True, default=to_json) for i in d_items}
        s_items = [i for i in s_items if json.dumps(i, sort_keys=True, default=to_json) not in same]  # 同じものは書かない
        print(f'  {name}: {src_env} → {dst_env}（今 {len(d_items)}件）に書く {len(s_items)}件' + (f'・消す {len(stale)}件' if init else ''))
        if dry:
            continue
        if not os.path.isdir(BACKUP_DIR):
            os.makedirs(BACKUP_DIR)
        with dst.batch_writer() as w:
            for i in stale:
                w.delete_item(Key=key_of(dst, i))
            for i in s_items:
                w.put_item(Item=i)
    if not dry:
        path = os.path.join(BACKUP_DIR, f'{dst_env}_{uid[:8]}_{stamp}.json')
        with open(path, 'w') as f:
            json.dump(backup, f, ensure_ascii=False, default=to_json)
        print(f'  書き込み前の {dst_env} の記録: {os.path.relpath(path)}')
