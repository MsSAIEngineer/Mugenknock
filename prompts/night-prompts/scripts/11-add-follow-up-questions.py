#!/usr/bin/env python3
"""解いた問題に「もっと知りたい」質問を付ける（specs/009-follow-up-questions）。

  usage: 11-add-follow-up-questions.py [-n N] [-c C] [-D HH:MM] [--dry-run] [--recheck]

  -n N       処理する問題数（既定 50）
  -c C       1回の claude 呼び出しにまとめる問題数（既定 10）
  -D HH:MM   締切（JST）。過ぎたら次のチャンクに進まずに終わる
  --dry-run  書き込まずに、作った質問を出すだけ
  --recheck  付与ではなく、既存の whatif 質問が単体で通じるかを点検し、そのまま／書き直し／外すを決める

1周で1問につき1つ、最大3つ。有効な質問が少ない問題から順に付ける（全問が1つになってから2つ目）。
角度は term / diff / whatif / why / limits の5つで、1問の中では重ねない。モデルは Haiku。
質問を作ったときの選択肢のハッシュを followUpBasis に残し、選択肢が直されたら古い質問を捨てて付け直す
（画面も同じハッシュを計算し、合わない質問は出さない）。

質問は、問題を読んでいない人が自分の AI に貼って答えが返るものにする（画面のコピーは質問文だけ）。
2026-10-31 にこの決まりを強めた。新しい決まりで作った質問と、--recheck で点検した質問には rev=2 を付ける。
--recheck は rev の無い whatif 質問（問題の場面に頼りやすい角度）だけを点検し、点検済みは二度見ない。
"""
import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import boto3

MAX_PER_QUESTION = 3
ANGLES = {
    'term': '用語: 正解以外の選択肢に出てくる用語・サービス・機能について「xxxとは？」と聞く',
    'diff': '違い: 正解の選択肢の用語と、正解以外の選択肢の用語について「xxxとyyyの違いは？」または「xxxとyyyの使い分けは？」と聞く',
    'whatif': 'もし条件が違ったら: 問題文の要件（コスト・性能・運用負荷・可用性・セキュリティなど）を1つ入れ替えたら、何を選ぶべきかを聞く。問題の場面に頼らず、何のための選択か（用途）と入れ替えた条件を質問に書き込む。例「S3のデータを別リージョンへ複製する用途で、運用の手間よりコストを優先するなら、xxxの代わりに何を選ぶ？」',
    'why': '仕組み・なぜ: 正解の用語がなぜその要件を満たせるのか、内部の仕組みを聞く。例「xxxはなぜリージョン障害に強いの？」',
    'limits': '制限・料金・注意点: 正解の用語の上限（クォータ）・料金の仕組み・使うときにハマりやすい点を聞く',
}
NON_AWS = {'ML', 'DB', 'NW', 'SEC'}
BANNED = ('この問題', '選択肢', '上記', '正解', '誤り', '問題文', '本問', '設問')
JST = timezone(timedelta(hours=9))
REV = 2  # 「単体で通じる」決まりを強めた版（2026-10-31〜）。点検済み・新規作成の質問に付ける
SELF_CONTAINED_RULE = ('問題を読んでいない人が、この質問だけを自分の AI に貼って的確な答えが返るようにする。'
                       '問題の場面に固有の事情（その会社・そのシステム・その患者など）に頼らない。'
                       '答えを左右する前提（用途・規模・要件・制約）は、短く質問の中に書き込む。')

ddb = boto3.resource('dynamodb', region_name='ap-northeast-1')
table = ddb.Table('Questions')


def basis(choices):
    """FNV-1a 32bit（画面の followUpBasis と同じ計算）"""
    h = 0x811c9dc5
    for b in '\n'.join(choices).encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xffffffff
    return f'{h:08x}'


def scan_pool():
    items, kw = [], {
        'ProjectionExpression': 'questionId, examType, questionText, choices, correctAnswerIndices, isHidden, validityCheckedAt, followUpQuestions, followUpBasis',
    }
    while True:
        r = table.scan(**kw)
        items += r['Items']
        if 'LastEvaluatedKey' not in r:
            break
        kw['ExclusiveStartKey'] = r['LastEvaluatedKey']
    return [q for q in items if q.get('validityCheckedAt') and not q.get('isHidden') and q.get('choices') and q.get('questionText')]


def current(q):
    """選択肢が作ったときのままなら既存の質問、変わっていれば空"""
    fu = q.get('followUpQuestions') or []
    return fu if fu and q.get('followUpBasis') == basis(q['choices']) else []


def idx_list(v):
    if isinstance(v, list):
        return [int(x) for x in v]
    return [] if v is None or v == '' else [int(v)]


def find_claude():
    for c in ('/usr/local/bin/claude', shutil.which('claude')):
        if c and os.access(c, os.X_OK):
            return c
    sys.exit('❌ claude コマンドが見つかりません')


def build_prompt(chunk):
    angles = '\n'.join(f'- {k}: {v}' for k, v in ANGLES.items())
    blocks = []
    for q in chunk:
        correct = set(idx_list(q.get('correctAnswerIndices')))
        choices = '\n'.join(f"  {'[正解] ' if i in correct else '       '}{c}" for i, c in enumerate(q['choices']))
        used = current(q)
        free = [k for k in ANGLES if k not in {f['angle'] for f in used}]
        q['_prefer'] = random.choice(free)  # 角度が偏らないよう、問題ごとにまだ使っていない角度をランダムに勧める
        existing = '\n'.join(f"  - ({f['angle']}) {f['text']}" for f in used) or '  （なし）'
        note = '\n※ この問題は AWS 以外の土台知識の問題。質問に AWS や Amazon のサービス名を出さない。' if q['examType'] in NON_AWS else ''
        blocks.append(f"### id: {q['questionId']}（資格 {q['examType']}）\n問題:\n{q['questionText']}\n選択肢:\n{choices}\n既にある質問:\n{existing}\n推奨の角度: {q['_prefer']}{note}")
    return f"""あなたは資格試験の学習サイトで、解き終えた人が「プラスアルファで知っておきたいこと」を自分の AI に聞くための質問を作る。
次の各問題について、質問を1つだけ作る。

角度（各問題の「推奨の角度」で作る。その角度が問題に合わないときだけ、「既にある質問」で使っていない別の角度を選ぶ。どれも合わなければ skip）:
{angles}

決まり:
- 日本語で1文。12〜120文字。最後は「？」。
- 質問だけを読んで意味が通るようにする。「この問題」「選択肢」「正解」「上記」などで問題を指さない。用語やサービス名をそのまま書く。
- {SELF_CONTAINED_RULE}
- 問題の答え合わせではなく、解き終えた人が次に知ると役に立つことを聞く。
- 既にある質問と似た質問にしない。

{chr(10).join(blocks)}

出力は JSON の配列だけ（前後に文章やコードブロックを付けない）:
[{{"id": "<id>", "angle": "<term|diff|whatif|why|limits|skip>", "text": "<質問。skip なら空>"}}]
"""


def call_claude(cmd, prompt):
    env = {k: v for k, v in os.environ.items() if k != 'ANTHROPIC_API_KEY'}
    r = subprocess.run([cmd, '--strict-mcp-config', '-p', '--model', 'haiku', '--tools', ''],
                       input=prompt, capture_output=True, text=True, timeout=600, env=env)
    m = re.search(r'\[.*\]', r.stdout, re.S)
    if not m:
        raise ValueError(f'JSON が見つからない: {r.stdout[:200]} {r.stderr[:200]}')
    return json.loads(m.group(0))


def check_text(q, text):
    """質問の文面だけの検査。通らなければ理由を返す"""
    if '\n' in text or not 12 <= len(text) <= 120:
        return f'長さ・改行: {len(text)}文字'
    if not text.endswith(('？', '?')):
        return '「？」で終わらない'
    hit = [w for w in BANNED if w in text]
    if hit:
        return f'問題を指す言葉: {hit[0]}'
    if q['examType'] in NON_AWS and re.search(r'AWS|Amazon', text, re.I):
        return 'オリジナル資格に AWS の名前'
    return None


def check(q, out):
    """通らなければ理由を返す"""
    angle, text = out.get('angle'), (out.get('text') or '').strip()
    used = current(q)
    if angle not in ANGLES:
        return f'角度が不正: {angle}'
    if angle in {f['angle'] for f in used}:
        return f'角度が重複: {angle}'
    why = check_text(q, text)
    if why:
        return why
    if text in {f['text'] for f in used}:
        return '既存と同じ'
    return None


def needs_recheck(f):
    return f.get('angle') == 'whatif' and int(f.get('rev') or 0) < REV


def build_recheck_prompt(chunk):
    blocks = []
    for q in chunk:
        correct = set(idx_list(q.get('correctAnswerIndices')))
        choices = '\n'.join(f"  {'[正解] ' if i in correct else '       '}{c}" for i, c in enumerate(q['choices']))
        targets = '\n'.join(f"  [{i}] {f['text']}" for i, f in enumerate(current(q)) if needs_recheck(f))
        note = '\n※ AWS 以外の土台知識の問題。書き直す質問に AWS や Amazon のサービス名を出さない。' if q['examType'] in NON_AWS else ''
        blocks.append(f"### id: {q['questionId']}（資格 {q['examType']}）\n問題:\n{q['questionText']}\n選択肢:\n{choices}\n点検する質問:\n{targets}{note}")
    return f"""資格試験の学習サイトで、解き終えた人が自分の AI に貼って聞くための質問を点検する。
画面のコピーボタンは質問文だけを写す。AI は問題を見ていない。

基準: {SELF_CONTAINED_RULE}

各質問を次のどれかに判定する:
- keep: 質問だけで答えが決まる。直さない。
- rewrite: 問題の場面に頼っていて、そのままでは AI が答えを決められない。前提を書き込んで直す。
  言い回しの好みでは直さない。日本語で1文、12〜120文字、最後は「？」。
  「この問題」「選択肢」「正解」「上記」「問題文」などで問題を指さない。
- drop: 前提を書き込んでも120文字に収まらない、または聞く価値が無い。

{chr(10).join(blocks)}

出力は JSON の配列だけ（前後に文章やコードブロックを付けない）。点検する質問それぞれに1つ:
[{{"id": "<id>", "index": <番号>, "verdict": "<keep|rewrite|drop>", "text": "<rewrite のときだけ直した質問。それ以外は空>"}}]
"""


def recheck(a, deadline, pool, cmd):
    todo = [q for q in pool if any(needs_recheck(f) for f in current(q))]
    print(f"点検の残り {len(todo)}問 → 今回 {min(a.n, len(todo))}問")
    random.shuffle(todo)
    todo = todo[:a.n]
    tally = {'keep': 0, 'rewrite': 0, 'drop': 0, 'skip': 0}
    for i in range(0, len(todo), a.c):
        if deadline and datetime.now(JST) >= deadline:
            print(f'締切 {a.deadline} を過ぎたので終了')
            break
        chunk = todo[i:i + a.c]
        try:
            outs = call_claude(cmd, build_recheck_prompt(chunk))
        except Exception as e:
            print(f'⚠️ チャンク {i // a.c + 1}: {e}')
            continue
        verdicts = {}
        for o in outs:
            if isinstance(o, dict) and isinstance(o.get('index'), int):
                verdicts[(o.get('id'), o['index'])] = o
        for q in chunk:
            old = current(q)
            new, changed = [], False
            for idx, f in enumerate(old):
                if not needs_recheck(f):
                    new.append(f)
                    continue
                o = verdicts.get((q['questionId'], idx))
                v = (o or {}).get('verdict')
                text = ((o or {}).get('text') or '').strip()
                if v == 'rewrite':
                    why = check_text(q, text) or ('同じ文面' if text == f['text'] else None)
                    if why:
                        print(f"  ? {q['questionId']} 書き直しが検査で不合格（{why}）→ 今回は保留: {text}")
                        new.append(f)
                        tally['skip'] += 1
                        continue
                    print(f"  ~ {q['questionId']} {f['text']}\n      → {text}")
                    new.append({**f, 'text': text, 'rev': REV,
                                'rewrittenAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})
                elif v == 'drop':
                    print(f"  - {q['questionId']} 外す: {f['text']}")
                elif v == 'keep':
                    new.append({**f, 'rev': REV})
                else:
                    new.append(f)  # 判定が返らなかったものは次回にまわす
                    tally['skip'] += 1
                    continue
                tally[v] += 1
                changed = True
            if not changed or a.dry_run:
                continue
            try:
                table.update_item(
                    Key={'questionId': q['questionId']},
                    UpdateExpression='SET followUpQuestions = :f',
                    ConditionExpression='followUpQuestions = :old AND choices = :ch',
                    ExpressionAttributeValues={':f': new, ':old': q['followUpQuestions'], ':ch': q['choices']},
                )
            except ddb.meta.client.exceptions.ConditionalCheckFailedException:
                print(f"  ! {q['questionId']} 点検している間に質問か選択肢が変わったので書かない（次回）")
    print(f"点検: そのまま {tally['keep']}・書き直し {tally['rewrite']}・外す {tally['drop']}・保留 {tally['skip']}"
          + ('（dry-run）' if a.dry_run else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-n', type=int, default=50)
    ap.add_argument('-c', type=int, default=10)
    ap.add_argument('-D', dest='deadline')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--recheck', action='store_true')
    a = ap.parse_args()

    deadline = None
    if a.deadline:
        now = datetime.now(JST)
        hh, mm = map(int, a.deadline.split(':'))
        deadline = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if deadline <= now - timedelta(hours=12):
            deadline += timedelta(days=1)

    pool = scan_pool()
    if a.recheck:
        return recheck(a, deadline, pool, find_claude())
    todo = [q for q in pool if len(current(q)) < MAX_PER_QUESTION]
    random.shuffle(todo)
    todo.sort(key=lambda q: len(current(q)))
    counts = {}
    for q in pool:
        counts[len(current(q))] = counts.get(len(current(q)), 0) + 1
    print(f"出題対象 {len(pool)}問（質問の数ごと: {', '.join(f'{k}個 {v}問' for k, v in sorted(counts.items()))}）→ 今回 {min(a.n, len(todo))}問")
    todo = todo[:a.n]

    cmd = find_claude()
    added = skipped = rejected = 0
    for i in range(0, len(todo), a.c):
        if deadline and datetime.now(JST) >= deadline:
            print(f'締切 {a.deadline} を過ぎたので終了')
            break
        chunk = todo[i:i + a.c]
        try:
            outs = {o.get('id'): o for o in call_claude(cmd, build_prompt(chunk)) if isinstance(o, dict)}
        except Exception as e:
            print(f'⚠️ チャンク {i // a.c + 1}: {e}')
            continue
        for q in chunk:
            o = outs.get(q['questionId'])
            if not o or o.get('angle') == 'skip':
                skipped += 1
                continue
            why = check(q, o)
            if why:
                rejected += 1
                print(f"  ✗ {q['questionId']} {why}: {o.get('text')}")
                continue
            fu = current(q) + [{'angle': o['angle'], 'text': o['text'].strip(), 'rev': REV,
                                'createdAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}]
            print(f"  + {q['questionId']} ({o['angle']}) {o['text'].strip()}")
            if a.dry_run:
                added += 1
                continue
            try:
                table.update_item(
                    Key={'questionId': q['questionId']},
                    UpdateExpression='SET followUpQuestions = :f, followUpBasis = :b',
                    ConditionExpression='choices = :ch',
                    ExpressionAttributeValues={':f': fu, ':b': basis(q['choices']), ':ch': q['choices']},
                )
                added += 1
            except ddb.meta.client.exceptions.ConditionalCheckFailedException:
                print(f"  - {q['questionId']} 作っている間に選択肢が直されたので書かない")
    print(f"合計: 追加 {added}・合う角度なし {skipped}・検査で除外 {rejected}" + ('（dry-run）' if a.dry_run else ''))


if __name__ == '__main__':
    main()
