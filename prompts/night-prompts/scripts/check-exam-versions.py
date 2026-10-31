#!/usr/bin/env python3
"""AWS 認定試験の版（試験コード）の変化を検出する（specs/010-mla-c02）。

公式の試験ガイド一覧（docs.aws.amazon.com）に載っている試験コードと、アプリの src/constants.ts の examCode を比べる。
- アプリのコードが一覧に無い → 旧版のまま（例: MLA-C01 のまま、一覧は MLA-C02）
- 一覧に新しい版も載っている → 改訂の予告・移行期間（例: DVA-C02 と DVA-C03 の両方）

版の切り替えは配点・ドメイン名・画面に波及するので、ここでは書き換えず知らせるだけ（spec を切って人が確認する）。
claude を使わない（curl 相当の取得と正規表現だけ）。

  usage: check-exam-versions.py [--quiet]
  出力: 問題があれば 1 行ずつ。--quiet のときは問題が無ければ何も出さない。
  終了コード: 0 = 一致 / 1 = 旧版のまま / 2 = 改訂の予告あり / 3 = 一覧を取得できない
"""
import os
import re
import sys
import urllib.request

INDEX_URL = 'https://docs.aws.amazon.com/aws-certification/latest/examguides/aws-certification-exam-guides.html'
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CONSTANTS = os.path.join(REPO, 'src', 'constants.ts')


def app_codes():
    """constants.ts の EXAM_CONFIGS から AWS 認定の examCode を読む（オリジナル資格 ML/DB/NW/SEC は対象外）"""
    src = open(CONSTANTS, encoding='utf-8').read()
    return dict(re.findall(r"^\s*([A-Z]{3}):\s*\{\s*examCode:\s*'([A-Z]{3}-C\d{2})'", src, re.M))


def official_codes():
    req = urllib.request.Request(INDEX_URL, headers={'User-Agent': 'mugenknock-exam-version-check'})
    html = urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')
    found = {}
    for exam, ver in re.findall(r'\(([A-Z]{3})-C(\d{2})\)', html):
        found.setdefault(exam, set()).add(int(ver))
    return found


def main():
    quiet = '--quiet' in sys.argv
    try:
        official = official_codes()
    except Exception as e:
        print(f'⚠ 試験の版: 公式の試験ガイド一覧を取得できない（{e}）')
        return 3
    if not official:
        print('⚠ 試験の版: 公式の試験ガイド一覧から試験コードを読み取れない（ページの形式が変わった可能性）')
        return 3
    old = upcoming = False
    lines = []
    for exam, code in sorted(app_codes().items()):
        ver = int(code.split('-C')[1])
        vers = official.get(exam)
        if not vers:
            lines.append(f'⚠ {exam}: 公式の試験ガイド一覧に見当たらない（アプリは {code}。廃止・名称変更の可能性）')
            old = True
        elif ver not in vers:
            latest = max(vers)
            lines.append(f'⚠ {exam}: アプリは {code} のまま、公式は {exam}-C{latest:02d}（旧版。指示書・配点・ドメイン名の更新が必要）')
            old = True
        elif max(vers) > ver:
            lines.append(f'ℹ {exam}: 新版 {exam}-C{max(vers):02d} が公開済み（アプリは {code}。移行期間中。切り替えの準備が必要）')
            upcoming = True
    if lines:
        print('\n'.join(lines))
    elif not quiet:
        print('✓ 試験の版: 全資格がアプリと一致')
    return 1 if old else 2 if upcoming else 0


if __name__ == '__main__':
    sys.exit(main())
