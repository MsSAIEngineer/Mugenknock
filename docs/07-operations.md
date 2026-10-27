# 07. 運用・自動化

**この章の内容は AWS 上ではなく開発者のローカルPC（WSL2）で動いている。**
`prompts/` は `.gitignore` 対象（ただし履歴上は追跡済み）で、ローカル運用専用。

## 7.1 全体像

**5時間ごとのピンは、このプロジェクトではなくユーザー共通のタイマー `claude-timer` が回している**
（2026-10-14〜。本体 `~/.local/share/claude-timer/`・独立した git リポジトリ・詳細はその `README.md`）。
mugenknock は `~/.config/claude-timer/hooks.d/mugenknock.conf` に「ピンの N 分前」のフックを登録しているだけ。
他のプロジェクトも同じ形でフックを登録できる。

```
        ~/.config/claude-timer/next_ping        ← 唯一の正（次回ピン時刻・全プロジェクト共通）
                          │ claude-timer sync が読む
   ┌────────────┬─────────┴──────┬──────────────┬──────────────────┐
   ▼            ▼                ▼              ▼                  ▼
hook-mugenknock-1  hook-mugenknock-2  prelog       ping             hook-mugenknock-maint-1   （mugenknock の常設タイマー）
(ピン30分前)        (ピン20分前)        (ピン1分前)   (ピン時刻)         (ピン10分後)               canary 23:50
妥当性検証          問題生成            /usage を     claude を起こし    サイト保守                 mode-reset 土03:00
02-check-validity   01-generate        usage.log に  /usage で次回      nightly-noai(日1回)
(最大1000問)        (累計1000問)        記録          時刻を決めて再仕込み daily-services-weekly(週1回)
```

- すべて **one-shot 絶対時刻タイマー**（`Persistent=true`）。PC停止中に逃した発火は次回起動時に走る
- **連鎖構造**: ピン（`claude-timer-ping`）が終わるたびに次回時刻を決め、自分とフックを仕込み直す
- 連鎖が切れると全部止まるので、`claude-timer-watchdog`（2時間おき）が保険で監視する

### なぜこの構成か

Claude のサブスクリプションは5時間単位でトークンが回復する。
**回復直前に残量を使い切る**のが最も効率的なので、ピン（＝回復時刻）の
30分前・20分前にフックを仕込んでトークンを消化している。これは意図的な設計。

以前は Fargate + EventBridge でこれを回していたが、課金を避けるため
**2026-09にローカル systemd へ全面移行**し、**2026-10-14 にピン部分をユーザー共通の `claude-timer` へ切り出した**
（ピンは5時間枠＝アカウント単位の資源で、プロジェクトに閉じる理由がないため）。

## 7.2 systemd user タイマー

`systemctl --user list-timers` で確認できる。

| ユニット | 起動 | 実行内容 |
|---|---|---|
| `claude-timer-ping` | 次回ピン時刻 | （共通）claude を起こし、`/usage` から次回時刻を決めて再仕込み |
| `claude-timer-prelog` | ピン1分前 | （共通）枠の終わり際の `/usage` を `~/.config/claude-timer/usage.log` に記録 |
| `claude-timer-watchdog` | 2時間おき | （共通）連鎖切れの検知・修復 |
| `claude-timer-hook-mugenknock-1` | ピン30分前 | `local-validity-hook-run.sh` — 妥当性検証（`02-check-validity -n 1000`） |
| `claude-timer-hook-mugenknock-2` | ピン25分前 | `local-followup-hook-run.sh` — 「もっと知りたい」質問の付与（`11-add-follow-up-questions.py -n 1000`・Haiku。2026-10-28〜） |
| `claude-timer-hook-mugenknock-3` | ピン20分前 | `local-generate-hook-run.sh` — 問題生成（`01-generate-questions --hard` を累計1000問まで繰り返す） |

フックの番号は `hooks.d/mugenknock.conf` の行順（`ct hooks list`）。`ct off` のとき（`hooks_enabled` が無いとき）は
conf の `require=` により仕込まれない。どちらのフックも
**締切は次のピンの3分前**で、`next_ping` から求める（`scripts/mk-hook-deadline.sh`。パスは claude-timer が
`CLAUDE_TIMER_NEXT_PING_FILE` で渡す）。発動時刻を conf で変えても締切が追従する。
ピンの直前に発動した場合（遅延起動など）は何もせずスキップする。
`next_ping` が読めないときだけ、発動からの先行分（検証30分・質問25分・生成20分）で代用する。
2つは並走し、トークンは共有する。1000問は「枠が尽きるまで止まらない」ための上限で、実際に処理できる
件数はトークンで決まる（検証は1回100〜150問程度）。

**検証が先、生成が後になった影響（2026-10-12〜）。** 以前は生成（30分前）→検証（15分前）で、同じ
サイクルで作った問題が同じサイクルのうちに検証・公開された。今は検証が先なので、生成した問題が公開
されるのは**次のサイクルの検証**（約5時間後）になる。未確認の問題は検証で最優先なので、そこで確実に拾われる。

| ユニット | 起動 | 実行内容 |
|---|---|---|
| `mugenknock-canary` | 毎日 23:50 | Playwright カナリアテスト → S3 |
| `mugenknock-nightly-noai` | **ピン+10分**（その日の最初・下記） | 夜間処理: 削除予定チェック → 通報是正 → 試験ガイド更新 → サービスカタログ更新 → **図鑑の廃止照合**（`05-check-daily-services.sh --lifecycle-only`）→ サイト掲載内容チェック（`10`・30日以内実行済みならスキップ）→ リリースノート（前日分）→ 資産のコミット → 抜き取り検査 → **本人の成績の同期（検証→本番。`scripts/sync-user-data.py`・下記）** → 日次レポート |
| `mugenknock-daily-services-weekly` | **ピン+10分**（前回から7日以上・毎日分の後） | 図鑑の新設サービス記事化（`04 -n 3`）→ 図鑑記事の体裁チェック（`05 -n 5`）。どちらも sonnet |

**サイト保守はトークン回復後に走らせる（2026-10-27〜）。** 上の2ユニットにタイマーは無い。
claude-timer のフック `~/.config/claude-timer/hooks.d/mugenknock-maint.conf`（`+10`）が
`scripts/local-maintenance-hook-run.sh` を呼び、毎日分はその日まだなら、週1回分は前回から7日以上なら
`systemctl --user start` する（実行済みの印は `~/.config/mugenknock/maintenance_daily_last` / `maintenance_weekly_last`）。
通常は夜間の最初のピン（0〜4時台）で走り、PC が止まっていた日は起動後の最初のピンで走る。
問題の検証・生成のスイッチ（`ct on/off`・`require=`）とは別ファイルにして、`ct off` でも保守は止まらないようにしている。

**夜間監査の部分再開（2026-10-27）。** トークン節約で止めた夜間バッチのうち、軽いサイト保守だけを上の2ユニットへ移した。
頻度は用途で決めた: リリースノートはコミットのある日しか claude を呼ばないので毎晩、サイト掲載内容チェックは
スクリプト内で月1回に絞られるので毎晩の一覧に置く、図鑑記事の体裁チェックは記事が週3件しか増えないので週1回。
**止めたままのもの**: 問題監査（`audit-questions-nightly`・opus・最大の消費元）、カナリア整合（`canary-coverage-check`・opus）、
改行チェック（`09`・問題の体裁でサイト保守ではない）、問題の検証・生成（hook-1/2 で別途稼働）。
| `mugenknock-mode-reset` | 土 03:00 | `ct` のモードを既定へ戻す |

**サービス図鑑の動向追従（2026-10-27〜）。** 図鑑のグリッドは `DailyServices` の記事そのもの。
- 新設・廃止の検知: `refresh-service-catalog-monthly.sh`（毎晩・`-n 12`・30日以内確認済みはスキップ）が
  AWS 公式の SSM サービス一覧を母集合に、新しいサービスを足し、各サービスの `status` を WebFetch で確認する。
- 廃止: 毎晩 `05 --lifecycle-only`（claude 不要）が、非 active の記事に警告を付け、30日後に削除する。
  active に戻れば警告を外す。`--dry-run` で DynamoDB を書き換えずに結果だけ見られる。
- 新設: 週1回 `04 -n 3` が、カタログで現行・`isArticleTarget` と確認済みの未掲載サービスを記事化する
  （トークン節約のため週1回・少数）。
- カタログには同じ名前のエントリが複数あることがある（例: 現行の AWS Transform と、Migration Hub が
  AWS Transform へ改名されたことを表すエントリ）。04・05 とも「active と renamed なら active、それ以外は
  `lastVerifiedAt` が新しい方」で 1 つに決めてから判定する（後勝ちで現行サービスに警告が付いた実例あり）。
- 結果は日次レポートの「日めくり 生成/検証」に載る（`prompts/logs/nscript_04-…`/`nscript_05-…` を読む）。
- 図鑑から記事を消すと（廃止の猶予切れ・体裁チェックでの delete）、05 が `state/daily-service-removals.jsonl` に
  日付・名前・理由を追記する。`generate-release-note.sh` はその日の削除があれば本文に決まった文
  （「サービス図鑑から次のサービスを削除しました: …」）を必ず足す。コミットが無い日・ユーザー向けの変更が無い日でも、
  削除があれば削除だけのリリースノートを作る。重複記事の整理（0.5）は図鑑からサービスが消えないので記録しない。
- 夜間バッチ（下表）からは外したまま。体裁チェック（05 の後段）は週次ユニットで回す。

**夜間バッチ（`local-postping-run.sh`・ピン+10分）は登録していない**（トークン節約のため停止中）。
conf にコメントアウトした行があり、`#` を外して `ct sync` すれば再開する。基準は**直前のピン**の+10分で、
そのピンが 0〜4時台なら夜間サイクルとして夜間バッチを実行する。
> 旧構成の `mugenknock-postping` は「次回ピン+10分」に仕込んでいたため、ピンのたびに先送りされて
> **2026-10-06 を最後に一度も発火していなかった**（夜間バッチが止まっていた実際の原因）。claude-timer では
> ピン後のフックを直前のピン基準で仕込むので、この問題は起きない。

### 制御コマンド `ct`（`scripts/ct.sh`）

`ct` は claude-timer の mugenknock 用の窓口。ピン関連の操作は claude-timer に委ねる。

```bash
ct              # 状況表示（claude-timer の状態 + mugenknock のフック）
ct on / off     # mugenknock のフックの有効・無効。ピンは常時
ct set HH:MM    # 次回ピン時刻を変更（= claude-timer set。以降は /usage の回復時刻に自動追従）
ct cancel       # 完全停止（= claude-timer cancel。**全プロジェクト共通のピンが止まる**）
ct resume       # 再開（次回 = now+5h）
ct sync         # 時計に合わせてタイマー再同期（= claude-timer sync）
ct skip         # 次回の mugenknock のフックだけスキップ
ct run          # 今すぐピン実行（= claude-timer run）
ct log [-f|-n|-d DATE]   # ピン履歴（claude-timer）/ -n 夜間 / -d 日付
ct hooks list / add <分前> <スクリプト> [ラベル] / rm <#> / edit
```

ファイル:
- `~/.config/claude-timer/hooks.d/mugenknock.conf` — フック定義（`符号付き分|スクリプト|ラベル`）。`ct hooks` が読み書きする
- `~/.config/mugenknock/hooks_enabled` — `ct on/off`（mugenknock のフックのみ切替）
- `~/.config/claude-timer/disabled` — `ct cancel`（完全停止）
- `~/.config/claude-timer/usage.log` — 使用量ログ（旧パス `~/.config/mugenknock/usage.log` はシンボリックリンク）。
  集計は `claude-timer report`
- `~/.config/claude-timer/mail.conf` → `~/.mugenknock_mail.conf`（ピン失敗の通知メール）

### 夜間バッチのファイルの置き場（2026-10-27〜）

**手元（git の作業ツリー）が唯一の正。** 以前は Fargate と共有するため、状態・生成指示・認証情報を
S3 バケット `mugenknock-fargate-state-<accountId>` と pull → 実行 → push で双方向同期していた。
手元だけで動かす今は不要なうえ、手で直した `instructions` が次の実行で S3 の内容に巻き戻る原因だったので廃止した。
Claude の認証情報（OAuth）を S3 に上げるのもやめ、S3 の写しは削除済み。

| 種類 | ファイル | 扱い |
|---|---|---|
| 改良される資産 | `instructions/*.txt`・`state/service-catalog.json`・そこから作る `src/data/originalInstructions.ts` | git で追跡。バッチ自身が `scripts/commit-night-assets.sh` で develop に `chore(night):` のコミットを作る |
| 実行状態 | `state/` のそれ以外（`question_counts.json`・`last_domain_idx.json`・`daily-service-removals.jsonl` 等） | gitignore（追跡しない） |

`commit-night-assets.sh` は、保守の毎日分（`mugenknock-nightly-noai` の 8/11）と、検証・生成フックの終わりに走る。

- develop にいるときだけ動く。
- 対象ファイルだけを `git commit --only` でコミットする。人がステージ中のものは巻き込まない。
- push は、origin/develop の上に自分のコミットが1つ乗っただけのときに限る。手元に未 push の別コミットがあれば push しない。
- `chore(night):` のコミットはリリースノートの対象外（`generate-release-note.sh` が除く）。

S3 のバケットに残るのは、ログ（`night-logs/`・`run-logs/`）、実行メタ（`meta/`）、canary の結果、レポートの送信済みマーカー（`report-sent/`）だけ。
`.last_run_date` は二重実行防止の要なので、盲目的に上書きしない（`local-night-run.sh`）。

### サイトのビルドを走らせるパス（Cloudflare Pages の Build watch paths）

運用だけの push ではビルドしない。プロジェクト `mugenknock` の `path_excludes`（本番・検証共通）:
`docs/*` `specs/*` `e2e/*` `lambda/*` `*.md` `*.sh` `*.py` `prompts/logs/*` `prompts/scripts/*`
`prompts/night-prompts/logs/*` `prompts/night-prompts/e2e/*` `prompts/night-prompts/manual/*`
`prompts/night-prompts/texts/*` `prompts/night-prompts/scripts/state/*`。
**`instructions/` はビルドが読む（`originalInstructions.ts` の元）ので除外しない。**
除外は include より先に判定されるため、`prompts/*` のように丸ごと除外すると `instructions/` まで外れる。
新しくビルドが読むファイルを `prompts/` や `scripts/` に置くときは、この一覧に掛からないか確認する。

## 7.3 夜間バッチ

`prompts/night-scripts.list` が実行順の唯一の正。形式は `遅延分数,フルパス`。

| 遅延 | スクリプト | 内容 | claude |
|---|---|---|---|
| 0 | `99-send-report.sh` | 日次稼働レポートをメール送信 | ✅ |
| 0 | `check-scheduled-deletions.sh` | 予約削除日を過ぎた問題を削除 | ❌ 決定的 |
| 15 | `03-check-reports.sh` | ユーザー通報の精査（ok/fix/delete + 関連問題） | ✅ |
| ~~15~~ | ~~`02-check-validity.sh`~~ | **一時停止中**（2026-06-29〜・トークン枯渇のため） | ✅ |
| ~~20~~ | ~~`01-generate-questions-hard.sh`~~ | **一時停止中**（同上） | ✅ |
| 40 | `refresh-exam-guide-monthly.sh` | 公式試験ガイドの更新（30日以内はスキップ） | ✅ WebFetch |
| 45 | `refresh-service-catalog-monthly.sh` | サービスカタログ更新（30日以内スキップ・`-n 12` で有界） | ✅ WebFetch |
| 47 | `10-check-site-content.sh` | サイト掲載内容（問題以外）の現行性チェック（30日スキップ・検知のみ） | 一部 ✅ WebFetch |
| 50 | `05-check-daily-services.sh` | 日めくり記事の廃止照合＋体裁チェック（廃止照合だけは nightly-noai で毎晩実行） | 一部 ✅ |
| 55 | `04-generate-daily-services.sh` | 日めくり記事の生成（週1回 `-n 3` は daily-services-weekly で実行） | ✅ |
| 58 | `09-check-linebreaks.sh` | 改行整形（Haiku） | ✅ |
| 60 | `audit-questions-nightly.sh` | 問題品質監査＋**生成/検証プロンプトの自動改良** | ✅ opus |
| 60 | `generate-release-note.sh` | 前日のgitコミットからリリースノート生成 → `Releases` | ✅ |
| 65 | `canary-coverage-check.sh` | カナリアtestとサイト構成の整合性チェック・spec自動更新 | ✅ opus |

> `generate-release-note.sh` は元々 delay=0（サイクル開始直後）だったが、他のタスクと
> 同時に Claude API へ集中し `529 Overloaded` で失敗しやすく、失敗すると自己修復されず
> その日のノートが恒久欠落していた（2026-09-15、本節末尾のトラブルシューティング参照）。
> 夜間監査と同じ 60 分待ちに移し、サイクル開始直後の混雑を避けるようにした。

> **01/02 が一時停止中**である点に注意。再開するには `night-scripts.list` の該当2行の
> 先頭 `#` を外す。ただし01/02はフック（hook-1 検証 / hook-2 生成。ピン前）でも走っているため、
> 夜間バッチからは外して**フック側に寄せている**というのが現在の構成。

> **夜間バッチ自体（postping 経由）も 2026-09 以降、トークン節約のため意図的に止めている。**
> 動いているのは hook-1（02 検証）と hook-2（01 生成）だけ。監査による `_common-rules.txt` /
> `_validity-extra.txt` の自動改良、試験ガイドの月次更新、日次レポートも止まっている。

### 問題の品質ゲート

```
01-generate-questions   生成 → 重複判定（決定的）→ Questions に投入（validityCheckedAt なし = 非公開）
        ↓
02-check-validity       事実正確性を検証
        ├ 問題なし → validityCheckedAt を付与（= 公開される）
        ├ 問題あり → 自動修正 or fixProposalJson を残す
        └ 致命的   → DB から削除
        ↓
09-check-linebreaks     改行のみ整形（Haiku）
        └ 非空白文字が1文字でも変化したら fix を破棄（決定的ガード）
        ↓
audit-questions         監査。事実誤りではない指摘（易しすぎ・模試不適）は
                        auditNote に記録 → 管理画面「スキャン結果」で人が判断
                        systemic な問題があれば 01/02 のプロンプト自体を最小限追記で改良
```

### 生成（01）の資格選定・配分・重複対策（2026-10-12〜）

hook-2 は `01-generate-questions.sh -H -n 1000 -D <回復3分前>` を、**締切か累計1000問まで繰り返し**呼ぶ
（1回は1ドメイン20問までで終わるため。繰り返すたびに資格は選び直され、既出一覧も作り直される。
1回が異常終了・取込0件なら止まる）。

**資格の選び方（問題数が最少の資格）。** 毎回 DynamoDB から資格ごとの問題数を取り、最少のものを選ぶ
（同数なら `EXAM_TYPES` の並び順で先のもの）。ログに全資格の問題数と解答数が出る（解答数は参考表示だけで、
選定には使わない）。

> 2026-10-12 に一度「需要比（解答数/問題数）が最大の資格」へ変えたが、CLF・SAA に偏るため、同日中に
> 問題数が最少の方式へ戻した（本人の判断）。需要で絞る案の根拠は、全5,449問に対し総解答1,564回で、
> CLF・SAA が需要の53%、DB/NW/SEC/ML の435問は解答0回の資格に使われた、という調査結果。
> 再び需要を見る場合は、`git show 9353b19:prompts/night-prompts/scripts/01-generate-questions.sh` の
> 選定部分（`GEN_MIN_POOL` / `GEN_DEMAND_PRIOR` / `GEN_SKIP_BELOW_RATIO`）が参考になる。

**1ドメインの上限。** 1回の実行で1ドメインに割り当てる数は `GEN_DOMAIN_CAP`（既定20）まで。
以前は上限が無く、600問の予算が最少の1ドメインに集中して「2問×57回」同じプロンプトで生成していた。
上限を超えた予算は使わない（残ったトークンは検証(02)に回る）。

**1回5問（`GEN_CHUNK_SIZE`）。** 以前は SAP/ANS 等を3問、`--hard` でさらに半減（2問・SAA 等は1問）に
していた。呼び出しごとに資格別の指示書（最大約1万字）と共通ルールを送り直すので、問題数が少ないほど
1問あたりの入力が増える。半減の根拠（1チャンク300〜700秒）は 2026-10 時点で当てはまらない
（5問で約54秒）。出力は1問ずつ即インポートするので、途中で止まっても失うのは書きかけの1問だけ。

**重複対策（`question-dedup.py`・Claude 不要）。** 2026-10-12 の調査で、直近435問の31%にほぼ同じ問題が
あった（DB「SQL・クエリ」60問中16問が NOT EXISTS の反結合、NW に一字一句同じ問題が2問）。原因は
01 が既存問題をプロンプトに渡さず、独立した呼び出しを同じプロンプトで繰り返していたこと。02 は他の
問題を見ないので素通りしていた。今は次の2段で防ぐ。

- **プロンプトに既出の決め手を渡す（被りを減らす）。** 対象ドメインの既存問題の正解肢（新しい順・最大
  `GEN_AVOID_MAX`=60件・各50字）を入れ、一覧に無い概念を優先させる。今回の実行で取り込んだ分も
  追記されるので、後のチャンクほど避ける対象が増える。頻出論点を別の角度で問うのは可としている。
- **取り込み前に完全一致だけを弾く。** 同じ資格の全問題と比べ、問題文の文字3-gram Jaccard ≥ 0.9 なら
  `[DUP]` として破棄する。**頻出論点の決め手が被るのは許容する**（本人と決めた方針・2026-10-12）ので、
  正解肢が同じだけ・言い換えだけの問題は弾かない。全5,449問で 0.9 以上は33組で、30組は一字一句同じ、
  残り3組も助詞・句読点が違うだけだった。

**正解を最長にする指定は約6%。** 以前は約25%の問題で「正解を最長に」と指定していたが、実測で正解が
単独最長になった割合は39%（4択の偶然は25%）。指定しない問題でも約19%が最長になっていたため、指定を
約6%に下げ、合計が偶然と同程度になるようにした。**次の生成分で割合を測って調整すること。**
測り方は `python3 prompts/night-prompts/scripts/measure-answer-length.py --since <変更後の日付>`
（読み取りのみ・Claude 不要）。25% を大きく超えるなら 01 の `RANDOM % 16 -lt 1` を 0 に、大きく下回るなら増やす。

**`--hard` のペア構成は SAP/DOP/ANS/SCS だけ。** 検証側の追加観点もこの4資格だけを想定している。

**終了時刻はチャンクごとに見る。** 以前はドメインの頭でしか見ておらず、終了時刻を過ぎても走り続けて
ラッパーに強制終了され、末尾の処理（キャッシュ再構築・S3 同期・再ビルド予約）が飛んでいた。
ID トークン（有効1時間）が切れて取り込みが 401 になったときは、1回だけ取り直して再送する。

**管理画面の「AIプロンプト生成」も同じ指示書を使う。** `scripts/gen-original-instructions.mjs` が
全資格の `instructions/*.txt` と `_common-rules.txt` を `src/data/originalInstructions.ts` に書き出す
（prebuild で自動実行）。以前はオリジナルカードだけが対象で、AWS 資格には試験ガイド概要・難易度が入らず、
画面側の「解説150字以上」「選択肢別解説100〜150字」「選択肢は必ず4つ」が共通ルール（120字以内・80字以内・
複数正解は5択）と矛盾していた。Cloudflare のビルドはコミット済みの `.txt` から生成する点に注意。

**試していないこと。** 指示書の試験ガイド部分を対象ドメインだけに絞る案は、資格ごとに見出しの形式が
ばらばらで（第Nドメイン／コンテンツ分野N／第N分野）、SOA は指示書のドメイン数（6）がマスタ（5）と
合わず誤対応の危険があるので見送った。

### 検証（02）の方針

**本質（事実・正確性・整合）に集中し、体裁は無視する**（トークン削減）。
体裁は 09（Haiku）が担当。ただし**選択肢長（正解が最長にならないようにする）のルールは継続**。
この方針は自動改良（audit の `-i`）で崩されないよう明示されている。

### 夜間スクリプトの MCP（`--strict-mcp-config`）

夜間バッチ・hook から呼ぶ `claude -p`（16ファイル・30箇所）は、すべて `--strict-mcp-config` を付けている。
付けないと、ユーザー/ローカルスコープの MCP（Playwright・Context7・AWS Docs）と claude.ai コネクタ
（Gmail・Drive・Calendar・Notion）に、起動のたびに接続する（最大2.3秒）。さらに `--tools` を指定しない
スクリプト（翻訳・体裁・リリースノート等）では、**MCP ツールがモデルに渡り、呼べる状態になる**（実測）。

AWS の最新情報を引くスクリプト（02検証・監査・サービスカタログ更新・日次レポート）だけ、
`prompts/night-prompts/scripts/mcp-aws-docs.json` の AWS ドキュメント MCP を許可している。
詳細な書式と、`ToolSearch` が必須な理由は CLAUDE.md の「MCP: 全ての `claude -p` に
`--strict-mcp-config` を付ける」。02 の検証プロンプトにも、WebFetch と並べて MCP の案内がある
（確認は合わせてチャンクあたり最大2回の上限は維持）。

**権限を絞った設計は保たれている**ことを、`--tools WebFetch,ToolSearch` の構成で実測した:
Bash は動かず（ファイルが作られない）、Read で秘密ファイルを読ませても `NO_READ`、
Playwright・Notion・Gmail 等は存在しない（`NONE`）。

### 検証（02）のチャンクと追加観点の絞り込み（2026-10-12〜）

- **フックは `-n 1000`。** 選定で Jev に掛けるプールは `JEV_TRIAGE_POOL_MAX`（既定360）で切る。
  slots×倍率（3000問）にすると Jev の予算（120秒≒700問）で途中までしかスコアが付かず、スコア無しが
  最優先になって事実上「古い順」に戻るため。実際に処理される先頭部分（100〜150問）を確実にスコア化する。
  実測: 360問のスコア化が56秒・$0.10。選定結果は 未確認60問 → スコア付き360問（バンド順）→ 残り（古い順）。
- **1チャンク10問（`VALIDITY_CHUNK_SIZE`）。** 共通ヘッダ（確認観点・追加観点・出力形式）を毎回送り直す
  ので、5問だと入力の6割以上がヘッダだった（ヘッダ9,112字・問題5,594字・入力約1.9万トークン）。
- **同じ資格の問題を同じチャンクにまとめる**（未確認の問題は必ず確認済みより先。終了時刻で打ち切られても新規問題の公開を遅らせない）。 ドメイン表と追加観点は、チャンクにある資格のぶんだけ入れる。
- **追加観点の資格タグ。** `_validity-extra.txt` の `- {AIF,MLA} [fix] …` のようにタグを付けた行は、
  チャンクにその資格があるときだけ入る（`{AWS}` は ML/DB/NW/SEC 以外）。タグの無い行は全チャンクに入る。
  ファイル先頭の `#` 行（説明）は入れない。**監査（audit -i）を再開するときは注意**: 監査の自動改良は
このタグを知らないので、書き換えでタグを消すと、その行は全チャンクに入る（安全側だがトークンは増える）。DB/NW 等のチャンクでヘッダは9,112字→約6,100字。
- **実測（誤りを仕込んだテスト・Claude 1回ずつ）。** 5問チャンク（誤り3問）も10問チャンク（DB・誤り3問）も、
  仕込んだ誤りをすべて検出し、正常な問題はすべて ok だった。1問あたりの費用（API 換算）は
  $0.019 → $0.010。チャンクあたりの WebFetch / MCP 上限（2回）は据え置きなので、1問あたりの外部確認は減る。
- `action=fix` なのに修正内容が空のときは、確認済みにせず次回に回す（以前は ok 扱いで公開していた）。

### 検証（02）の構造チェックは Python（Claude に見させない）

「正解と選択肢の完全一致」「isMultiple の整合」「選択肢別解説の件数」は、**前処理（Python）で
確定的に判定**する。以前は検証プロンプトの確認観点に入れ、毎回モデルに確認させていた。
全4,894問で違反0件（2026-10-01 実測）で、モデルに見させる意味がなかった。

- 前処理が違反のある問題にだけ `_struct` を付け、プロンプトには「構造チェック: …」行として出る。
  違反のない問題は何も付かず、モデルは構造を再確認しない。
- 違反を含むチャンクにだけ「【構造チェックの直し方】」の節が入る（違反は稀なので、大半のチャンクでは入らない）。
- `_struct` は DB へは書かれない（`_jev` と同じ。DB更新は Claude の `fix` の値だけ）。
- **「内容の対応」（`choiceExplanations[i]` が `choices[i]` を説明しているか）は意味判断なので Claude に残した。**
  機械チェックするのは件数だけ。
- 判定ロジックは違反を実際に捉えることを、意図的に壊した12ケース（記号接頭辞・範囲外・件数ずれ・
  isMultiple 不整合など）で確認済み。検証中に「同じ原因を二重に報告する」不具合があり、
  文字列一致が取れているときだけ index との食い違いを見るように直した。

**効果は未測定。** プロンプト長は違反のないチャンクで約5%減（4,674→4,456文字）にとどまる。入力の主役は
問題本文なので想定どおり。狙いは「モデルが見る観点が減って1問あたりの推論時間が下がること」だが、
これは Claude を回さないと分からない。**次の実行ログの `経過=` 秒（修正0件のチャンクで以前は中央値198秒）と
比べて確認すること。**

### 検証（02）の選定順位と Jev トリアージ

02 はトークン律速で全問回せないため、**Jev で「欠陥がありそうな順」に並べ替えてから
Claude に渡す**（`jev-triage.py`）。2026-09-30 導入。

```
① 未確認（validityCheckedAt なし）を常に最優先・古い順
   └ 未確認はアプリ非公開。公開までの時間を最短にすることが最優先
   └ 未確認だけでバッチが埋まるなら Jev を呼ばない（費用ゼロ）
        ↓ 残り枠があれば
② 確認済みから プール = 古い順の上位（残り枠×倍率・既定3倍）を Jev がスコア化
   └ スコアのバンド（既定0.25刻み＝5段階）降順 → 同一バンド内は確認日の古い順
        ↓
   残り枠の分だけ Claude へ（Claude に渡す総数は従来と同じ）
```

| 項目 | 値 |
|---|---|
| 指標 | `hint_leak`（選択肢の括弧補足によるヒント漏れ）の noul 確率。**1質問・選択肢だけを state に渡す** |
| 実測 AUC | 0.82（探索188件＋未見186件をプール、CI は下記）。`jev-triage.py` 実物を未見データで測って 0.833 |
| 効果 | 1バッチあたりの欠陥検出が **約1.7〜1.8倍**（帯幅0.25。連続値なら 1.8〜1.9倍） |
| コスト | **1問 $0.0003** / 実際に検証する1問あたり $0.0009（倍率3のとき）。30問バッチで約 $0.03 |
| 無効化 | `--no-triage` または `-T 1`（環境変数 `JEV_TRIAGE_POOL=1`） |
| バンド幅 | `JEV_TRIAGE_BAND`（既定 0.25＝疑わしさ5段階） |

**これはゲートではなく優先順位付け**である点が重要。スコアが低い問題もプールに残り
続け、後日のバッチで必ず処理されるので、Jev の取り逃しが品質低下に直結しない。
プールを「古い順の上位 N×倍率」で切っているのは、全体をスコア順にすると低スコアの
問題が永久に選ばれない**飢餓**が起きるため。

スコアをバンドに丸めるのは、連続値のままだと 0.94 と 0.93 の差で順序が決まって
日付がまったく効かなくなるため。**同程度に疑わしいものの中では古いものから処理する。**

> **Jev のスコアは非決定的。** 同一入力の2回実行で差は中央値 0.010・最大 0.110（n=24）。
> 順位は run ごとに多少揺れる。優先順位付けなので実害はないが、バンドを細かく刻むほど
> ノイズで順序が入れ替わるだけで日付が効かなくなる。実測でバンドが変わる率は
> **0.1→17% / 0.2→12% / 0.25→4%**。5段階（0.25）は「同程度に疑わしいものの中では
> 古い順」を安定して成立させられる最小の粗さなのでこれを既定にしている。
> スコアをより強く効かせたい場合は `JEV_TRIAGE_BAND` を小さくする。

#### Jev スコアを Claude のプロンプトに渡す

Jev が判定した問題には、そのスコアを検証プロンプトへ渡す（「どのくらい怪しいか」の
手掛かり）。渡すのは **Jev が実際に判定した問題だけ**で、未確認の問題や Jev 失敗時は
何も付かない（プロンプトは従来と完全に同一）。

```
ID: dva-xxxx
試験: DVA
…
Jev事前スコア（0=問題なし寄り〜1=疑わしい）: 選択肢ヒント漏れ 0.9
```

スコアが付いた問題を含むチャンクにだけ、ヘッダへ読み方の注意書き（【Jev事前スコアの読み方】）
を入れる。要点は次のとおり。

- **何のスコアかを明示する。** 渡すのはヒント漏れ（選択肢の括弧補足）だけを見たスコア。
  事実誤り・正解の当否・解説のズレ・ドメインは Jev が一切見ていないと注意書きに書く。
- **「低スコア＝問題なし」と読ませない。** Jev は正解の当否（AUC 0.47）や解説のズレを判定
  できない。低スコアを理由に確認を省かれると、Jev が見逃す種類の欠陥がそのまま素通りする。
  注意書きで「確認観点は全問で通常どおり」「高スコアだけで fix しない」と明示している。
- **小数1桁に丸める。** スコアは同一入力でも最大0.1程度揺れるので、それ以上の桁は偽の精度。

実装: `jev-triage.py` が `{qid: {score, hint_leak}}` を返し、02 の選定処理が
`score` で並べ替えたうえで値を問題の `_jev` に付ける。`_jev` は DB へは書かれない
（DB更新は Claude の `fix` の値だけを使うため）。

> **未検証の点**: このスコアを渡すことで Claude の判定が良くなるか（見るべき所に集中できるか）、
> 悪くなるか（低スコアに引きずられて見逃すか）は、まだ実測していない。注意書きは後者を
> 防ぐ意図で書いたが、効果は Claude を実際に回した A/B でしか分からない。

バンド境界の計算には `+1e-9` を入れている。`int(0.70 / 0.1)` は浮動小数点誤差で
`6`（6.999…の切り捨て）になり、バンドが1つ下にずれるため。

**Jev が落ちても検証は止まらない。** APIキー未設定・通信不能・レスポンス不正・
予算超過（既定120秒）のいずれでもスコアを空で返し、従来どおり古い順で処理する。
ロックは取らずに実行する（ネットワークI/O中に flock を保持すると並列 run を止めるため）。

#### Jev に任せられること / 任せられないこと

`jev-validity-eval.py` の実測（2026-09-30・AUC）に基づく。**修正は必ず Claude が行う。**

| 観点 | AUC | 扱い |
|---|---|---|
| 選択肢への略語展開・定義説明の混入 | 0.82 | ✅ triage に採用（1質問・選択肢のみ） |
| 解説の事実誤り | 0.64 | ❌ 弱く、hint_leak に足しても改善しない（外した） |
| 選択肢別解説のズレ | 0.750 | ❌ 高精度だが R=0.40 で低再現 |
| 正解の当否 | **0.473** | ❌ ランダム同等。Jev には判定できない |
| 「何か問題があるか」（曖昧な単一質問） | **0.425** | ❌ ランダム以下 |
| ドメイン誤り | ― | ❌ 真の誤分類への一致率85%・誤検出 P=0.286 |

踏んだ落とし穴（再発防止）:

- **曖昧な質問は機能しない。** 「何か問題があるか」は AUC 0.425 でランダム以下だった。
  質問は「何をどう見るか」まで具体化し、`criteria` で true/false の意味を示す。
- **ドメイン誤りの AUC 1.000 はラベルリークだった。** domain 修正66件のうち62件は
  `None → int`（未設定の補完）で、Jev は「フィールドが空」を検出していただけ。
  未設定の検出は Python でやる。
- **質問を1コールに詰める・不要な state を渡すと各回答が希釈される。** 2質問＋全 state の
  0.776 に対し、1質問＋選択肢のみなら 0.819（差 +0.043 [+0.011, +0.075]）。triage は後者にして
  いる。（初期に見た「6質問詰め込みで 0.574」は n=20 の値で誤差が大きく、過大だった）
- **正規表現は検出はできるが修正はできない。** 実際の before→after 148件で機械的な
  括弧除去の選択肢単位一致率は 72.6%。`(12 shards)` のような技術的な量は保持すべきで、
  逆に「用語（略語）：定義文」は括弧を残して定義文だけ削るのが正しい。機械適用すると
  半数超を壊すため、**fix は必ず Claude**。

#### 精度改善の追試（2026-09-30・効かなかったものを含む）

最初の実装（AUC 0.775）は n=45 で測った値で、95%CI が ±0.1 と広かった。n=約190 に増やし、
改善案を試した。**事後に多数の候補を見ているので、最終候補は事前に1つに固定し、まだ見て
いない別サンプルで現行と比較した。**

| 試したこと | 結果 |
|---|---|
| 質問を分離し state を絞る | ✅ **+0.043 [+0.011, +0.075]**。探索・未見の両方で同じ +0.042 が再現 |
| 同じ入力を2回呼んで平均 | ❌ ΔAUC −0.005。非決定性は精度のボトルネックではない |
| 実データの修正前後から作った few-shot 例 | ❌ 単独コールと同等（0.795 対 0.803） |
| `choice` タイプ（clean / legit / leak の3択） | ❌ 0.775。noul より良くならなかった |
| `factual_error` を加える | ❌ 改善なし（max で 0.795 < 0.803） |
| 略語未展開を見る質問（abbr）を加える | ❌ **探索 0.68 → 未見 0.54**。事後選択で見えた偽の改善 |
| 正規表現の括弧率との平均 | ❌ 未見で −0.006。正規表現単独は 0.76 で Jev 合成と同等 |
| 決定的特徴＋Jev のロジスティック回帰 | ❌ 一時 +0.127 と出たが、下の水増しを除くと有意でなかった |

生データ・再現スクリプトは `prompts/night-prompts/scripts/jev-experiments/2026-09-30/` に保存してある
（保存済みスコアだけで数値を再現でき、Jev を呼ばず費用もかからない。README 参照）。

落とし穴が2つあった:

- **domain 補完の正例が評価を歪める。** 正例の約13%は「ドメイン未設定の補完（`None→int`）」
  が修正理由で、本番のプールにはもう存在しない欠陥種。Jev には domain が見えず不当に低く出る
  一方、決定的特徴（`domain_missing`）には自明で不当に高く出る。除外して測る
  （`jev-validity-eval.py` の既定）。
- **帯幅0.25は効率を少し落とす。** 連続値 1.82 に対し帯0.25で 1.67（未見では 1.92 対 1.84）。
  「同程度に疑わしいものの中で古い順」を成立させるための設計上の代償。精度の面では
  粗くする必要はない（ノイズを均しても AUC は変わらないため）ので、日付優先を弱めてよければ
  `JEV_TRIAGE_BAND=0.1` で連続値とほぼ同じ効率になる。

### 「もっと知りたい」質問の付与（11。2026-10-28〜・specs/009）

`prompts/night-prompts/scripts/11-add-follow-up-questions.py`。演習画面で回答後に出す質問（利用者が自分の AI に聞く用）を Questions に付ける。
使い切りモードのフック（ピン25分前）で動き、手動ではエイリアス `afq`（`afq -n 50 [-c 10] [-D HH:MM] [--dry-run]`）。

- **1周で1問1つ・最大3つ。** 有効な質問が少ない問題から順に付ける（全問が1つになってから2つ目へ）。
- 角度は `term`（他の選択肢の用語）/ `diff`（正解と他の違い・使い分け）/ `whatif`（条件が違ったら）/ `why`（仕組み）/ `limits`（制限・料金・注意点）。
  1問の中で重ねない。偏らないよう、問題ごとにまだ使っていない角度をランダムに勧め、合わないときだけモデルが別の角度を選ぶ。
- モデルは Haiku（`--tools "" --strict-mcp-config`）。書く前に機械的に検査する（1行・12〜120文字・「？」で終わる・「この問題」「選択肢」等で問題を指さない・
  オリジナル資格は AWS/Amazon を含まない・角度の重複なし）。
- 作ったときの選択肢のハッシュを `followUpBasis` に残す。02 や管理画面で選択肢が直されたら、画面は古い質問を出さず、次の付与で捨てて付け直す。
  書き込みは条件 `choices = :ch` 付き。
- **質の低い質問は検証（02）が外す。** 02 は問題と一緒に ASK AI 質問も読み、問題と無関係・前提が誤っている・意味が通らない・それだけで意味が通らない・答えが自明な質問だけ `followUpDrop:[番号]` で外す（action とは独立。言い回しの好みでは外さない）。外すだけで書き直さない。数が減るので、11 が次の周で別の角度で作り直す。ログは `[ASKAI]`。

### 通報チェック（03）の多層防御

ユーザー通報は攻撃面になり得るため:

1. **ブロックリスト** — `report-blocklist.txt` の userId は入口で破棄
2. **コメント無害化** — デリミタ突破除去・長さ制限のうえ「信頼できない手掛かり」として提示
3. **モデル権限ゼロ** — claude を `--tools ""` で起動（ファイル/コマンド/UIへのアクセス不可）
4. **適用スコープ限定** — 書込みは提示 questionId の問題内容5フィールドのみ
5. **暴走遮断** — 1実行あたりの削除数に上限（`REPORT_MAX_DELETES`）

### トークン運用

- 夜間バッチのスループットは**トークン律速**。並列化は不可、チャンク拡大とツール制限で効率化する
- 検証(02)は**同じトークン量でより多くの欠陥を見つける**方向で効率化する（上記 Jev トリアージ）。
  Claude に渡す本数は変えず、渡す順番を Jev で最適化する
- 監査は `n=15 / c=8`（opus 呼び出し2回/晩）。以前は `n=30 / c=5`（6回/晩）で消費が大きかった
- 使い切りモード（`ct on`）は**週間の残りから自動で入る**（2026-10-27〜）。ピン+3分のフック
  `scripts/local-autoburn-hook-run.sh`（`hooks.d/mugenknock-autoburn.conf`）が、ピンのたびに
  「残り% ≧ 週リセットまでのピン数 × 1枠の週間消費 × 安全率0.8」を判定し、満たしたら `ct on`。
  1枠の週間消費は `usage.log` の直近4週の実績（満タン1枠あたり約8%。取れなければ8.5%）。
  いったん入ったら土曜03:00 の `mode-reset` まで切らない。止めるときは `~/.config/mugenknock/autoburn_disabled` を作る
- 生成は安く、**検証ゲートにだけ WebFetch を残す**方針

### 人の確認（2026-10-28〜。docs/10-ops-review.md 4.1〜4.4）

AI の判断を人が確かめる経路。管理画面「スキャン結果」の「人の確認待ち」に集まり、日次レポートの「0. 人の確認待ち」に件数と一番古い日付が出る。

| 入口 | 何が入るか | 処理 |
|---|---|---|
| 検証（02）が正解を変えようとした | 修正案（`fixProposalJson`）。問題は非表示 | 適用 / 却下 |
| 検証（02）が削除を提案した | 問題を非表示にするだけ（消さない） | 問題なし（表示に戻す）/ 誤りあり（直すか消す） |
| 抜き取り検査（`sample-human-review.py`、保守の毎日分 9/11） | 28日ごとに20問。半分は直近30日に作成・修正された問題 | 問題なし / 誤りあり。不良率を日次レポートに出す |
| 過去分（一度だけ `--mark-past`） | 2026-10-27 以前に AI が人の確認なしで正解を変えた問題 | 問題なし / 誤りあり |

- 文言だけの修正（正解の位置が同じ）は、これまでどおり自動で反映する。
- 監査（`audit-questions.sh -i`）の生成指示の改良は、**既定で提案のみ**（改良レポートに出すだけで `instructions/` は書き換えない）。
  従来どおり自動で書き換えるときだけ `AUDIT_APPLY_INSTRUCTIONS=1`。
- 生成指示が変わった日は、日次レポートにそのコミットが出る。

### 生存の見張り（2026-10-28〜）

保守の毎日分（`mugenknock-nightly-noai`）の最後に、CloudWatch のメトリクス `Mugenknock/NightlyHeartbeat` を1送る。
アラーム `mugenknock-nightly-stopped` が、**2日続けて届かない**と SNS トピック `mugenknock-heartbeat-alarm` からメールする
（PC 停止・claude-timer の連鎖切れ・フック外れを疑う）。費用は月 約$0.4。

### 夜間バッチの管理 API 認証（2026-10-28〜）

夜間バッチは**専用ユーザー**と**専用アプリクライアント**でログインする（`scripts/batch-id-token.sh`。
SSM `/quiz-app/batch-username`・`/quiz-app/batch-password`・`/quiz-app/batch-client-id`）。
`USER_PASSWORD_AUTH` はこのクライアントだけで有効。人の管理者アカウントは2段階認証（TOTP）を付けるので、バッチでは使わない。

### CI

`.github/workflows/ci.yml` が develop・master への push のたびに `tsc --noEmit`・`lint:tokens`・`node --test 'lambda/test/*.test.js'` を走らせる
（docs・specs・`*.md` だけの変更では走らない）。デプロイはしない。

## 7.4 デプロイ・確認スクリプト

| スクリプト | 用途 |
|---|---|
| `scripts/deploy-lambda.sh [dev\|prod\|status\|rollback <env> [版]]` | Lambda デプロイ（引数なしはブランチから判定）。`lambda/test` が通ってから版を切り、エイリアス `live` を向ける。`rollback` で1つ前の版へ戻す |
| `prompts/night-prompts/scripts/cf-deploy-status.sh [prod\|staging\|wait [SHA]]` | Cloudflare Pages のビルド状況。Build watch paths で飛ばされたコミット（`is_skipped`）は「⏭ ビルド対象外」として即座に返る。`wait` は **HEAD（または指定SHA）のビルド**の完了を最大20分待つ。push 直後で未登録の間は待ち続け、登録されないままなら別のエラーとして報告する（旧実装は「最新デプロイ」を見て、push直前の成功ビルドを見て即座に成功と誤報した） |
| `prompts/night-prompts/scripts/cf-usage.sh` | Cloudflare の使用量 |
| `prompts/night-prompts/scripts/backend-health-check.sh` | API の疎通確認 |
| `scripts/backup-devenv.sh` | 開発環境のバックアップ |

Cloudflare API トークンは `~/.bashrc` の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` から読む。

> Web Analytics は Pages 用トークンでは取れない。`Account Analytics:Read` の別トークン + GraphQL が必要。

## 7.5 E2E テスト（Playwright）

```bash
npm run e2e            # 検証環境でカナリア（認証不要）
npm run e2e:canary:prod # 本番でカナリア
npm run e2e:local      # localhost:3000
npm run e2e:noauth     # 認証不要テストのみ
npm run e2e:visual     # スクリーンショット比較
npm run e2e:ui         # Playwright UI モード
npm run e2e:report     # HTML レポート表示
```

### プロジェクト構成（`playwright.config.ts`）

| project | 対象 | 認証 |
|---|---|---|
| `setup` | `*.setup.ts` | ログインして `e2e/.auth/user.json` を作る |
| `chromium` | Desktop Chrome | storageState 使用 |
| `mobile-chrome` | Pixel 7 | storageState 使用 |
| `no-auth` | `*.noauth.spec.ts` | なし（カナリア用スモーク） |

`workers: 1`（認証状態の競合を防ぐため直列）。ロケール `ja-JP` / TZ `Asia/Tokyo`。

### カナリア

`mugenknock-canary.timer` が毎日23:50に**ローカル**で実行し、結果を
S3 `mugenknock-error-logs/canary-logs/` にアップロードする。
日次レポート（`99-send-report.sh`）は**S3の最新結果を読む**（実行はしない）。

> ローカル実行なのは、夜間バッチを動かす環境に Playwright を同梱していないため。

夜間カナリアは systemd ユニットで `canary.sh prod` と明示指定されており、
**本番（mugenknock.com）のみを監視する**。検証環境は対象外。

### 環境URLの対応（間違えやすい）

| URL | 実体 |
|---|---|
| `https://mugenknock.com` | 本番（master） |
| `https://mugenknock.pages.dev` | **本番（master）** — Cloudflare Pages のプロジェクト既定エイリアス |
| `https://develop.mugenknock.pages.dev` | **検証（develop）** — ブランチプレビュー |
| `https://<hash>.mugenknock.pages.dev` | 各デプロイ固有のプレビュー |

`<project>.pages.dev` は production ブランチを配信する。ここを「検証環境」として
指定すると本番をテストしてしまうため、検証環境は必ず `develop.` 付きを使う。

> 2026-09-14 まで `e2e/run.sh` の `STAGING_URL` と `canary-auth.sh` がこれを取り違えており、
> `npm run e2e` 系が本番をテストしていた。

`canary-coverage-check.sh` が「現在のサイト構成とカナリアspecの整合性」を opus で確認し、
カバー漏れがあれば `playwright --list` の検証ゲート付きで spec を自動更新する。

## 7.6 日次レポート

`99-send-report.sh` が Gmail SMTP でメール送信する。設定は `~/.mugenknock_mail.conf`
（`SMTP_USER` / `SMTP_PASS`（アプリパスワード）/ `SMTP_TO`）。

内容:
1. 前日夜間スクリプトの成果サマリー（生成数・検証数）
2. カナリアテスト結果（S3 の最新）
3. AWS公式情報チェック（下記）
4. サイト稼働状況（問題数・未検証数・未解決通報数）

二重送信は S3 マーカーで冪等化されている。

### AWS 情報の現行性チェック（3本立て）

レポートの「5. AWS公式情報チェック」は、見る対象と頻度の違う3つで構成する。
**いずれも検知と報告だけで、サイトのコードは自動で書き換えない。**

| 観点 | 対象 | 頻度 | 実装 |
|---|---|---|---|
| 資格試験の変更 | `constants.ts` の試験コード・問題数・試験時間・合格点、資格の新設/廃止 | 週次・月曜 | `99-send-report.sh` 内（coming-soon + training blog を Haiku で走査→該当時のみ設定値と突き合わせ） |
| サービスの変更 | 既存**問題**に影響する廃止・改称・新規受付停止 | 週次・木曜 | `99-send-report.sh` 内（What's New / News Blog の RSS をキーワード抽出→ Haiku で選別） |
| サイト掲載内容の現行性 | **問題以外**のサイト静的データ（サービス図鑑・チートシート） | 月次 | `10-check-site-content.sh` |

週次の2つが走査窓7日なので、**週次のまま**にしてある（月1にすると23日ぶんを取りこぼす）。
月次なのは、走査窓を持たない「今のサイトの中身と今のAWSを突き合わせる」3本目だけ。

#### `10-check-site-content.sh`（月次・2026-10-19 追加）

30日以内に実行済みならスキップするので、毎晩起動しても実質月1回。
状態は `scripts/state/site_content_check.json`（`last_run_at` と項目ごとの確認日）。

- **A. サービス図鑑**（`src/data/awsServiceCatalog.ts`）
  公式確認済みの `state/service-catalog.json`（SSM 由来）と突き合わせる。**決定的なので claude を呼ばない。**
  図鑑側は略称（`S3` / `EC2` / `IAM`）、カタログ側は正式名なので、`shortName` と `serviceCode` も
  別名として索引に入れて突き合わせる（これをしないと「Amazon Simple Storage Service が未掲載」が大量に誤検知される）。
  報告するのは ①図鑑に残っているが `status` が active でないもの ②`examRelevance` が high/medium なのに未掲載のもの。
- **B. チートシート**（`src/views/CheatSheet.tsx` の `CHEAT_DATA`・374項目）
  公式ドキュメントと照らして、制限値・既定値・サービス名など**変わりうる事実**のズレを検知する。
  量が多いので毎回 `SITE_CHECK_N`（既定12）件だけを、確認が古い順（未確認を最優先）に巡回する。
  言い回しや教え方は指摘させない（事実のみ）。

出力は `prompts/night-prompts/logs/site-content_<日時>.md`。
`99-send-report.sh` が最新の1本を読んで要点をメールに載せる（45日より古ければ「未実行の疑い」として警告する）。
実行順は **`99-send-report.sh` より前**に置くこと。

環境変数: `SITE_CHECK_FORCE=1`（鮮度スキップを無視）/ `SITE_CHECK_N`（巡回件数）/ `SITE_CHECK_MAX_AGE_DAYS`。

### おひねり（Stripe 決済）の運用 — specs/006

- 有効化は管理設定 `AppSettings.ohineri = { enabled: true, limit: 30 }`（**dev/prod 共有テーブル**）。
  `enabled` が true でも、その Lambda に `STRIPE_SECRET_KEY` が無ければ無効のまま
- Lambda 環境変数: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`。`update-function-configuration --environment` は
  **全変数を置き換える**ので、必ず現在の値を読んでマージする（`ENV` / `REGION` を消さない）
- Webhook 受け口は `/webhooks/{proxy+}`（API Gateway・認証なし）。dev ステージのみ作成済み。
  dev の Stripe テストキーとエンドポイントは設定済み。**本番キー・本番エンドポイントは人間の確認が要る**
- 購入の記録は `UserEntitlements-{env}`、日次カウントは `UserDailyCounts-{env}`（TTL 3日）

## 7.7 トラブルシューティング

| 症状 | 確認すること |
|---|---|
| 夜間バッチが動いていない | `systemctl --user list-timers` で `Trigger: n/a` が無いか。`ct sync` で張り直す |
| メールが来ない | 上と同じ（連鎖切れが最も多い原因）。`journalctl --user -u claude-timer-watchdog` のログも見る |
| リリースノートが生成されない | **529 エラーは自己修復されない。** 手動で `generate-release-note.sh <日付>` を再実行する（2026-09-15 に delay=0→60 へ変更し発生頻度は軽減見込みだが未検証） |
| 管理画面の変更が出題に反映されない | Lambda のウォームキャッシュ（最大10分）。[02-architecture.md](02-architecture.md) 2.7 |
| 本番だけ挙動が古い | `deploy-lambda.sh prod` を打ち忘れていないか |
| ドメイン配分が偏る | prod Lambda に `domainBalancedOrder` が入っているか実機確認 |
| 資格を指定しないキーワード検索が 500 | **中身のない「幽霊行」が混入していないか。** 下記「幽霊行」を参照 |

### DynamoDB の幽霊行（update-item の upsert 事故）

**DynamoDB の UpdateItem は upsert。** 存在しないキーを更新すると
「キー＋更新した属性だけを持つ行」を新規作成する。そのため

```
他プロセスが問題を削除  →  その直後に別スクリプトが validityCheckedAt を書く
                        →  {questionId, validityCheckedAt} だけの中身のない行が復活
```

という事故が起きる。scan で問題一覧を取ってから更新するまでの間に削除されると発生する
（削除元は `check-scheduled-deletions.sh` の予約削除、`03-check-reports.sh` の通報削除など）。

**実害（2026-09-30 発覚）**: `sap-6b967aa4` が `{questionId, validityCheckedAt}` だけの
行として復活していた。`GET /questions` は examType 未指定だと全件スキャンになり、
`keyword` フィルタが公開フィルタより**先**に走るため
`q.questionText.toLowerCase()` が undefined を触って **本番で 500** を返していた。
資格を指定した検索は GSI 経由（examType を持たない幽霊行は索引外）なので正常に見え、
発見が遅れた。

**対策（両方入れてある）**:

1. **全スクリプトの `update-item` に `--condition-expression attribute_exists(<キー>)`**
   を付けた（`Questions` は `questionId` / `DailyServices` は `serviceId`・計15箇所）。
   削除済みなら `ConditionalCheckFailedException` で失敗し、行を復活させない。
   **新しく `update-item` を書くときも必ず付ける。**
2. **Lambda 側で属性欠落に耐える**ようにした。不正データ1件で検索全体が落ちない。

**点検方法**（異常データが疑われるとき）:

```bash
/home/yuzuki/local/bin/aws dynamodb scan --table-name Questions --output json > /tmp/q.json
# questionText を持たない行・examType が正規コード以外の行を洗い出す
```

## 本人のアカウントの成績の同期（検証→本番。2026-10-28〜）

ユーザーデータのテーブルは dev/prod で分けたまま（検証のコードが本番の全ユーザーの記録に書き込まないように）、
**本人のアカウント（yuzukisera00@gmail.com）だけ**を毎晩 `scripts/sync-user-data.py` で検証→本番へ写す。
本人は普段は検証で演習し、ときどき本番の画面で比べるため（本人決定）。保守の毎日分（`mugenknock-nightly-noai`）の 10/11。

| テーブル | 写し方 |
|---|---|
| `Sessions` / `UserAnswers` | 足し合わせ（本番にしかない記録も残る） |
| `UserQuestionStats` / `UserTagStats` / `UserPoints` | 検証にある項目で本番を上書き |
| `EncyclopediaUnlocks` | 解放済みの一覧を足し合わせ（日付は早いほう） |
| `UserEntitlements` / `UserDailyCounts` | 写さない（検証は Stripe のテスト用キー） |

- 書き込む前に、書き込み先の本人の記録を `prompts/night-prompts/scripts/state/user-sync-backup/` に JSON で残す（本番は PITR でも戻せる）。
- `--init` は本番→検証の置き換え（2026-10-28 に1回実行済み）。`--dry-run` で件数だけ見られる。
- 本番で解いた分の問題別の正誤・ポイントは、翌晩に検証の値で上書きされる（解答履歴は残る）。
