#!/usr/bin/env python3
"""人の確認の仕組み（docs/10-ops-review.md 4.1〜4.4。2026-10-27〜）。

  （引数なし） 抜き取り検査: 前回から28日以上たっていて、前回分が残っていなければ20問を「人の確認待ち」に入れる。
               半分は直近30日に作られた・直された問題（生成指示や AI の修正が変わった影響を見るため）、半分は全体から。
  --summary    日次レポート用の要約（確認待ちの件数と一番古い日付、監査指摘、通報、抜き取りの不良率、生成指示の変更）
  --mark-past  一度だけ: 2026-10-27 より前に AI が人の確認なしで正解を変えた問題を確認待ちに入れる
  --dry-run    書き込まずに対象だけ出す

確認待ちの印は Questions の humanReviewRequestedAt / reviewReason。結果は管理画面の「人の確認待ち」で
POST /admin/questions/:id/human-review（または修正案の適用・却下）が humanReviewedAt / humanReviewResult に残す。
"""
import json
import os
import random
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import boto3

SAMPLE_SIZE = 20
INTERVAL_DAYS = 28
RECENT_DAYS = 30
REPO = '/home/yuzuki/aws-quiz-app'
STAMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'state', 'human_review_last_sample')

ddb = boto3.resource('dynamodb', region_name='ap-northeast-1')
table = ddb.Table('Questions')
now = datetime.now(timezone.utc)
now_iso = now.strftime('%Y-%m-%dT%H:%M:%SZ')
dry = '--dry-run' in sys.argv

FIELDS = ('questionId, examType, isHidden, validityCheckedAt, createdAt, updatedAt, humanReviewRequestedAt, '
          'reviewReason, humanReviewedAt, humanReviewResult, humanReviewReason, auditNote, auditFlaggedAt, validityEditLog')


def scan_all():
    items, kw = [], {'ProjectionExpression': FIELDS}
    while True:
        r = table.scan(**kw)
        items += r['Items']
        if 'LastEvaluatedKey' not in r:
            return items
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']


def ts(s):
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except Exception:
        return None


def mark(qid, reason):
    if dry:
        print(f'  (dry-run) {qid} → {reason}')
        return
    table.update_item(
        Key={'questionId': qid},
        UpdateExpression='SET humanReviewRequestedAt = :t, reviewReason = :r',
        ConditionExpression='attribute_exists(questionId) AND attribute_not_exists(humanReviewRequestedAt)',
        ExpressionAttributeValues={':t': now_iso, ':r': reason},
    )


def sample(items):
    pending = [q for q in items if q.get('reviewReason') == 'sample']
    if pending:
        print(f'抜き取り: 前回分が {len(pending)} 問残っているので今回は入れない')
        return
    try:
        last = ts(open(STAMP).read().strip())
    except OSError:
        last = None
    if last and now - last < timedelta(days=INTERVAL_DAYS):
        print(f'抜き取り: 前回 {last:%Y-%m-%d} から{(now - last).days}日（{INTERVAL_DAYS}日ごと）→ スキップ')
        return
    pool = [q for q in items if q.get('validityCheckedAt') and not q.get('isHidden') and not q.get('humanReviewRequestedAt')]
    cutoff = now - timedelta(days=RECENT_DAYS)
    recent = [q for q in pool if (ts(q.get('updatedAt')) or ts(q.get('createdAt')) or now - timedelta(days=9999)) >= cutoff]
    picked = random.sample(recent, min(SAMPLE_SIZE // 2, len(recent)))
    ids = {q['questionId'] for q in picked}
    rest = [q for q in pool if q['questionId'] not in ids]
    picked += random.sample(rest, min(SAMPLE_SIZE - len(picked), len(rest)))
    for q in picked:
        mark(q['questionId'], 'sample')
    if not dry:
        os.makedirs(os.path.dirname(STAMP), exist_ok=True)
        open(STAMP, 'w').write(now_iso)
    print(f'抜き取り: {len(picked)} 問を人の確認待ちに入れた（直近{RECENT_DAYS}日の作成・修正分 {min(SAMPLE_SIZE // 2, len(recent))} 問を含む）')


def edit_entries(raw):
    try:
        v = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return []
    return v if isinstance(v, list) else [v]


def answer_changed(entry):
    ch = entry.get('changes') if isinstance(entry, dict) else None
    if not isinstance(ch, dict):
        return False  # 古い形式（変更点の一覧が無いもの）
    ca, cb = ch.get('correctAnswers'), ch.get('choices')
    if not isinstance(ca, dict):
        return False
    if not isinstance(cb, dict):
        # 選択肢はそのままで正解の文字列だけ変わった。頭の「A. 」を取っただけの変更は正解の変更ではない
        norm = lambda xs: sorted(re.sub(r'^[A-Ea-e][.．)]\s*', '', str(x)).strip() for x in (xs or []))
        return norm(ca.get('before')) != norm(ca.get('after'))
    try:
        before = sorted(cb['before'].index(a) for a in ca['before'])
        after = sorted(cb['after'].index(a) for a in ca['after'])
        return before != after
    except Exception:
        return True  # 判定できないものは人が見る側に倒す


def mark_past(items):
    n = 0
    for q in items:
        if q.get('humanReviewRequestedAt') or q.get('humanReviewedAt') or not q.get('validityEditLog'):
            continue
        if any(answer_changed(e) for e in edit_entries(q['validityEditLog'])):
            mark(q['questionId'], 'answer-changed-past')
            n += 1
    print(f'過去に AI が正解を変えた問題: {n} 問を人の確認待ちに入れた')


def summary(items):
    out = []
    waiting = [q for q in items if q.get('humanReviewRequestedAt')]
    label = {'answer-change': 'AIの正解変更（非表示中）', 'ai-delete': 'AIの削除提案（非表示中）',
             'sample': '抜き取り検査', 'answer-changed-past': '過去のAI正解変更'}
    if waiting:
        oldest = min(q['humanReviewRequestedAt'] for q in waiting)[:10]
        by = {}
        for q in waiting:
            by[q.get('reviewReason', 'sample')] = by.get(q.get('reviewReason', 'sample'), 0) + 1
        detail = '・'.join(f"{label.get(k, k)} {v}" for k, v in sorted(by.items()))
        out.append(f"人の確認待ち: {len(waiting)}問（{detail}）／一番古いもの {oldest}")
    else:
        out.append('人の確認待ち: 0問')
    audit = [q for q in items if q.get('auditNote')]
    if audit:
        out.append(f"監査の指摘（未処理）: {len(audit)}問／一番古いもの {min(str(q.get('auditFlaggedAt', '')) for q in audit)[:10]}")
    try:
        rep = boto3.client('dynamodb', region_name='ap-northeast-1').scan(TableName='Reports', Select='COUNT')['Count']
        out.append(f"通報（未処理）: {rep}件")
    except Exception:
        pass
    since = now - timedelta(days=90)
    done = [q for q in items if q.get('humanReviewResult') in ('ok', 'ng') and q.get('humanReviewReason') == 'sample'
            and (ts(q.get('humanReviewedAt')) or since) >= since]
    if done:
        ng = sum(1 for q in done if q['humanReviewResult'] == 'ng')
        out.append(f"抜き取り検査（直近90日）: {len(done)}問中 誤り{ng}問（{ng / len(done):.0%}）")
    else:
        out.append('抜き取り検査（直近90日）: まだ結果なし')
    try:
        log = subprocess.run(['git', '-C', REPO, 'log', '--since=1.day', '--format=%h %s', '--',
                              'prompts/night-prompts/scripts/instructions/'], capture_output=True, text=True).stdout.strip()
        if log:
            out.append('生成指示の変更（直近1日。次の抜き取りで直近分を多めに見る）: ' + ' / '.join(log.splitlines()))
    except Exception:
        pass
    print('\n'.join(out))


items = scan_all()
if '--summary' in sys.argv:
    summary(items)
elif '--mark-past' in sys.argv:
    mark_past(items)
else:
    sample(items)
