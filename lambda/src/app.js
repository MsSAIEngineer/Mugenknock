const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, QueryCommand, PutCommand, UpdateCommand, TransactWriteCommand, DeleteCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { v4: uuidv4 } = require('uuid');
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { ADMIN_EMAIL, EXAM_DOMAINS } = require('./constants');
const Stripe = require('stripe');
const { DEFAULT_DAILY_LIMIT, jstDateKey, countTtlSeconds, isCountedSession, computeLimits } = require('./entitlements');
const ohineri = require('./ohineri');

// ── 環境別テーブル名解決 ───────────────────────────────────────
// ユーザーデータ系テーブルは dev/prod で分離（接尾辞 -dev / -prod）。
// コンテンツ系（Questions/Tips/Releases/DailyServices/AppSettings/Reports 等）は共有のまま。
// 環境は各 Lambda の既存環境変数 ENV（awsquizHandler-dev→'dev' / -prod→'prod'）で判定。
const APP_ENV = process.env.ENV || 'prod';
const SPLIT_TABLES = new Set(['Sessions', 'UserAnswers', 'UserQuestionStats', 'UserTagStats', 'UserPoints', 'EncyclopediaUnlocks', 'UserEntitlements', 'UserDailyCounts']);
function T(name) { return SPLIT_TABLES.has(name) ? `${name}-${APP_ENV}` : name; }

// ── domain フィールドのユーティリティ ──────────────────────────
// domain は整数インデックス（EXAM_DOMAINS[examType][domain]）
// 旧データ: tags 配列、または domain が文字列の場合があるため両対応
function qDomainName(q) {
  if (typeof q.domain === 'number') return (EXAM_DOMAINS[q.examType] || [])[q.domain] ?? '';
  return '';
}
function qDomainIndex(examType, nameOrIndex) {
  if (typeof nameOrIndex === 'number') return nameOrIndex;
  return (EXAM_DOMAINS[examType] || []).indexOf(nameOrIndex);
}

const app = express();

// ── おひねり: Stripe Webhook（specs/006）──
// 署名検証には「加工前の生ボディ」が必要。express.json() より前に raw で登録する。
// 購入の事実を書くのはここと /users/me/checkout/confirm（Stripe API で支払いを確認）だけ。
app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ error: 'Not configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const purchase = ohineri.purchaseFromSession(event.data.object);
      if (purchase) {
        const r = await ohineri.recordPurchase({ docClient: getClient(), PutCommand, table: T('UserEntitlements'), purchase });
        console.log(`[ohineri] webhook purchase user=${purchase.userId} recorded=${r.recorded}`);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });  // 500 を返すと Stripe が再送する
  }
});

app.use(express.json({ limit: '2mb' }));

const getClient = () => {
  const client = new DynamoDBClient({ region: 'ap-northeast-1' });
  return DynamoDBDocumentClient.from(client);
};

// ── おひねり: 設定・上限の取得（specs/006）──
let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

// 管理設定 AppSettings.ohineri = { enabled, limit }。決済キーが無ければ有効にならない。
// 公開前は enabled が無い＝上限も購入ボタンも出ない。60秒だけメモリに持つ（回答のたびに読まない）。
let _ohineriCfg = { at: 0, value: null };
async function getOhineriConfig() {
  if (_ohineriCfg.value && Date.now() - _ohineriCfg.at < 60000) return _ohineriCfg.value;
  let item = null;
  try {
    const r = await getClient().send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'ohineri' } }));
    item = r.Item || null;
  } catch (e) { console.error('[ohineri] config read failed', e.message); }
  const value = {
    enabled: !!(item && item.enabled) && !!getStripe(),
    limit: Number.isInteger(item && item.limit) && item.limit > 0 ? item.limit : DEFAULT_DAILY_LIMIT,
  };
  _ohineriCfg = { at: Date.now(), value };
  return value;
}

// /sessions 系は従来ログイン検証が無い（body の userId を信用）。上限を厳密に効かせるため、
// おひねりが有効なときだけ、有効なトークンの sub を本人として使う。無効・無しなら null（ゲスト扱い）。
async function softUserSub(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = await jwtVerifier.verify(auth.slice(7));
    return payload.sub || null;
  } catch { return null; }
}

async function loadLimits(docClient, sub, cfg) {
  const [ent, cnt] = await Promise.all([
    docClient.send(new GetCommand({ TableName: T('UserEntitlements'), Key: { userId: sub } })),
    docClient.send(new GetCommand({ TableName: T('UserDailyCounts'), Key: { userId: sub, date: jstDateKey() } })),
  ]);
  return computeLimits({ enabled: cfg.enabled, limit: cfg.limit, used: (cnt.Item && cnt.Item.answered) || 0, unlimited: !!(ent.Item && ent.Item.ohineri) });
}

// ── 問題データ正規化 ──────────────────────────────────────────────
// choices と correctAnswers からラベル接頭辞（"A. " 等）を除去する。
// correctAnswerIndices は DB の値をそのまま使う（全問設定済み）。
const CHOICE_LABEL_RE = /^[A-E][.\s]\s*/i;
function normalizeQuestion(q) {
  const choices = (q.choices || []).map(c => String(c).replace(CHOICE_LABEL_RE, '').trim());
  const correctAnswers = (q.correctAnswers || []).map(c => String(c).replace(CHOICE_LABEL_RE, '').trim());
  const correctAnswerIndices = Array.isArray(q.correctAnswerIndices) ? q.correctAnswerIndices : [];
  return { ...q, choices, correctAnswers, correctAnswerIndices };
}

// 公開の問題API(GET /questions, GET /questions/:id)で返さない、内部・運用メタデータ。
// 出題画面は使わず、validityEditLog だけで1問あたり1.7〜2.9KB（応答の約3割）を占めていた。
// 管理画面は /admin/questions 系から取得するので影響しない。
// *En は英語対応の廃止後（lang は 'ja' 固定）は UI から参照されない。
const INTERNAL_QUESTION_FIELDS = [
  'validityEditLog', 'formatCheckedAt', 'linebreakCheckedAt', 'translationCheckedAt',
  'sourceQuestionId', 'auditNote', 'auditFlaggedAt', 'isResolved', 'resolvedAt',
  'questionTextEn', 'choicesEn', 'explanationEn', 'choiceExplanationsEn',
];
function stripInternalFields(q) {
  const o = { ...q };
  for (const f of INTERNAL_QUESTION_FIELDS) delete o[f];
  return o;
}

// ── 問題書き込み用の正規化＋検証（import / update 共通） ──────────────
// 正準キーは correctAnswerIndices。correctAnswers は choices から派生させ整合を保証する。
// スキーマ不正は Error を投げる（呼び出し側で 400 / skip 扱い）。
function buildQuestionWriteFields(input) {
  const choices = (input.choices || []).map(c => String(c).replace(CHOICE_LABEL_RE, '').trim());
  if (choices.length < 2) throw new Error('choices は2つ以上必要です');

  // correctAnswerIndices を正準として決定（明示指定を優先、なければ correctAnswers から導出）
  let indices = Array.isArray(input.correctAnswerIndices) ? input.correctAnswerIndices.slice() : null;
  if (!indices || indices.length === 0) {
    const cas = (input.correctAnswers || []).map(c => String(c).replace(CHOICE_LABEL_RE, '').trim());
    indices = cas.map(ca => choices.findIndex(c => c === ca)).filter(i => i >= 0);
  }
  indices = [...new Set(indices)]
    .filter(i => Number.isInteger(i) && i >= 0 && i < choices.length)
    .sort((a, b) => a - b);
  if (indices.length === 0) throw new Error('正解（correctAnswerIndices / correctAnswers）を特定できません');

  // correctAnswers は indices から派生（選択肢テキスト編集時のドリフトを防ぐ）
  const correctAnswers = indices.map(i => choices[i]);
  const out = { choices, correctAnswers, correctAnswerIndices: indices };

  // choiceExplanations は存在すれば choices と同数であること
  if (input.choiceExplanations !== undefined && input.choiceExplanations !== null) {
    if (!Array.isArray(input.choiceExplanations) || input.choiceExplanations.length !== choices.length) {
      throw new Error('choiceExplanations は choices と同数の配列である必要があります');
    }
    out.choiceExplanations = input.choiceExplanations;
  }

  out.isMultiple = input.isMultiple ?? (indices.length > 1);
  return out;
}

// ── DailyServices モジュールレベルキャッシュ ────────────────────────
// Lambda ウォームインスタンス間で共有されるキャッシュ（最大 5 分）
let _dailyServicesCache = null;
let _dailyServicesCachedAt = 0;
const DAILY_SERVICES_TTL = 5 * 60 * 1000;

async function getDailyServicesAll(docClient) {
  if (_dailyServicesCache && Date.now() - _dailyServicesCachedAt < DAILY_SERVICES_TTL) {
    return _dailyServicesCache;
  }
  const result = await docClient.send(new ScanCommand({ TableName: 'DailyServices' }));
  _dailyServicesCache = result.Items || [];
  _dailyServicesCachedAt = Date.now();
  return _dailyServicesCache;
}

// 抽選・図鑑母数に含めてよいサービスか。
// アイコン未設定のものを抽選対象にすると、解放しても図鑑に絵が出ず体験が壊れるため除外する。
// 非アクティブ(isActive:false)も同様に除外する（アイコン欠損を検知したら false にして止める運用）。
// 除外したものは母数(?list=1)からも外す。母数に残すと 100% に到達できなくなるため。
function isServiceUnlockable(i) {
  return i.serviceId !== '_schedule_'
    && i.isActive !== false
    && typeof i.icon === 'string' && i.icon.trim() !== '';
}

// ── 試験種別ごとの全問キャッシュ（Lambda ウォームインスタンス内メモリ・10分TTL） ──
// 同一インスタンスへの 2 回目以降のリクエストは DynamoDB を読まずに返す。
// Phase1（metaOnly）→ Phase2（ids+withAnswers）が同インスタンスに当たれば Phase2 も高速化される。
const _examQuestionsCache = new Map(); // examType → { items, cachedAt }
const EXAM_QUESTIONS_CACHE_TTL = 10 * 60 * 1000;

// 旧 GAI は examType='AIP' へ移行済み（GSI パーティション 'GAI' は0件）。
// かつての AIP→GAI エイリアスは現データでは AIP を0件化させるため撤去。
// 注: questionId 接頭辞は 'gai-' のまま（解放カウント集計の PREFIX_MAP gai→AIP で対応）。
function resolveExamTypeForDB(et) { return et; }

// 公式資格 → 前提知識(オリジナル資格)の対応表。
// `includeCompanion=true` 指定時、通常演習の出題プールに companion 側の問題を合流する。
// specs/003-original-exam-blend 参照。ドメイン体系は公式資格側と別物なので、
// domainBalancedOrder のバケットキーは examType を含めた複合キーにする必要がある。
const COMPANION_EXAM = { AIF: 'ML', MLA: 'ML', AIP: 'ML', DEA: 'DB', ANS: 'NW', SCS: 'SEC' };

async function getAllQuestionsForExam(docClient, examType) {
  const dbType = resolveExamTypeForDB(examType);
  const cacheKey = dbType;
  const cached = _examQuestionsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < EXAM_QUESTIONS_CACHE_TTL) {
    return cached.items;
  }
  const items = await queryAll(docClient, {
    TableName: 'Questions',
    IndexName: 'examType-index',
    KeyConditionExpression: 'examType = :examType',
    ExpressionAttributeValues: { ':examType': dbType }
  });
  _examQuestionsCache.set(cacheKey, { items, cachedAt: Date.now() });
  return items;
}

// examType に属する questionId の集合を返す（必ず全ページたどる）。
// examType-index は射影 ALL・1件あたり平均5.5KBあり、単発 Query は1MB上限で
// 打ち切られる（MLA 333件中162件しか返らない）。この集合で既習/不正解を絞ると
// 既習数が過少・未回答数が過大になるため、queryAll で全件取得する。
// poolOnly=true は /questions と同じ出題プール条件に揃える指定。
// 画面は「未回答 = total(/questions) - answered」で算出するので、母集団を一致させないとズレる。
async function getExamQuestionIdSet(docClient, examType, { poolOnly = false } = {}) {
  const items = await queryAll(docClient, {
    TableName: 'Questions',
    IndexName: 'examType-index',
    KeyConditionExpression: 'examType = :et',
    ExpressionAttributeValues: { ':et': examType },
    ProjectionExpression: 'questionId, isHidden, validityCheckedAt',
  });
  const filtered = poolOnly ? items.filter(q => !q.isHidden && !!q.validityCheckedAt) : items;
  return new Set(filtered.map(q => q.questionId));
}

// ── 汎用ウォームキャッシュ（Lambda インスタンス内メモリ・TTL付き） ──
// read-mostly な全件スキャン（growth-stats / tips / releases 等）の繰り返しを抑え、
// ユーザー増加時の RCU コストを削減する。更新は TTL 経過後に反映される（最大10分の遅延）。
const _warmCache = new Map(); // key → { value, at }
const WARM_TTL = 10 * 60 * 1000; // 10分
async function warmCached(key, ttlMs, loader) {
  const hit = _warmCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await loader();
  _warmCache.set(key, { value, at: Date.now() });
  return value;
}

// ── CORS（localhost + Cloudflare Pages + 本番ドメイン許可） ──
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://www.mugenknock.com',
  'https://mugenknock.com',
  'https://mugenknock.pages.dev',
];
// Cloudflare Pages のプレビューデプロイ（*.mugenknock.pages.dev 等）も許可
const CF_PAGES_ORIGIN_RE = /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.pages\.dev$|^https:\/\/[a-zA-Z0-9][a-zA-Z0-9-]*\.mugenknock\.pages\.dev$/;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || CF_PAGES_ORIGIN_RE.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 管理者JWT認証ミドルウェア ──
const jwtVerifier = CognitoJwtVerifier.create({
  userPoolId: 'ap-northeast-1_KIOFciGhQ',
  tokenUse: 'id',
  clientId: '16jjrj5m28o6s2k84og8kh2vh3',
});

async function getAdminEmails() {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'admins' } }));
    if (!result.Item) return [];
    return JSON.parse(result.Item.emails || '[]');
  } catch {
    return [];
  }
}

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = await jwtVerifier.verify(auth.slice(7));
    const email = payload.email;
    if (email !== ADMIN_EMAIL) {
      const extraAdmins = await getAdminEmails();
      if (!extraAdmins.includes(email)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// /admin/* へのすべてのリクエストに管理者認証を適用
app.use('/admin', requireAdmin);

// /users/me/* はログインユーザー本人のデータ専用。Cognito idToken を検証し、
// userId は「トークンの sub」を唯一の正とする。クライアントが body/query で渡した
// userId は信用せず常に sub で上書きする（他人の userId を指定した越権操作=IDORを封じる）。
// ゲストはこれらの機能を使わない（ログイン専用）ため 401 で問題ない。
async function requireUser(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = await jwtVerifier.verify(auth.slice(7));
    const sub = payload.sub;
    if (!sub) return res.status(401).json({ error: 'Invalid token' });
    req.authSub = sub;
    // クライアント指定の userId を常にトークンの sub で上書き（越権防止の要）
    if (req.query && typeof req.query === 'object') req.query.userId = sub;
    if (req.body && typeof req.body === 'object') req.body.userId = sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
app.use('/users/me', requireUser);

// 出題順の決定ロジックは lambda/src/selection.js（依存ゼロ・単体テストあり）。
// ドメイン均等化・公式資格と基礎知識資格の混在（specs/003・005）。docs/06-exercise-logic.md §6.2
const { shuffle, domainBucketKey, selectionOrder } = require('./selection');

async function scanAll(docClient, params) {
  const items = [];
  let lastKey;
  do {
    const result = await docClient.send(new ScanCommand({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function queryAll(docClient, params) {
  const items = [];
  let lastKey;
  do {
    const result = await docClient.send(new QueryCommand({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// Select:'COUNT' の Query は1回あたり最大1MB分しか走査せず、それを超えると
// 件数が途中で打ち切られる（LastEvaluatedKey が返る）。最後までたどって合算する。
async function queryCountAll(docClient, params) {
  let count = 0;
  let lastKey;
  do {
    const result = await docClient.send(new QueryCommand({
      ...params, Select: 'COUNT', ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    count += result.Count || 0;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

// 指定 questionId のみを取得する（問題数に依存しない O(件数) 取得）。
// exam 全件ロード（getAllQuestionsForExam）を回避し、問題が増えてもプログレッシブロードが
// 一定時間で済むようにするための根本対策。件数はセッション分（数〜数十件）で有界。
// IAM 上 BatchGetItem 権限が無いため、許可済みの GetItem を並列実行する（tagId パスと同方式）。
async function batchGetQuestions(docClient, idList) {
  const results = await Promise.all(
    idList.map(id =>
      docClient.send(new GetCommand({ TableName: 'Questions', Key: { questionId: id } }))
        .then(r => r.Item).catch(() => null)
    )
  );
  return results.filter(Boolean);
}

// ユーザーあたり保持するセッション数の上限（フロントの最大参照=Stats 200件に余裕を持たせた値）。
// 履歴・スコア推移は全てこの範囲内で参照されるため、これを超える古い分は保持不要。
const SESSION_RETENTION_LIMIT = 365;

// 直近 SESSION_RETENTION_LIMIT 件を超える古いセッションと、その回答明細(UserAnswers)を削除する。
// Sessions のソートキーは sessionId(UUID) で時系列順ではないため endedAt/startedAt で並べ替える。
// 件数キャップに一本化（UserAnswers の TTL は廃止）。剪定失敗は呼び出し側で握りつぶす。
async function pruneUserSessions(docClient, userId) {
  const sessions = await queryAll(docClient, {
    TableName: T('Sessions'),
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ProjectionExpression: 'sessionId, endedAt, startedAt',
  });
  if (sessions.length <= SESSION_RETENTION_LIMIT) return;
  sessions.sort((a, b) => {
    const da = a.endedAt || a.startedAt || '';
    const db = b.endedAt || b.startedAt || '';
    return da < db ? 1 : da > db ? -1 : 0; // 新しい順
  });
  const overflow = sessions.slice(SESSION_RETENTION_LIMIT);
  for (const s of overflow) {
    const answers = await queryAll(docClient, {
      TableName: T('UserAnswers'),
      KeyConditionExpression: 'userId = :uid AND begins_with(questionIdTimestamp, :p)',
      ExpressionAttributeValues: { ':uid': userId, ':p': `${s.sessionId}#` },
      ProjectionExpression: 'questionIdTimestamp',
    });
    await Promise.all(answers.map(a => docClient.send(new DeleteCommand({
      TableName: T('UserAnswers'), Key: { userId, questionIdTimestamp: a.questionIdTimestamp },
    }))));
    await docClient.send(new DeleteCommand({
      TableName: T('Sessions'), Key: { userId, sessionId: s.sessionId },
    }));
  }
}

// ヘルスチェック
// 問題生成・チェック状況（日次/月次集計）
app.get('/questions/growth-stats', async (req, res) => {
  try {
    const docClient = getClient();
    // 全件スキャンはウォームキャッシュで共有（集計はリクエスト毎に再計算するので日付バケットは常に最新）
    const allItems = await warmCached('growth:questions', WARM_TTL, () => scanAll(docClient, {
      TableName: 'Questions',
      ProjectionExpression: 'examType, createdAt, validityCheckedAt',
    }));
    // 有効な試験種別のみ集計（OCIAA等の無効データを除外）。
    // ML/DB は AWS認定ではないが、当サイトが提供する「Additional」レベルの外部知識カード。
    const AWS_EXAM_TYPES = new Set(['CLF','AIF','AIB','SAA','DVA','SOA','DEA','MLA','SAP','DOP','GAI','AIP','ANS','SCS','ML','DB','NW','SEC']);
    const items = allItems.filter(item => !item.examType || AWS_EXAM_TYPES.has(item.examType));

    // JST (UTC+9)
    const jstMs = Date.now() + 9 * 60 * 60 * 1000;
    const jstNow = new Date(jstMs);

    // 直近14日
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      daily.push(new Date(jstMs - i * 86400000).toISOString().slice(0, 10));
    }

    // 直近6ヶ月
    const monthly = [];
    const jstYear = parseInt(jstNow.toISOString().slice(0, 4));
    const jstMonthIdx = parseInt(jstNow.toISOString().slice(5, 7)) - 1;
    for (let i = 5; i >= 0; i--) {
      let m = jstMonthIdx - i;
      let y = jstYear;
      while (m < 0) { m += 12; y--; }
      monthly.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    }

    const createdByDay = Object.fromEntries(daily.map(d => [d, 0]));
    const verifiedByDay = Object.fromEntries(daily.map(d => [d, 0]));
    const createdByMonth = Object.fromEntries(monthly.map(m => [m, 0]));
    const verifiedByMonth = Object.fromEntries(monthly.map(m => [m, 0]));

    let createdBeforeDaily = 0, verifiedBeforeDaily = 0;
    let createdBeforeMonthly = 0, verifiedBeforeMonthly = 0;

    const toJstDay = (iso) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const toJstMonth = (iso) => new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);

    for (const item of items) {
      if (item.createdAt) {
        const day = toJstDay(item.createdAt);
        const month = toJstMonth(item.createdAt);
        if (createdByDay[day] !== undefined) createdByDay[day]++;
        else createdBeforeDaily++;
        if (createdByMonth[month] !== undefined) createdByMonth[month]++;
        else createdBeforeMonthly++;
      } else {
        createdBeforeDaily++;
        createdBeforeMonthly++;
      }
      if (item.validityCheckedAt) {
        const day = toJstDay(item.validityCheckedAt);
        const month = toJstMonth(item.validityCheckedAt);
        if (verifiedByDay[day] !== undefined) verifiedByDay[day]++;
        else if (day < daily[0]) verifiedBeforeDaily++;
        if (verifiedByMonth[month] !== undefined) verifiedByMonth[month]++;
        else if (month < monthly[0]) verifiedBeforeMonthly++;
      }
    }

    let cumC = createdBeforeDaily, cumV = verifiedBeforeDaily;
    const dailyCreatedCum = daily.map(d => { cumC += createdByDay[d]; return cumC; });
    const dailyVerifiedCum = daily.map(d => { cumV += verifiedByDay[d]; return cumV; });

    cumC = createdBeforeMonthly; cumV = verifiedBeforeMonthly;
    const monthlyCreatedCum = monthly.map(m => { cumC += createdByMonth[m]; return cumC; });
    const monthlyVerifiedCum = monthly.map(m => { cumV += verifiedByMonth[m]; return cumV; });

    const totalVerified = items.filter(item => item.validityCheckedAt).length;

    res.json({
      daily: {
        dates: daily,
        created: daily.map(d => createdByDay[d]),
        verified: daily.map(d => verifiedByDay[d]),
        createdCumulative: dailyCreatedCum,
        verifiedCumulative: dailyVerifiedCum,
      },
      monthly: {
        months: monthly,
        created: monthly.map(m => createdByMonth[m]),
        verified: monthly.map(m => verifiedByMonth[m]),
        createdCumulative: monthlyCreatedCum,
        verifiedCumulative: monthlyVerifiedCum,
      },
      total: items.length,
      totalVerified,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題一覧取得
app.get('/questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, tagId, domain, limit, shuffle: doShuffle, keyword, offset, ids } = req.query;
    let items = [];

    if (ids) {
      // ids 指定時は対象IDのみ取得（問題数に依存しない）。exam 全件ロードを避ける。
      const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
      items = idList.length ? await batchGetQuestions(docClient, idList) : [];
      if (examType) items = items.filter(q => q.examType === resolveExamTypeForDB(examType));
    } else if (tagId) {
      const relResult = await docClient.send(new QueryCommand({
        TableName: 'QuestionTagRelations',
        KeyConditionExpression: 'tagId = :tagId',
        ExpressionAttributeValues: { ':tagId': tagId }
      }));
      const promises = relResult.Items.map(i =>
        docClient.send(new GetCommand({ TableName: 'Questions', Key: { questionId: i.questionId } }))
      );
      const results = await Promise.all(promises);
      items = results.map(r => r.Item).filter(Boolean);
      if (examType) items = items.filter(q => q.examType === examType);
    } else if (examType) {
      items = await getAllQuestionsForExam(docClient, examType);
      // includeCompanion=true: 公式資格の通常演習プールに前提知識(オリジナル資格)の
      // 問題を合流する。domain 絞り込み時は対応するドメインが無いため無視する
      // （フロント側でも呼ばない想定だが、サーバ側でも防御的に無視する）。
      if (req.query.includeCompanion === 'true' && !domain && COMPANION_EXAM[examType]) {
        const companionItems = await getAllQuestionsForExam(docClient, COMPANION_EXAM[examType]);
        items = items.concat(companionItems);
      }
    } else {
      items = await scanAll(docClient, { TableName: 'Questions' });
    }

    if (domain) {
      // 正準キーは整数 index。フィルタは index のみ受理。
      const tokens = domain.split(',').map(d => d.trim()).filter(Boolean);
      items = items.filter(q => tokens.includes(String(q.domain)));
    }
    if (ids) {
      const idSet = new Set(ids.split(',').map(id => id.trim()).filter(Boolean));
      items = items.filter(q => idSet.has(q.questionId));
    }
    if (keyword) {
      const keywords = keyword.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
      // 属性欠落で落とさない。examType 未指定時はここが全件スキャン結果を走るため、
      // 不正データ1件で検索全体が 500 になる（2026-09-30 に questionText を持たない
      // 行が混入して実際に発生）。値が無いフィールドは単に一致しない扱いにする。
      items = items.filter(q =>
        keywords.every(kw =>
          String(q.questionText || '').toLowerCase().includes(kw) ||
          (q.choices || []).some(c => String(c ?? '').toLowerCase().includes(kw)) ||
          String(q.questionId || '').toLowerCase().includes(kw)
        )
      );
    }

    items = items.filter(q => !q.isHidden && !!q.validityCheckedAt);
    if (doShuffle === 'true') items = shuffle(items);
    const total = items.length;
    if (offset) items = items.slice(parseInt(offset));
    if (limit) items = items.slice(0, parseInt(limit));

    // metaOnly=true: 選択ロジックに必要な最小フィールドのみ返す（フロントのPhase1軽量化用）
    // questionText・choices 等を除外することでペイロードを約 1/10 に削減する
    if (req.query.metaOnly === 'true') {
      return res.json({
        items: items.map(q => ({
          questionId: q.questionId,
          domain: q.domain,
          examType: q.examType,
          aiVerified: q.aiVerified,
        })),
        count: items.length, total,
      });
    }

    // idsOnly=true: 問題IDのみ返す（プログレッシブロード用・フィルタ対応）
    if (req.query.idsOnly === 'true') {
      const { bookmarkOnly, unansweredOnly, incorrectOnly, userId: qUserId } = req.query;
      let answeredPerDomain = {};
      let scoreFn = null;
      if (qUserId) {
        const statsResult = await docClient.send(new QueryCommand({
          TableName: T('UserQuestionStats'),
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': qUserId }
        }));
        const stats = statsResult.Items || [];
        const answeredSet  = new Set(stats.map(s => s.questionId));
        const bookmarkSet  = bookmarkOnly   === 'true' ? new Set(stats.filter(s => s.bookmarked).map(s => s.questionId)) : null;
        const incorrectSet = incorrectOnly  === 'true' ? new Set(stats.filter(s => (s.incorrectCount ?? 0) > 0).map(s => s.questionId)) : null;
        const wantUnanswered = unansweredOnly === 'true';
        // ユーザーの既回答数をドメイン別に集計（出題プールの domain で対応付け）
        const qDomain = new Map(items.map(q => [q.questionId, domainBucketKey(q)]));
        for (const qid of answeredSet) {
          const d = qDomain.get(qid);
          if (d === undefined) continue;
          answeredPerDomain[d] = (answeredPerDomain[d] || 0) + 1;
        }
        // フィルタ指定時はその一致を最優先（フィルタが効く範囲では従来通り）
        if (bookmarkSet || incorrectSet || wantUnanswered) {
          scoreFn = q =>
            (bookmarkSet  && bookmarkSet.has(q.questionId)   ? 1 : 0) +
            (wantUnanswered && !answeredSet.has(q.questionId) ? 1 : 0) +
            (incorrectSet && incorrectSet.has(q.questionId)  ? 1 : 0);
        }
      }
      // フィルタで不可能でない限り、回答数の少ないドメインを優先してドメイン偏りを是正
      const ordered = selectionOrder(items, answeredPerDomain, scoreFn, examType);
      return res.json({ questionIds: ordered.map(q => q.questionId), total: ordered.length });
    }

    const withAnswers = req.query.withAnswers === 'true';
    const sanitized = (withAnswers
      ? items.map(item => {
          const n = normalizeQuestion(item);
          return { ...n, correctAnswerCount: n.correctAnswerIndices.length || 1 };
        })
      : items.map(item => {
          const { correctAnswers, explanation, explanationEn, ...rest } = item;
          const n = normalizeQuestion({ ...rest, correctAnswers: [] });
          return { ...n, correctAnswerCount: Array.isArray(correctAnswers) ? correctAnswers.length : 1 };
        })
    ).map(stripInternalFields);
    res.json({ items: sanitized, count: sanitized.length, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題1件取得
app.get('/questions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: 'Questions',
      Key: { questionId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Question not found' });
    res.json(stripInternalFields(normalizeQuestion(result.Item)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 通報
// 通報投稿。なりすまし・スパム対策:
//  - client 指定の userId は信用しない。トークンがあれば検証して sub、無ければ 'anonymous'
//  - カテゴリは既知値のみ許可、message は長さ制限
//  - ログインユーザーの同一問題への重複通報は排除（連打スパム防止）
const REPORT_CATEGORIES = ['question_error', 'choice_error', 'explanation_error', 'other'];
app.post('/questions/:id/report', async (req, res) => {
  try {
    const docClient = getClient();
    const questionId = req.params.id;
    const { category, message } = req.body || {};

    // client の userId は使わない。有効な idToken があればその sub を通報者とする。
    let reporterId = 'anonymous';
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = await jwtVerifier.verify(auth.slice(7));
        if (payload && payload.sub) reporterId = payload.sub;
      } catch { /* 無効トークンは anonymous 扱い（UXは維持） */ }
    }

    const cat = REPORT_CATEGORIES.includes(category) ? category : 'other';
    const msg = (typeof message === 'string' ? message : '').slice(0, 1000);

    // ログインユーザーの重複通報を排除（同一問題に複数回積まない）
    if (reporterId !== 'anonymous') {
      const existing = await docClient.send(new QueryCommand({
        TableName: 'Reports',
        KeyConditionExpression: 'questionId = :qid',
        FilterExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':qid': questionId, ':uid': reporterId },
        ProjectionExpression: 'reportId',
      }));
      if ((existing.Items || []).length > 0) {
        return res.json({ success: true, deduped: true });
      }
    }

    await docClient.send(new PutCommand({
      TableName: 'Reports',
      Item: {
        questionId,
        reportId: uuidv4(),
        userId: reporterId,
        category: cat,
        message: msg,
        reportedAt: new Date().toISOString()
      }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題削除（管理者用） ※/admin配下に置くことでrequireAdminが適用される
app.delete('/admin/questions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const questionId = req.params.id;

    // QuestionTagRelations の関連レコードを取得して削除
    const relResult = await docClient.send(new ScanCommand({
      TableName: 'QuestionTagRelations',
      FilterExpression: 'questionId = :qid',
      ExpressionAttributeValues: { ':qid': questionId }
    }));
    const deleteRels = (relResult.Items || []).map(item =>
      docClient.send(new DeleteCommand({
        TableName: 'QuestionTagRelations',
        Key: { tagId: item.tagId, questionId: item.questionId }
      }))
    );
    await Promise.all(deleteRels);

    await docClient.send(new DeleteCommand({
      TableName: 'Questions',
      Key: { questionId }
    }));

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題一括インポート（管理者用）
app.post('/admin/questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, domain, questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions must be a non-empty array' });
    }

    const now = new Date().toISOString();
    const created = [];
    const errors = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const itemExamType = q.examType || examType;
      const shortId = uuidv4().replace(/-/g, '').slice(0, 8);
      const questionId = `${itemExamType.toLowerCase()}-${shortId}`;

      // domain をインデックスに正規化（名前 or インデックス → 整数）
      const rawDomain = q.domain ?? domain;
      const domainIdx = rawDomain !== undefined && rawDomain !== null ? qDomainIndex(itemExamType, rawDomain) : -1;

      // choices / correctAnswers(Indices) / choiceExplanations を一括正規化・検証
      let fields;
      try {
        fields = buildQuestionWriteFields(q);
      } catch (e) {
        errors.push({ index: i, error: e.message });
        continue;
      }

      const item = {
        questionId,
        examType: itemExamType,
        questionText: q.questionText,
        choices: fields.choices,
        correctAnswers: fields.correctAnswers,
        correctAnswerIndices: fields.correctAnswerIndices,
        explanation: q.explanation || '',
        isMultiple: fields.isMultiple,
        createdAt: now,
      };
      if (domainIdx >= 0) item.domain = domainIdx;
      if (fields.choiceExplanations) item.choiceExplanations = fields.choiceExplanations;
      if (q.questionTextEn) item.questionTextEn = q.questionTextEn;
      if (q.choicesEn && q.choicesEn.length > 0) item.choicesEn = q.choicesEn;
      if (q.explanationEn) item.explanationEn = q.explanationEn;

      await docClient.send(new PutCommand({ TableName: 'Questions', Item: item }));

      created.push(questionId);
    }

    res.json({ created, count: created.length, ...(errors.length > 0 ? { errors } : {}) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：問題更新
app.put('/admin/questions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const questionId = req.params.id;
    const { questionText, questionTextEn, choices, choicesEn, correctAnswers, explanation, explanationEn, domain, isMultiple, examType, correctAnswerIndices: bodyIndices } = req.body;

    // domain を整数インデックスに変換
    const domainIdx = qDomainIndex(examType, domain);

    // choices / correctAnswers(Indices) を正規化・検証（correctAnswerIndices が正準）
    let fields;
    try {
      fields = buildQuestionWriteFields({ choices, correctAnswers, correctAnswerIndices: bodyIndices, isMultiple });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const setParts = ['questionText = :qt', 'choices = :ch', 'correctAnswers = :ca', 'correctAnswerIndices = :ci', 'explanation = :ex', '#d = :d', 'isMultiple = :im', 'examType = :et', 'updatedAt = :ua'];
    const removeParts = ['tags'];  // 旧 tags フィールドを削除（domain 整数に移行済み）

    // 正解・選択肢が変わる編集では全ユーザー正答率カウンタをリセットする
    // （旧内容に対する正答率が新内容に引き継がれるのを防ぐ）
    try {
      const prev = await docClient.send(new GetCommand({
        TableName: 'Questions',
        Key: { questionId },
        ProjectionExpression: 'choices, correctAnswerIndices',
      }));
      const prevChoices = prev.Item?.choices ?? [];
      const prevIndices = prev.Item?.correctAnswerIndices ?? [];
      const changed = JSON.stringify(prevChoices) !== JSON.stringify(fields.choices)
        || JSON.stringify(prevIndices) !== JSON.stringify(fields.correctAnswerIndices);
      if (changed) removeParts.push('globalAttempts', 'globalCorrect');
    } catch (e) { /* 取得失敗時はリセットしない */ }
    const exprNames = { '#d': 'domain' };
    const exprValues = {
      ':qt': questionText,
      ':ch': fields.choices,
      ':ca': fields.correctAnswers,
      ':ci': fields.correctAnswerIndices,
      ':ex': explanation || '',
      ':d': domainIdx >= 0 ? domainIdx : 0,
      ':im': fields.isMultiple,
      ':et': examType,
      ':ua': new Date().toISOString(),
    };

    if (questionTextEn) { setParts.push('questionTextEn = :qte'); exprValues[':qte'] = questionTextEn; }
    else { removeParts.push('questionTextEn'); }
    if (choicesEn && choicesEn.length > 0) { setParts.push('choicesEn = :che'); exprValues[':che'] = choicesEn; }
    else { removeParts.push('choicesEn'); }
    if (explanationEn) { setParts.push('explanationEn = :exe'); exprValues[':exe'] = explanationEn; }
    else { removeParts.push('explanationEn'); }

    let updateExpr = 'SET ' + setParts.join(', ');
    if (removeParts.length > 0) updateExpr += ' REMOVE ' + removeParts.join(', ');

    await docClient.send(new UpdateCommand({
      TableName: 'Questions',
      Key: { questionId },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題数サマリー（examCounts・domainCounts）— 軽量スキャン
app.get('/admin/questions/summary', async (req, res) => {
  try {
    const docClient = getClient();
    const { sinceDate } = req.query;
    const EXAM_TYPE_LIST = Object.keys(EXAM_DOMAINS);
    // Scan の代わりに examType-index を使って各試験種別を並行 Query
    const perExamItems = await Promise.all(EXAM_TYPE_LIST.map(et =>
      queryAll(docClient, {
        TableName: 'Questions',
        IndexName: 'examType-index',
        KeyConditionExpression: 'examType = :e',
        ExpressionAttributeValues: { ':e': et },
        ProjectionExpression: 'examType, #dom, isHidden, validityCheckedAt, formatCheckedAt, createdAt, globalAttempts, globalCorrect',
        ExpressionAttributeNames: { '#dom': 'domain' },
      })
    ));
    const items = perExamItems.flat();
    const visible = items.filter(i => !i.isHidden);
    const examCounts = {};
    const domainCounts = {};
    const exerciseCounts = {};
    const exerciseCorrectCounts = {};
    for (const item of visible) {
      const { examType } = item;
      examCounts[examType] = (examCounts[examType] || 0) + 1;
      if (!domainCounts[examType]) domainCounts[examType] = {};
      const dn = qDomainName(item);
      if (dn) domainCounts[examType][dn] = (domainCounts[examType][dn] || 0) + 1;
      exerciseCounts[examType] = (exerciseCounts[examType] || 0) + (item.globalAttempts || 0);
      exerciseCorrectCounts[examType] = (exerciseCorrectCounts[examType] || 0) + (item.globalCorrect || 0);
    }
    const validityCheckedCount = visible.filter(i => i.validityCheckedAt).length;
    const formatCheckedCount   = visible.filter(i => i.formatCheckedAt).length;
    const result = { examCounts, domainCounts, totalCount: visible.length, validityCheckedCount, formatCheckedCount, exerciseCounts, exerciseCorrectCounts };
    if (sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
      // JST 0:00 → UTC に変換してからしきい値比較（TZなし文字列だと JST 0:00〜8:59 が前日UTC扱いで漏れる）
      const threshold = new Date(sinceDate + 'T00:00:00+09:00').toISOString();
      const createdSince = visible.filter(i => i.createdAt && i.createdAt >= threshold);
      result.createdSinceCount         = createdSince.length;
      result.validityCheckedSinceCount = createdSince.filter(i => i.validityCheckedAt).length;
      result.formatCheckedSinceCount   = createdSince.filter(i => i.formatCheckedAt).length;
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 正当性チェック済み問題一覧
// ?filter=flagged → rating<=2 または isHidden=true のみ
// ?filter=hidden  → isHidden=true のみ
// デフォルト      → validityCheckedAt があるもの全件
// 妥当性チェック済み問題の一覧（管理画面「妥当性」タブ）
//
// 全件を1レスポンスで返していたが、問題数の増加で 17MB に達し Lambda の
// 6MB 上限を超えて常に 413 で失敗していた（2026-07 時点 3895件）。
// そのため limit/offset でページングする。あわせて一覧が描画しない
// choices / correctAnswers / explanation は返さない（openEdit 側が
// 個別 GET でフルの問題を取り直すため表示上の欠落は起きない）。
// 絞り込み・並べ替えはページ内だけに効くと誤解を生むのでサーバ側で行う。
app.get('/admin/questions/flagged', async (req, res) => {
  try {
    const docClient = getClient();
    const { filter, examType, sort } = req.query;
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const scanParams = { TableName: 'Questions' };
    const values = {};
    const conds = [];
    if (filter === 'flagged') {
      conds.push('(validityRating <= :threshold OR isHidden = :hidden)');
      values[':threshold'] = 2;
      values[':hidden'] = true;
    } else if (filter === 'hidden') {
      conds.push('isHidden = :hidden');
      values[':hidden'] = true;
    } else if (filter === 'audit') {
      // 監査で「易しすぎ・体裁・模試不適」等を指摘されたが、事実誤りが無いため
      // 自動修正されなかった問題。02 も fix-ng も解消できないので人の判断が要る。
      conds.push('attribute_exists(auditNote)');
    } else {
      conds.push('attribute_exists(validityCheckedAt)');
    }
    if (examType && examType !== 'ALL') {
      conds.push('examType = :et');
      values[':et'] = examType;
    }
    scanParams.FilterExpression = conds.join(' AND ');
    if (Object.keys(values).length) scanParams.ExpressionAttributeValues = values;
    scanParams.ProjectionExpression = 'questionId, examType, questionText, #dom, validityCheckedAt, formatCheckedAt, validityEditLog, isHidden, validityRating, validityNote, fixProposalJson, auditNote, auditFlaggedAt';
    scanParams.ExpressionAttributeNames = { '#dom': 'domain' };

    // フィルタ済みアイテム取得 + 全件数を examType-index Query で並行取得
    const EXAM_TYPE_LIST = Object.keys(EXAM_DOMAINS);
    const [matched, perExamCounts] = await Promise.all([
      scanAll(docClient, scanParams),
      Promise.all(EXAM_TYPE_LIST.map(et =>
        queryCountAll(docClient, {
          TableName: 'Questions',
          IndexName: 'examType-index',
          KeyConditionExpression: 'examType = :e',
          ExpressionAttributeValues: { ':e': et },
        })
      )),
    ]);
    const totalCount = perExamCounts.reduce((s, c) => s + c, 0);

    // 「AI修正済み」は validityEditLog の有無で決まる。件数バッジ用に絞り込み前に数える。
    const fixedCount = matched.filter(q => !!q.validityEditLog).length;
    const scoped = filter === 'fixed' ? matched.filter(q => !!q.validityEditLog) : matched;

    // 監査指摘バッジ用。filter=audit 以外では matched に含まれないことがあるため別途数える。
    let auditCount;
    if (filter === 'audit') {
      auditCount = matched.length;
    } else {
      auditCount = (await scanAll(docClient, {
        TableName: 'Questions',
        FilterExpression: 'attribute_exists(auditNote)',
        ProjectionExpression: 'questionId',
      })).length;
    }

    // 監査指摘は「いつ指摘されたか」で並べる方が使いやすい
    const ts = q => (filter === 'audit'
      ? (q.auditFlaggedAt ? new Date(q.auditFlaggedAt).getTime() : 0)
      : (q.validityCheckedAt ? new Date(q.validityCheckedAt).getTime() : 0));
    scoped.sort((a, b) => (sort === 'date_asc' ? ts(a) - ts(b) : ts(b) - ts(a)));

    const items = scoped.slice(offset, offset + limit);
    res.json({
      items,
      count: items.length,
      matchedCount: scoped.length,
      checkedCount: matched.length,
      fixedCount,
      auditCount,
      totalCount,
      offset,
      hasMore: offset + items.length < scoped.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 修正案を適用
app.post('/admin/questions/:id/apply-fix', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({ TableName: 'Questions', Key: { questionId: req.params.id } }));
    const q = result.Item;
    if (!q || !q.fixProposalJson) return res.status(404).json({ error: 'Fix proposal not found' });

    const fix = JSON.parse(q.fixProposalJson);
    const sets = ['validityNote = :note'];
    const vals = { ':note': '修正適用済' };

    if (fix.questionText)  { sets.push('questionText = :qt');    vals[':qt'] = fix.questionText; }
    if (fix.choices)       { sets.push('choices = :ch');         vals[':ch'] = fix.choices; }
    if (fix.correctAnswers){ sets.push('correctAnswers = :ca');  vals[':ca'] = fix.correctAnswers; }
    if (fix.choices || fix.correctAnswers) {
      const finalChoices = fix.choices || q.choices || [];
      const finalCorrectAnswers = fix.correctAnswers || q.correctAnswers || [];
      const newIndices = finalCorrectAnswers
        .map(ca => finalChoices.findIndex(c => c === ca))
        .filter(idx => idx >= 0);
      sets.push('correctAnswerIndices = :ci');
      vals[':ci'] = newIndices;
    }
    if (fix.explanation)   { sets.push('explanation = :ex');     vals[':ex'] = fix.explanation; }

    await docClient.send(new UpdateCommand({
      TableName: 'Questions',
      Key: { questionId: req.params.id },
      UpdateExpression: 'SET ' + sets.join(', ') + ' REMOVE fixProposalJson',
      ExpressionAttributeValues: vals,
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 修正案を却下（クリア）
app.post('/admin/questions/:id/reject-fix', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new UpdateCommand({
      TableName: 'Questions',
      Key: { questionId: req.params.id },
      UpdateExpression: 'REMOVE fixProposalJson',
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 表示/非表示切り替え
app.put('/admin/questions/:id/visibility', async (req, res) => {
  try {
    const docClient = getClient();
    const { isHidden } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: 'Questions',
      Key: { questionId: req.params.id },
      UpdateExpression: 'SET isHidden = :v',
      ExpressionAttributeValues: { ':v': !!isHidden },
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── チートシート項目の削除予定フラグ ────────────────────────────
// CHEAT_DATA はフロントの静的コードが実データのため、DBはオーバーレイ（削除予定
// フラグのみ）として持つ。itemKey は `${examType}::${item.name}`。
// フロント側で deleteDate 経過時に一覧から非表示にする（ソースコードは変更しない）。
app.get('/cheatsheet-deletions', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new ScanCommand({ TableName: 'CheatSheetDeletions' }));
    res.json({ items: result.Items || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/admin/cheatsheet-deletions/:itemKey', async (req, res) => {
  try {
    const docClient = getClient();
    const { reason, date } = req.body;
    const itemKey = decodeURIComponent(req.params.itemKey);
    if (reason && date) {
      await docClient.send(new PutCommand({
        TableName: 'CheatSheetDeletions',
        Item: { itemKey, reason, deleteDate: date, updatedAt: new Date().toISOString() },
      }));
    } else {
      await docClient.send(new DeleteCommand({
        TableName: 'CheatSheetDeletions',
        Key: { itemKey },
      }));
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 削除予定フラグ設定/解除（reason・date両方指定でSET、省略でREMOVE）
app.put('/admin/questions/:id/scheduled-deletion', async (req, res) => {
  try {
    const docClient = getClient();
    const { reason, date } = req.body;
    if (reason && date) {
      await docClient.send(new UpdateCommand({
        TableName: 'Questions',
        Key: { questionId: req.params.id },
        UpdateExpression: 'SET scheduledDeletionReason = :r, scheduledDeletionDate = :d',
        ExpressionAttributeValues: { ':r': reason, ':d': date },
      }));
    } else {
      await docClient.send(new UpdateCommand({
        TableName: 'Questions',
        Key: { questionId: req.params.id },
        UpdateExpression: 'REMOVE scheduledDeletionReason, scheduledDeletionDate',
      }));
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/admin/questions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: 'Questions',
      Key: { questionId: req.params.id },
    }));
    if (!result.Item) return res.status(404).json({ error: 'Question not found' });
    res.json(result.Item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/admin/questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, keyword, tag, domain, page, pageSize } = req.query;
    const pageNum = Math.max(0, parseInt(page) || 0);
    const pageSz = Math.min(500, Math.max(1, parseInt(pageSize) || 100));
    const isAll = !examType || examType === 'ALL';
    let items = [];

    if (!isAll) {
      items = await queryAll(docClient, {
        TableName: 'Questions',
        IndexName: 'examType-index',
        KeyConditionExpression: 'examType = :examType',
        ExpressionAttributeValues: { ':examType': examType }
      });
    } else {
      // explanation・validityEditLog を除外して 6MB 上限を回避（編集時は GET /admin/questions/:id で取得）
      items = await scanAll(docClient, {
        TableName: 'Questions',
        ProjectionExpression: 'questionId, examType, questionText, choices, correctAnswers, correctAnswerIndices, #dom, isMultiple, isHidden, createdAt, updatedAt, validityCheckedAt, formatCheckedAt, globalAttempts, globalCorrect, reactionUp, reactionDown',
        ExpressionAttributeNames: { '#dom': 'domain' },
      });
    }

    if (tag) items = items.filter(q => qDomainName(q) === tag);
    if (domain) {
      // 正準キーは整数 index。フィルタは index のみ受理。
      const tokens = domain.split(',').map(d => d.trim()).filter(Boolean);
      items = items.filter(q => tokens.includes(String(q.domain)));
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      items = items.filter(q =>
        q.questionId.toLowerCase().includes(kw) ||
        (q.questionText || '').toLowerCase().includes(kw)
      );
    }

    const { sort: sortParam = 'id_asc' } = req.query;
    const [sortField, sortDir] = sortParam.split('_');
    items.sort((a, b) => {
      if (sortField === 'updatedAt') {
        const da = a.updatedAt || '0', db = b.updatedAt || '0';
        return sortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
      } else if (sortField === 'validityCheckedAt') {
        const da = a.validityCheckedAt || '0', db = b.validityCheckedAt || '0';
        return sortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
      } else if (sortField === 'createdAt') {
        const da = a.createdAt || '0', db = b.createdAt || '0';
        return sortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
      } else if (sortField === 'formatCheckedAt') {
        const da = a.formatCheckedAt || '0', db = b.formatCheckedAt || '0';
        return sortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
      } else if (sortField === 'correctRate') {
        const ra = (a.globalAttempts || 0) > 0 ? (a.globalCorrect || 0) / a.globalAttempts : -1;
        const rb = (b.globalAttempts || 0) > 0 ? (b.globalCorrect || 0) / b.globalAttempts : -1;
        return sortDir === 'desc' ? rb - ra : ra - rb;
      } else if (sortField === 'attempts') {
        const ra = a.globalAttempts || 0, rb = b.globalAttempts || 0;
        return sortDir === 'desc' ? rb - ra : ra - rb;
      } else {
        return a.questionId.localeCompare(b.questionId);
      }
    });

    const total = items.length;
    const pagedItems = items.slice(pageNum * pageSz, (pageNum + 1) * pageSz);

    res.json({ items: pagedItems, count: pagedItems.length, total, page: pageNum, pageSize: pageSz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// 通報一覧（管理者用）
app.get('/admin/reports', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new ScanCommand({ TableName: 'Reports' }));
    const items = (result.Items || []).sort((a, b) =>
      new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime()
    );
    res.json({ items, count: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 通報削除（管理者用・解決済みマーク）
// Reports テーブルは questionId(HASH) + reportId(RANGE) の複合キー
app.delete('/admin/reports/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { questionId } = req.query;
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });
    await docClient.send(new DeleteCommand({
      TableName: 'Reports',
      Key: { questionId, reportId: req.params.id }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// セッション開始
app.post('/sessions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, mode, examType, questionIds, isMini, isFocused, sessionType } = req.body;
    // おひねり: 有効かつログイン中で、上限対象の演習なら、残りが無いときは開始させない
    const cfg = await getOhineriConfig();
    if (cfg.enabled && isCountedSession({ mode, isMini })) {
      const sub = await softUserSub(req);
      if (sub) {
        const limits = await loadLimits(docClient, sub, cfg);
        if (limits.applies && limits.remaining <= 0) {
          return res.status(429).json({ error: 'Daily limit reached', code: 'DAILY_LIMIT', ...limits });
        }
      }
    }
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const item = {
      userId, sessionId, mode, examType, questionIds,
      status: 'active', startedAt: now, lastAnsweredAt: now, score: 0, isPassed: false
    };
    if (isMini) item.isMini = true;
    if (isFocused) item.isFocused = true;
    // 再開用の種別（quick/focused/practice/exam/mini）。4種を独立して再開するため。
    if (sessionType) item.sessionType = sessionType;
    await docClient.send(new PutCommand({ TableName: T('Sessions'), Item: item }));
    res.json({ sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 進行中セッションのドラフト保存（サーバ側・再開用）。draft は小さく保つ（index/answers/timeLeft 等）。
app.put('/sessions/:id/progress', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, draft, sessionType } = req.body;
    if (!userId || draft == null) return res.status(400).json({ error: 'userId and draft required' });
    const now = new Date().toISOString();
    const names = {};
    const values = { ':d': draft, ':s': now };
    let expr = 'SET draft = :d, draftSavedAt = :s, lastAnsweredAt = :s';
    if (sessionType) { expr += ', sessionType = :st'; values[':st'] = sessionType; }
    await docClient.send(new UpdateCommand({
      TableName: T('Sessions'),
      Key: { userId, sessionId: req.params.id },
      UpdateExpression: expr,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ユーザーの進行中(再開可能)セッションを種別ごとに最新1件返す（4種独立）。
app.get('/users/me/active-sessions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const sessions = await queryAll(docClient, {
      TableName: T('Sessions'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    });
    const typeOf = (s) => s.sessionType
      || (s.mode === 'exam' ? (s.isMini ? 'mini' : 'exam') : (s.isFocused ? 'focused' : 'practice'));
    // 何日も放置された active セッションは「再開」候補にしない。
    // 完了処理を取りこぼした行（別種別の完了時に巻き添えでローカルdraftだけ消え、
    // サーバ側が active のまま孤児になったもの等）が復元され続け、
    // 終わったはずの演習が「再開」表示になる原因になっていた。
    const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - RESUME_MAX_AGE_MS;

    const latest = {};
    for (const s of sessions) {
      // endedAt があるものは完了/中断済み（status 更新が取りこぼされた行の防御）
      if (s.status !== 'active' || s.draft == null || s.endedAt) continue;
      const savedAt = Date.parse(s.draftSavedAt || s.startedAt || '');
      if (Number.isFinite(savedAt) && savedAt < cutoff) continue;
      const t = typeOf(s);
      if (!latest[t] || (s.draftSavedAt || '') > (latest[t].draftSavedAt || '')) latest[t] = s;
    }
    res.json({
      sessions: Object.entries(latest).map(([type, s]) => ({
        type, sessionId: s.sessionId, mode: s.mode, examType: s.examType,
        isMini: !!s.isMini, isFocused: !!s.isFocused,
        questionIds: s.questionIds || [], draft: s.draft, draftSavedAt: s.draftSavedAt,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 未完了セッション確認
// 回答記録
app.post('/sessions/:id/answers', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, questionId, selectedAnswers, isCorrect } = req.body;
    const now = new Date().toISOString();
    const questionIdTimestamp = `${req.params.id}#${questionId}#${now}`;

    // おひねり: 有効かつログイン中なら、上限対象の演習の回答を今日の回答数に原子的に加算する。
    // 他人の userId を指定して回数を増やされないよう、トークンの sub を本人とする。
    let dailyCountItem = null;
    try {
      const ohCfg = await getOhineriConfig();
      const sub = ohCfg.enabled ? await softUserSub(req) : null;
      if (sub) {
        const sess = await docClient.send(new GetCommand({
          TableName: T('Sessions'), Key: { userId: sub, sessionId: req.params.id }, ProjectionExpression: '#m, isMini', ExpressionAttributeNames: { '#m': 'mode' },
        }));
        if (isCountedSession(sess.Item)) {
          dailyCountItem = {
            Update: {
              TableName: T('UserDailyCounts'),
              Key: { userId: sub, date: jstDateKey() },
              UpdateExpression: 'ADD answered :one SET expiresAt = :ttl',
              ExpressionAttributeValues: { ':one': 1, ':ttl': countTtlSeconds() },
            }
          };
        }
      }
    } catch (e) { console.error('[ohineri] daily count skipped', e.message); }  // 回数の加算失敗で回答の記録を止めない

    // UserAnswers（回答ログ）と UserQuestionStats（問題別正誤）を原子的に記録。
    // どちらも問題ID単位の別項目なので、複数回答が並列送信されても競合しない。
    // 解放カウントは GET /question-stats が UserQuestionStats から都度集計するため、
    // ここで共有カウンタを更新しない（並列時の TransactionConflict / examType 欠落でドリフトしていた）。
    const transactItems = [
      {
        Put: {
          TableName: T('UserAnswers'),
          Item: { userId, questionIdTimestamp, questionId, sessionId: req.params.id, selectedAnswers, isCorrect, answeredAt: now }
        }
      },
      {
        Update: {
          TableName: T('UserQuestionStats'),
          Key: { userId, questionId },
          UpdateExpression: isCorrect
            ? 'ADD correctCount :one SET lastAnsweredAt = :now'
            : 'ADD incorrectCount :one SET lastAnsweredAt = :now',
          ExpressionAttributeValues: { ':one': 1, ':now': now }
        }
      }
    ];

    if (dailyCountItem) transactItems.push(dailyCountItem);
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));

    // 全ユーザー正答率のグローバル集計（全試行ベース・ゲスト含む）。
    // トランザクション外の条件付き加算にする: 削除済み問題への幽霊項目作成を防ぎつつ、
    // 集計失敗が回答記録本体を失敗させないようにする。
    try {
      await docClient.send(new UpdateCommand({
        TableName: 'Questions',
        Key: { questionId },
        UpdateExpression: 'ADD globalAttempts :one, globalCorrect :corr',
        ConditionExpression: 'attribute_exists(questionId)',
        ExpressionAttributeValues: { ':one': 1, ':corr': isCorrect ? 1 : 0 },
      }));
    } catch (e) { /* 削除済み問題・一時エラーは無視 */ }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// セッション別回答詳細取得
app.get('/sessions/:id/answers', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.query;
    const sessionId = req.params.id;

    // ソートキー questionIdTimestamp は `${sessionId}#${questionId}#${ts}` 形式。
    // begins_with で該当セッションのみ読む（userId 全履歴の読み取り＋Filter を回避）。
    const answersResult = await docClient.send(new QueryCommand({
      TableName: T('UserAnswers'),
      KeyConditionExpression: 'userId = :uid AND begins_with(questionIdTimestamp, :sidp)',
      ExpressionAttributeValues: { ':uid': userId, ':sidp': `${sessionId}#` },
    }));

    const answers = answersResult.Items || [];
    const questionIds = [...new Set(answers.map(a => a.questionId))];

    const questions = await Promise.all(
      questionIds.map(qid =>
        docClient.send(new GetCommand({
          TableName: 'Questions',
          Key: { questionId: qid },
          ProjectionExpression: 'questionId, questionText',
        })).then(r => r.Item).catch(() => null)
      )
    );
    const qMap = Object.fromEntries(questions.filter(Boolean).map(q => [q.questionId, q]));

    const result = answers
      .map(a => ({
        questionId: a.questionId,
        questionText: qMap[a.questionId]?.questionText ?? '',
        isCorrect: a.isCorrect,
        answeredAt: a.answeredAt,
      }))
      .sort((a, b) => (a.answeredAt > b.answeredAt ? 1 : -1));

    res.json({ answers: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ドメイン別直近正誤保存（デバイス間共有用）
// domainResults はセッションの新規回答デルタのみ。サーバー側で既存データにマージし末尾30件に絞る。
// （苦手分析で直近10/20/30問のフィルタ表示に使うため最大30件保持。30問以前は破棄）
app.put('/users/me/domain-results', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, domainResults } = req.body;
    if (!userId || !domainResults || typeof domainResults !== 'object') {
      return res.status(400).json({ error: 'userId and domainResults are required' });
    }
    await Promise.all(
      Object.entries(domainResults).map(async ([tagId, newResults]) => {
        let existingResults = [];
        try {
          const existing = await docClient.send(new GetCommand({
            TableName: T('UserTagStats'),
            Key: { userId, tagId },
            ProjectionExpression: 'recentResults',
          }));
          existingResults = existing.Item?.recentResults ?? [];
        } catch {}
        const merged = [...existingResults, ...newResults].slice(-30);
        return docClient.send(new UpdateCommand({
          TableName: T('UserTagStats'),
          Key: { userId, tagId },
          UpdateExpression: 'SET recentResults = :r',
          ExpressionAttributeValues: { ':r': merged },
        }));
      })
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// セッション終了
app.put('/sessions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, status, score, isPassed } = req.body;
    const now = new Date().toISOString();
    // 完了時は再開用ドラフトも削除する。残すと遅延した progress PUT や過去の
    // 取りこぼしと合わさって active-sessions に露出し「終わったのに演習中」表示の原因になる。
    const removeDraft = status === 'completed' ? ' REMOVE draft, draftSavedAt' : '';
    await docClient.send(new UpdateCommand({
      TableName: T('Sessions'),
      Key: { userId, sessionId: req.params.id },
      UpdateExpression: 'SET #s = :status, score = :score, isPassed = :isPassed, endedAt = :now' + removeDraft,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status, ':score': score, ':isPassed': isPassed, ':now': now }
    }));
    // セッション完了時に保持上限を超えた古い履歴を剪定（件数キャップ）。失敗しても完了応答は返す。
    if (status === 'completed') {
      try { await pruneUserSessions(docClient, userId); } catch (e) { console.error('prune failed', e); }
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// セッション結果取得
app.get('/sessions/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.query;
    const result = await docClient.send(new GetCommand({
      TableName: T('Sessions'),
      Key: { userId, sessionId: req.params.id }
    }));
    if (!result.Item) return res.status(404).json({ error: 'Session not found' });
    res.json(result.Item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 演習済み問題数取得
app.get('/users/me/question-stats', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;
    if (!userId || !examType) return res.json({ answeredCount: 0 });

    // 解放カウント（しっかり対策・苦手分析）= 演習量。
    // UserQuestionStats を唯一の真実源として毎回集計する。
    // （保存カウンタ + 増分方式はトランザクション競合・examType 欠落でドリフトするため廃止）
    // correctCount + incorrectCount の合計 = 解いた問題数（正誤・重複問わず）。
    const PREFIX_MAP = { 'gai': 'AIP' };
    const statsResult = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'questionId, correctCount, incorrectCount',
    }));
    const answeredCount = (statsResult.Items || [])
      .filter(s => {
        const prefix = (s.questionId || '').split('-')[0].toLowerCase();
        return (PREFIX_MAP[prefix] ?? prefix.toUpperCase()) === examType;
      })
      .reduce((sum, s) => sum + (s.correctCount ?? 0) + (s.incorrectCount ?? 0), 0);

    res.json({ answeredCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// セッション履歴取得
app.get('/users/me/sessions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, limit, examType } = req.query;
    const exprVals = { ':uid': userId, ':completed': 'completed' };
    let filterExpr = '#s = :completed';
    if (examType) { filterExpr += ' AND examType = :et'; exprVals[':et'] = examType; }
    const result = await docClient.send(new QueryCommand({
      TableName: T('Sessions'),
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: filterExpr,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: exprVals
    }));
    const all = (result.Items || [])
      .sort((a, b) => ((b.endedAt || b.startedAt) > (a.endedAt || a.startedAt) ? 1 : -1));
    const items = all.slice(0, parseInt(limit) || 20);
    res.json({ items, totalCount: all.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 統計取得
// examType 指定時は、ドメイン別の累計 correctCount/incorrectCount を UserQuestionStats から
// 集計して返す。UserTagStats には recentResults（直近30件のローリング窓）しか保存しておらず、
// 累計カウンタは書き込まれたことがないため、これを読む画面（成績のドメイン別・演習/模試設定の
// ドメイン別正答率）が常に0問表示になっていた。
// 集計元を「未回答フィルタと同じ UserQuestionStats」に揃えることで、既習数と未演習数が
// 構造的に整合する（別ソースを持たせると再びズレるため、ここでの導出を正とする）。
// 苦手分析の「直近30問」まで使うので、ドメインごとに30件返す（PUT /domain-results の保持数と同じ）
const RECENT_RESULTS_LIMIT = 30;
app.get('/users/me/stats', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;
    const [statsResult, resetResult] = await Promise.all([
      docClient.send(new QueryCommand({
        TableName: T('UserTagStats'),
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      })),
      docClient.send(new GetCommand({
        TableName: 'AppSettings',
        Key: { settingId: `userReset_${userId}` },
      })),
    ]);
    let stats = statsResult.Items || [];

    if (examType) {
      // 単発 Query は1MBで打ち切られるので全ページたどる。
      const [qStatsItems, answerItems, questions] = await Promise.all([
        queryAll(docClient, {
          TableName: T('UserQuestionStats'),
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
        }),
        queryAll(docClient, {
          TableName: T('UserAnswers'),
          KeyConditionExpression: 'userId = :uid',
          ExpressionAttributeValues: { ':uid': userId },
          ProjectionExpression: 'questionId, isCorrect, answeredAt',
        }),
        getAllQuestionsForExam(docClient, examType),
      ]);
      // 出題プールと同じ条件で絞る（/questions と揃えないと既習数が未演習数と合わない）
      const domainOf = new Map(
        questions
          .filter(q => !q.isHidden && !!q.validityCheckedAt)
          .map(q => [q.questionId, qDomainIndex(q.examType, q.domain)])
      );
      const agg = new Map(); // domain index → { correctCount, incorrectCount, answeredCount }
      for (const s of qStatsItems) {
        const d = domainOf.get(s.questionId);
        if (d === undefined || d < 0) continue;
        const a = agg.get(d) || { correctCount: 0, incorrectCount: 0, answeredCount: 0 };
        a.correctCount += s.correctCount ?? 0;
        a.incorrectCount += s.incorrectCount ?? 0;
        a.answeredCount += 1;
        agg.set(d, a);
      }
      // 正準 tagId (`${examType}_${idx}`) の行へマージ。該当行が無いドメインは新規に組み立てる
      // （UserTagStats に行が無くても成績を0問と誤表示させないため）。
      // 直近の正誤（recentResults）も1問ごとの回答ログ UserAnswers から作る。
      // 以前はセッション完了・中断時にクライアントが送る PUT /domain-results だけで溜めていたため、
      // 破棄・上書き・アプリ終了・送信失敗のセッションが抜け、再開後の完了で二重にも入り、
      // 累計（UserQuestionStats）と食い違っていた。出どころを回答ログに一本化する。
      const recentByDomain = new Map(); // domain index → boolean[]（古い順・末尾 RECENT_RESULTS_LIMIT 件）
      answerItems
        .filter(a => domainOf.has(a.questionId) && domainOf.get(a.questionId) >= 0)
        .sort((a, b) => (a.answeredAt || '').localeCompare(b.answeredAt || ''))
        .forEach(a => {
          const d = domainOf.get(a.questionId);
          if (!recentByDomain.has(d)) recentByDomain.set(d, []);
          recentByDomain.get(d).push(!!a.isCorrect);
        });
      const byTagId = new Map(stats.map(s => [s.tagId, s]));
      for (const [d, a] of agg) {
        const tagId = `${examType}_${d}`;
        byTagId.set(tagId, { ...(byTagId.get(tagId) || { userId, tagId }), ...a });
      }
      // この試験の全ドメインで recentResults を回答ログ由来に置き換える（ログに無いドメインは空）
      for (const [tagId, row] of byTagId) {
        if (!tagId.startsWith(`${examType}_`)) continue;
        const d = Number(tagId.slice(examType.length + 1));
        if (!Number.isInteger(d)) continue;
        byTagId.set(tagId, { ...row, recentResults: (recentByDomain.get(d) || []).slice(-RECENT_RESULTS_LIMIT) });
      }
      for (const [d, r] of recentByDomain) {
        const tagId = `${examType}_${d}`;
        if (!byTagId.has(tagId)) byTagId.set(tagId, { userId, tagId, recentResults: r.slice(-RECENT_RESULTS_LIMIT) });
      }
      stats = [...byTagId.values()];
    }

    res.json({
      stats,
      resetAt: resetResult.Item?.resetAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ユーザー演習データ削除（試験種別ごと）
app.delete('/users/me/data', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;
    if (!userId || !examType) return res.status(400).json({ error: 'userId and examType are required' });

    const deleteItems = async (table, keys) => {
      if (keys.length === 0) return;
      await Promise.all(keys.map(key => docClient.send(new DeleteCommand({ TableName: table, Key: key }))));
    };

    // 1. examType の questionId 一覧を取得
    // 削除対象は非表示・未検証の問題も含める（poolOnly にすると統計行が消し残る）。
    // 単発 Query では1MBで打ち切られ削除漏れになるため全ページたどる。
    const questionIds = [...await getExamQuestionIdSet(docClient, examType)];

    // 2. UserQuestionStats 削除
    await deleteItems(T('UserQuestionStats'), questionIds.map(qid => ({ userId, questionId: qid })));

    // 3. UserTagStats 削除（正準キー形式 "examType_index" のみ対象にする。
    //    旧形式の裸index("0","1"...)は全試験で共有されるキーのため、
    //    ここで触ると他試験の苦手分析データを巻き込んで消してしまう事故になる）
    const domains = EXAM_DOMAINS[examType] || [];
    const tagIds = domains.map((_, i) => `${examType}_${i}`);
    await deleteItems(T('UserTagStats'), tagIds.map(tagId => ({ userId, tagId })));

    // 4. Sessions を取得
    const sessionsResult = await docClient.send(new QueryCommand({
      TableName: T('Sessions'),
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'examType = :et',
      ExpressionAttributeValues: { ':uid': userId, ':et': examType },
    }));
    const sessionIds = (sessionsResult.Items || []).map(s => s.sessionId);

    // 5. UserAnswers 削除（セッションごとにクエリ）
    for (const sessionId of sessionIds) {
      let lastKey;
      do {
        const answersResult = await docClient.send(new QueryCommand({
          TableName: T('UserAnswers'),
          KeyConditionExpression: 'userId = :uid AND begins_with(questionIdTimestamp, :prefix)',
          ExpressionAttributeValues: { ':uid': userId, ':prefix': `${sessionId}#` },
          ExclusiveStartKey: lastKey,
        }));
        const answerKeys = (answersResult.Items || []).map(a => ({ userId: a.userId, questionIdTimestamp: a.questionIdTimestamp }));
        await deleteItems(T('UserAnswers'), answerKeys);
        lastKey = answersResult.LastEvaluatedKey;
      } while (lastKey);
    }

    // 6. Sessions 削除
    await deleteItems(T('Sessions'), sessionIds.map(sid => ({ userId, sessionId: sid })));

    // 7. スコア履歴削除
    try {
      await docClient.send(new DeleteCommand({
        TableName: 'AppSettings',
        Key: { settingId: `scoreHistData_${userId}_${examType}` },
      }));
    } catch {}

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ユーザー自身のデータ全初期化（Cognitoアカウント・メール・パスワードは保持）
// executeUserDataDeletion より高速: 全ページ取得 + 並列削除 + UserAnswers は孤児化
async function executeUserDataReset(docClient, userId) {
  const batchDelete = async (table, keys) => {
    if (keys.length === 0) return;
    const CHUNK = 25;
    const chunks = [];
    for (let i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));
    await Promise.all(chunks.map(chunk =>
      Promise.all(chunk.map(key => docClient.send(new DeleteCommand({ TableName: table, Key: key }))))
    ));
  };

  const [qsItems, tsItems, sessItems] = await Promise.all([
    queryAll(docClient, {
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, questionId',
    }),
    queryAll(docClient, {
      TableName: T('UserTagStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, tagId',
    }),
    queryAll(docClient, {
      TableName: T('Sessions'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, sessionId',
    }),
  ]);

  await Promise.all([
    batchDelete(T('UserQuestionStats'), qsItems.map(i => ({ userId: i.userId, questionId: i.questionId }))),
    batchDelete(T('UserTagStats'),      tsItems.map(i => ({ userId: i.userId, tagId: i.tagId }))),
    batchDelete(T('Sessions'),          sessItems.map(i => ({ userId: i.userId, sessionId: i.sessionId }))),
    // DELETE より PUT（空上書き）の方が確実 — delete は存在しないキーに対してもエラーにならないが、
    // 型不一致や権限エラーで失敗しても catch で隠れるため、空レコードで上書きする
    docClient.send(new PutCommand({
      TableName: T('EncyclopediaUnlocks'),
      Item: { userId, unlocks: '{}', unlockDate: null, todayServiceId: null },
    })).catch(() => {}),
    docClient.send(new DeleteCommand({ TableName: T('UserPoints'), Key: { userId } })).catch(() => {}),
    docClient.send(new UpdateCommand({
      TableName: 'AppSettings',
      Key: { settingId: `userPrefs_${userId}` },
      // targetExam/examDates に加え、kvSync のデバイス間同期マップ(kv)も空にする。
      // 空にしないと初期化後の kvSync プルで各種設定・実績（dailyGoalReward等）が復活する。
      UpdateExpression: 'SET #targetExam = :null, #examDates = :empty, #kv = :empty',
      ExpressionAttributeNames: { '#targetExam': 'targetExam', '#examDates': 'examDates', '#kv': 'kv' },
      ExpressionAttributeValues: { ':null': null, ':empty': {} },
    })).catch(() => {}),
    // 日次目標の進捗カウント（目標演習量達成率）。消さないと fetchDailyProgress で復活する。
    docClient.send(new DeleteCommand({ TableName: 'AppSettings', Key: { settingId: `dailyProgress_${userId}` } })).catch(() => {}),
  ]);

  // AppSettings のユーザー固有データを削除（スコア履歴・解答カウンター）
  const appSettingsResult = await docClient.send(new ScanCommand({
    TableName: 'AppSettings',
    FilterExpression: 'begins_with(settingId, :sh)',
    ExpressionAttributeValues: {
      ':sh': `scoreHistData_${userId}_`,
    },
    ProjectionExpression: 'settingId',
  }));
  await batchDelete('AppSettings', (appSettingsResult.Items || []).map(i => ({ settingId: i.settingId })));

  const resetAt = new Date().toISOString();
  await docClient.send(new PutCommand({
    TableName: 'AppSettings',
    Item: { settingId: `userReset_${userId}`, userId, resetAt },
  }));
  return resetAt;
}

app.post('/users/me/reset', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const resetAt = await executeUserDataReset(docClient, userId);
    res.json({ success: true, resetAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── スコア履歴（デバイス間同期） ──

app.get('/users/me/score-history', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;
    if (!userId || !examType) return res.status(400).json({ error: 'userId and examType are required' });
    const result = await docClient.send(new GetCommand({
      TableName: 'AppSettings',
      Key: { settingId: `scoreHistData_${userId}_${examType}` },
    }));
    const item = result.Item || {};
    res.json({
      scoreHistory: item.scoreHistory || [],
      sessionScoreHistory: item.sessionScoreHistory || [],
      sessionScoreLog: item.sessionScoreLog || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/users/me/score-history', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType, scoreHistory, sessionScoreHistory, sessionScoreLog } = req.body;
    if (!userId || !examType) return res.status(400).json({ error: 'userId and examType are required' });
    const key = { settingId: `scoreHistData_${userId}_${examType}` };
    // 蓄積保護ガード: 空/疎なローカルを基にした短い配列で、サーバーの蓄積を上書きさせない。
    // クライアントのレース・キャッシュクリア・別オリジン等でデータが消えるのを防ぐ。
    const existing = (await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: key }))).Item || {};
    const updateParts = [];
    const exprValues = {};

    // 日次スコア履歴: 日付でマージし各日の最大点を保持（短い配列でも既存の日を消さない）。
    if (scoreHistory !== undefined) {
      const byDate = new Map();
      const add = (arr) => { for (const e of (Array.isArray(arr) ? arr : [])) { if (e && e.date) byDate.set(e.date, Math.max(byDate.get(e.date) ?? 0, Number(e.score) || 0)); } };
      add(existing.scoreHistory);
      add(scoreHistory);
      const merged = [...byDate.entries()].map(([date, score]) => ({ date, score }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-30);
      updateParts.push('scoreHistory = :sh'); exprValues[':sh'] = merged;
    }
    // セッション系: 受信が既存より短い場合は蓄積の破壊とみなして無視する。
    const guardLonger = (name, exprKey, incoming) => {
      if (incoming === undefined) return;
      const stored = existing[name];
      if (Array.isArray(stored) && Array.isArray(incoming) && incoming.length < stored.length) return;
      updateParts.push(`${name} = ${exprKey}`); exprValues[exprKey] = incoming;
    };
    guardLonger('sessionScoreHistory', ':ssh', sessionScoreHistory);
    guardLonger('sessionScoreLog', ':ssl', sessionScoreLog);

    if (updateParts.length === 0) return res.json({ success: true });
    await docClient.send(new UpdateCommand({
      TableName: 'AppSettings',
      Key: key,
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: exprValues,
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tips（コラム）──

// 演習モード用：試験種別に合うコラムを全件返す
app.get('/tips', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType } = req.query;
    // 全 Tips をウォームキャッシュ（演習開始ごとに呼ばれるため）。examType 絞り込みは JS 側で行う。
    const all = await warmCached('tips:all', WARM_TTL, () => scanAll(docClient, { TableName: 'Tips' }));
    const items = examType ? all.filter(t => t.examType === examType || t.examType === 'ALL') : all;
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：全件取得
app.get('/admin/tips', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new ScanCommand({ TableName: 'Tips' }));
    const items = (result.Items || []).sort((a, b) => a.examType.localeCompare(b.examType));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：追加
app.post('/admin/tips', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, title, content } = req.body;
    const tipId = uuidv4();
    await docClient.send(new PutCommand({
      TableName: 'Tips',
      Item: { tipId, examType, title, content, createdAt: new Date().toISOString() }
    }));
    res.json({ tipId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：一括インポート
app.post('/admin/tips/bulk', async (req, res) => {
  try {
    const docClient = getClient();
    const { tips, defaultExamType } = req.body;
    if (!Array.isArray(tips) || tips.length === 0) {
      return res.status(400).json({ error: 'tips must be a non-empty array' });
    }
    const now = new Date().toISOString();
    const created = [];
    for (const tip of tips) {
      const tipId = uuidv4();
      await docClient.send(new PutCommand({
        TableName: 'Tips',
        Item: {
          tipId,
          examType: tip.examType || defaultExamType || 'ALL',
          title: tip.title,
          content: tip.content,
          createdAt: now,
        }
      }));
      created.push(tipId);
    }
    res.json({ created, count: created.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：更新
app.put('/admin/tips/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, title, content } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: 'Tips',
      Key: { tipId: req.params.id },
      UpdateExpression: 'SET examType = :et, title = :t, content = :c',
      ExpressionAttributeValues: { ':et': examType, ':t': title, ':c': content }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：削除
app.delete('/admin/tips/:id', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({
      TableName: 'Tips',
      Key: { tipId: req.params.id }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── コラムのネタ（ColumnIdeas）──
// 管理者が投稿した「ネタ」。ローカルの gcs スクリプトが裏取り→コラム(Tips)化し、
// 使用済みネタは status='used' に無効化する（履歴として削除はしない）。

// 一覧取得（?status=pending/used で絞り込み可）
app.get('/admin/column-ideas', async (req, res) => {
  try {
    const docClient = getClient();
    const { status } = req.query;
    const result = await docClient.send(new ScanCommand({ TableName: 'ColumnIdeas' }));
    let items = result.Items || [];
    if (status) items = items.filter(i => i.status === status);
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 追加
app.post('/admin/column-ideas', async (req, res) => {
  try {
    const docClient = getClient();
    const { text, examType, note } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const item = {
      ideaId: uuidv4(),
      text: text.trim(),
      examType: examType || 'ALL',
      note: (note || '').trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await docClient.send(new PutCommand({ TableName: 'ColumnIdeas', Item: item }));
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 更新（無効化 status='used' / resultTipId 設定 / 内容編集）
app.put('/admin/column-ideas/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { status, resultTipId, text, examType, note } = req.body;
    const sets = []; const names = {}; const values = {};
    if (status !== undefined) {
      sets.push('#s = :s'); names['#s'] = 'status'; values[':s'] = status;
      if (status === 'used') { sets.push('usedAt = :u'); values[':u'] = new Date().toISOString(); }
    }
    if (resultTipId !== undefined) { sets.push('resultTipId = :r'); values[':r'] = resultTipId; }
    if (text !== undefined) { sets.push('#t = :t'); names['#t'] = 'text'; values[':t'] = text; }
    if (examType !== undefined) { sets.push('examType = :e'); values[':e'] = examType; }
    if (note !== undefined) { sets.push('#n = :n'); names['#n'] = 'note'; values[':n'] = note; }
    if (sets.length === 0) return res.json({ success: true });
    await docClient.send(new UpdateCommand({
      TableName: 'ColumnIdeas',
      Key: { ideaId: req.params.id },
      UpdateExpression: 'SET ' + sets.join(', '),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 削除
app.delete('/admin/column-ideas/:id', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({ TableName: 'ColumnIdeas', Key: { ideaId: req.params.id } }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 回答済み問題ID一覧取得
app.get('/users/me/answered-questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;

    const statsResult = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId }
    }));

    let questionIds = (statsResult.Items || []).map(s => s.questionId);

    if (examType) {
      const examQuestionIds = await getExamQuestionIdSet(docClient, examType, { poolOnly: true });
      questionIds = questionIds.filter(id => examQuestionIds.has(id));
    }

    res.json({ questionIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 未正解問題ID一覧（incorrectCount > 0）
app.get('/users/me/incorrect-questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;

    const statsResult = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId }
    }));

    let stats = (statsResult.Items || []).filter(s => (s.incorrectCount ?? 0) > 0);

    if (examType) {
      const examQuestionIds = await getExamQuestionIdSet(docClient, examType, { poolOnly: true });
      stats = stats.filter(s => examQuestionIds.has(s.questionId));
    }

    const questionIds = stats.map(s => s.questionId);
    const counts = Object.fromEntries(stats.map(s => [s.questionId, s.incorrectCount ?? 0]));
    res.json({ questionIds, counts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 演習フィルタ用のユーザー別問題ステータスを1回のクエリで返す（answered/incorrect/weak/bookmarked）。
// しっかり対策・演習・模試の個別フェッチ（answered/incorrect/weak/bookmark）を1本に集約し、
// UserQuestionStats走査と examType 問題ID引きを各1回に抑える。
// weak = 演習済みで累計正答率(correctCount/総試行) <= WEAK_ACC(0.75)。
app.get('/users/me/question-status', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType } = req.query;
    const WEAK_ACC = 0.75;

    const statsResult = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId }
    }));
    let items = statsResult.Items || [];

    if (examType) {
      const examQuestionIds = await getExamQuestionIdSet(docClient, examType, { poolOnly: true });
      // includeCompanion=true: 演習設定モーダルの未回答数等が出題プール(includeCompanion付き
      // /questions?idsOnly=true)の母集団とズレないよう、companion側のIDも合流してから絞る。
      if (req.query.includeCompanion === 'true' && COMPANION_EXAM[examType]) {
        const companionIds = await getExamQuestionIdSet(docClient, COMPANION_EXAM[examType], { poolOnly: true });
        for (const id of companionIds) examQuestionIds.add(id);
      }
      items = items.filter(s => examQuestionIds.has(s.questionId));
    }

    // acc = 問題別の累計正答率(correctCount/総試行)。演習フィルタ「正答率フィルタ」が
    // 50/66/75% 未満などの任意しきい値でクライアント側判定できるよう問題別に返す。
    const answered = [], incorrect = {}, weak = [], bookmarked = [], acc = {};
    // reactions: questionId -> 'up' | 'down'。自分が押したものだけを返す
    // （他ユーザーを含む合計数はユーザー画面には出さない方針。集計は管理画面のみ）。
    const reactions = {};
    for (const s of items) {
      const c = s.correctCount ?? 0, i = s.incorrectCount ?? 0, total = c + i;
      answered.push(s.questionId); // 統計行がある=既回答扱い（既存 answered-questions と同一挙動）
      if (i > 0) incorrect[s.questionId] = i;
      if (total > 0) {
        const ratio = c / total;
        acc[s.questionId] = ratio;
        if (ratio <= WEAK_ACC) weak.push(s.questionId); // 後方互換（既存の weak 利用箇所を維持）
      }
      if (s.bookmarked) bookmarked.push(s.questionId);
      if (s.reaction === 'up' || s.reaction === 'down') reactions[s.questionId] = s.reaction;
    }

    res.json({ answered, incorrect, weak, bookmarked, acc, reactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 頻出ミス問題（incorrectCount >= minIncorrect）
app.get('/users/me/weak-questions', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, examType, minIncorrect = '2' } = req.query;
    const threshold = parseInt(minIncorrect);

    const statsResult = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId }
    }));

    let candidates = (statsResult.Items || [])
      .filter(s => (s.incorrectCount ?? 0) >= threshold);

    if (examType) {
      const examQuestionIds = await getExamQuestionIdSet(docClient, examType, { poolOnly: true });
      candidates = candidates.filter(s => examQuestionIds.has(s.questionId));
    }

    candidates.sort((a, b) => (b.incorrectCount ?? 0) - (a.incorrectCount ?? 0));
    const top = candidates.slice(0, 30);

    if (top.length === 0) return res.json({ items: [] });

    const questionItems = await Promise.all(
      top.map(s => docClient.send(new GetCommand({
        TableName: 'Questions',
        Key: { questionId: s.questionId },
        ProjectionExpression: 'questionId, questionText'
      })).then(r => r.Item))
    );

    const items = top.map((s, i) => ({
      questionId: s.questionId,
      questionText: questionItems[i]?.questionText ?? '',
      correctCount: s.correctCount ?? 0,
      incorrectCount: s.incorrectCount ?? 0,
    })).filter(item => item.questionText);

    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ブックマーク追加
app.post('/questions/:id/bookmark', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.body;
    const now = new Date().toISOString();
    await docClient.send(new UpdateCommand({
      TableName: T('UserQuestionStats'),
      Key: { userId, questionId: req.params.id },
      UpdateExpression: 'SET bookmarked = :b, lastAnsweredAt = if_not_exists(lastAnsweredAt, :now)',
      ExpressionAttributeValues: { ':b': true, ':now': now }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ブックマーク削除
app.delete('/questions/:id/bookmark', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.query;
    await docClient.send(new UpdateCommand({
      TableName: T('UserQuestionStats'),
      Key: { userId, questionId: req.params.id },
      UpdateExpression: 'SET bookmarked = :b',
      ExpressionAttributeValues: { ':b': false }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 問題へのリアクション（👍/👎）の登録・変更・取り消し。ログインユーザーのみ。
//
// 1ユーザー1問1票。UserQuestionStats(userId, questionId).reaction に 'up'|'down' を持ち、
// 取り消しは属性を削除する。Questions 側の reactionUp/reactionDown は表示用の集計で、
// globalAttempts/globalCorrect と同じく「本体の書き込みとは分けた条件付き加算」にする
// （集計の失敗でユーザーの操作自体を失敗させない）。
app.put('/questions/:id/reaction', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId, reaction } = req.body;
    const questionId = req.params.id;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (reaction !== 'up' && reaction !== 'down' && reaction !== null) {
      return res.status(400).json({ error: "reaction must be 'up', 'down' or null" });
    }

    // 変更前の値を読み、集計の差分を正しく出す（同じ値の再送では二重加算しない）
    const prevRes = await docClient.send(new GetCommand({
      TableName: T('UserQuestionStats'),
      Key: { userId, questionId },
      ProjectionExpression: 'reaction',
    }));
    const prev = prevRes.Item?.reaction ?? null;
    const next = reaction;
    if (prev === next) return res.json({ success: true, reaction: next });

    const now = new Date().toISOString();
    if (next === null) {
      await docClient.send(new UpdateCommand({
        TableName: T('UserQuestionStats'),
        Key: { userId, questionId },
        UpdateExpression: 'REMOVE reaction',
      }));
    } else {
      await docClient.send(new UpdateCommand({
        TableName: T('UserQuestionStats'),
        Key: { userId, questionId },
        UpdateExpression: 'SET reaction = :r, lastAnsweredAt = if_not_exists(lastAnsweredAt, :now)',
        ExpressionAttributeValues: { ':r': next, ':now': now },
      }));
    }

    // 集計の差分（prev を減らし next を増やす）
    const delta = { up: 0, down: 0 };
    if (prev === 'up') delta.up -= 1;
    if (prev === 'down') delta.down -= 1;
    if (next === 'up') delta.up += 1;
    if (next === 'down') delta.down += 1;
    if (delta.up !== 0 || delta.down !== 0) {
      try {
        await docClient.send(new UpdateCommand({
          TableName: 'Questions',
          Key: { questionId },
          UpdateExpression: 'ADD reactionUp :u, reactionDown :d',
          ConditionExpression: 'attribute_exists(questionId)',
          ExpressionAttributeValues: { ':u': delta.up, ':d': delta.down },
        }));
      } catch (e) { /* 削除済み問題・一時エラーは無視（ユーザーの操作は成功扱い） */ }
    }

    res.json({ success: true, reaction: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ブックマーク一覧取得
app.get('/users/me/bookmarks', async (req, res) => {
  try {
    const docClient = getClient();
    const { userId } = req.query;
    const result = await docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      FilterExpression: 'bookmarked = :b',
      ExpressionAttributeValues: { ':uid': userId, ':b': true }
    }));
    const questionIds = (result.Items || []).map(item => item.questionId);
    res.json({ questionIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Releases（リリースノート）──

// 公開用：全件取得（日付降順）
app.get('/releases', async (req, res) => {
  try {
    const docClient = getClient();
    const all = await warmCached('releases:all', WARM_TTL, () => scanAll(docClient, { TableName: 'Releases' }));
    const items = [...all].sort((a, b) => b.date.localeCompare(a.date));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：全件取得
app.get('/admin/releases', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new ScanCommand({ TableName: 'Releases' }));
    const items = (result.Items || []).sort((a, b) => b.date.localeCompare(a.date));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：追加
app.post('/admin/releases', async (req, res) => {
  try {
    const docClient = getClient();
    const { date, title, body } = req.body;
    if (!date || !title || !body) return res.status(400).json({ error: 'date, title, body are required' });
    const releaseId = uuidv4();
    await docClient.send(new PutCommand({
      TableName: 'Releases',
      Item: { releaseId, date, title, body, createdAt: new Date().toISOString() }
    }));
    res.json({ releaseId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：更新
app.put('/admin/releases/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { date, title, body } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: 'Releases',
      Key: { releaseId: req.params.id },
      UpdateExpression: 'SET #d = :date, title = :title, body = :body',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':date': date, ':title': title, ':body': body }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：削除
app.delete('/admin/releases/:id', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({
      TableName: 'Releases',
      Key: { releaseId: req.params.id }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── お知らせ（開発者からユーザーへのメッセージ）──

// 公開用：公開済みのみ取得（送信日時降順）
app.get('/announcements', async (req, res) => {
  try {
    const docClient = getClient();
    const all = await warmCached('announcements:all', WARM_TTL, () => scanAll(docClient, { TableName: 'Announcements' }));
    const items = all
      .filter(a => a.status === 'published')
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 既読状態取得（ログインユーザー用）
app.get('/announcements/read-status', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const docClient = getClient();
    const [prefs, all] = await Promise.all([
      docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: `userPrefs_${userId}` } })),
      warmCached('announcements:all', WARM_TTL, () => scanAll(docClient, { TableName: 'Announcements' })),
    ]);
    const readIds = prefs.Item?.readAnnouncementIds ?? [];
    const publishedIds = all.filter(a => a.status === 'published').map(a => a.announcementId);
    const hasUnread = publishedIds.some(id => !readIds.includes(id));
    res.json({ readIds, hasUnread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 既読登録（ログインユーザー用）
app.post('/announcements/mark-read', async (req, res) => {
  const { userId, ids } = req.body;
  if (!userId || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'userId and ids required' });
  try {
    const docClient = getClient();
    const key = { settingId: `userPrefs_${userId}` };
    const cur = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: key }));
    const existing = cur.Item?.readAnnouncementIds ?? [];
    const merged = Array.from(new Set([...existing, ...ids.filter(id => typeof id === 'string')]));
    await docClient.send(new UpdateCommand({
      TableName: 'AppSettings',
      Key: key,
      UpdateExpression: 'SET readAnnouncementIds = :ids, updatedAt = :now',
      ExpressionAttributeValues: { ':ids': merged, ':now': new Date().toISOString() },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：全件取得（下書き含む）
app.get('/admin/announcements', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new ScanCommand({ TableName: 'Announcements' }));
    const items = (result.Items || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：追加（下書きとして作成）
app.post('/admin/announcements', async (req, res) => {
  try {
    const docClient = getClient();
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title, body are required' });
    const announcementId = uuidv4();
    const now = new Date().toISOString();
    await docClient.send(new PutCommand({
      TableName: 'Announcements',
      Item: { announcementId, title, body, status: 'draft', createdAt: now, updatedAt: now, publishedAt: null }
    }));
    res.json({ announcementId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：更新（タイトル・本文のみ、ステータスは変更しない）
app.put('/admin/announcements/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { title, body } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: 'Announcements',
      Key: { announcementId: req.params.id },
      UpdateExpression: 'SET title = :title, body = :body, updatedAt = :updatedAt',
      ExpressionAttributeValues: { ':title': title, ':body': body, ':updatedAt': new Date().toISOString() }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：送信（公開）
app.post('/admin/announcements/:id/publish', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new UpdateCommand({
      TableName: 'Announcements',
      Key: { announcementId: req.params.id },
      UpdateExpression: 'SET #s = :published, publishedAt = :publishedAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':published': 'published', ':publishedAt': new Date().toISOString() }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：取り下げ
app.post('/admin/announcements/:id/unpublish', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new UpdateCommand({
      TableName: 'Announcements',
      Key: { announcementId: req.params.id },
      UpdateExpression: 'SET #s = :draft, publishedAt = :publishedAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':draft': 'draft', ':publishedAt': null }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：削除
app.delete('/admin/announcements/:id', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({
      TableName: 'Announcements',
      Key: { announcementId: req.params.id }
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 連絡先メッセージ送信（認証不要） ──
app.post('/contact', async (req, res) => {
  try {
    const docClient = getClient();
    const { subject, message, userId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const item = {
      messageId: uuidv4(),
      subject: subject?.trim() || '',
      message: message.trim(),
      userId: userId || 'anonymous',
      sentAt: new Date().toISOString(),
    };
    await docClient.send(new PutCommand({ TableName: 'ContactMessages', Item: item }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：メッセージ一覧
app.get('/admin/messages', requireAdmin, async (req, res) => {
  try {
    const docClient = getClient();
    const data = await docClient.send(new ScanCommand({ TableName: 'ContactMessages' }));
    const items = (data.Items || []).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：メッセージ削除
app.delete('/admin/messages/:id', requireAdmin, async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({
      TableName: 'ContactMessages',
      Key: { messageId: req.params.id },
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DailyServices（今日のサービス）──

// 公開用：アクティブなサービス一覧（日替わり選択用）
app.get('/daily-service', async (req, res) => {
  try {
    const docClient = getClient();

    // ?list=1 指定時は全件一覧を返す（図鑑の母数を実データから動的算出するため）。
    // 提供状態(deprecationNote等)も返し、廃止予定の警告表示に使う。
    if (req.query.list) {
      const allItems = await getDailyServicesAll(docClient);
      const services = allItems
        .filter(isServiceUnlockable)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(i => ({
          serviceId: i.serviceId,
          name: i.name,
          shortName: i.shortName || '',
          category: i.category || '',
          icon: i.icon || '',
          docUrl: i.docUrl || '',
          deprecationNote: i.deprecationNote || undefined,
          deprecationStatus: i.deprecationStatus || undefined,
        }));
      return res.json({ services, total: services.length });
    }

    // ?serviceId= 指定時は特定サービスを返す（サービス図鑑の on-demand フェッチ用）
    if (req.query.serviceId) {
      const allItems = await getDailyServicesAll(docClient);
      const svc = allItems.find(i => i.serviceId === req.query.serviceId && i.serviceId !== '_schedule_');
      return res.json({ service: svc ?? null });
    }

    const allItems = await getDailyServicesAll(docClient);

    // '_schedule_' は日付→serviceId のスケジュール管理用アイテム（一般アイテムから除外）
    const scheduleItem = allItems.find(i => i.serviceId === '_schedule_');
    const items = allItems
      .filter(isServiceUnlockable)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (items.length === 0) return res.json({ service: null });

    // 今日の日付（JST）
    const jstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    // userId がある場合、そのユーザーの解放済みサービス・当日の解放状況を取得
    let alreadyUnlocked = false;
    let unlockedIds = [];
    let recordTodayId = null;
    if (req.query.userId) {
      try {
        const encResult = await docClient.send(new GetCommand({
          TableName: T('EncyclopediaUnlocks'),
          Key: { userId: req.query.userId },
        }));
        if (encResult.Item?.unlockDate === jstDate) {
          alreadyUnlocked = true;
          recordTodayId = encResult.Item?.todayServiceId || null;
        }
        const unlocks = JSON.parse(encResult.Item?.unlocks || '{}');
        unlockedIds = Object.keys(unlocks).filter(k => k && k !== '_schedule_');
      } catch {}
    }

    // userId がある場合は「そのユーザーがまだ見ていない（解放していない）サービス」から
    // 当日分を決定し、常に初めましてにする。当日すでに解放済みなら見たものを返す（一貫性）。
    // 同日内は userId+日付 のハッシュで安定。再抽選(rerollSeed)時も未見プールから選ぶ。
    if (req.query.userId) {
      // 再抽選(rerollSeed)時は「当日すでに解放済みでも別の未見サービスを引き直せる」ようにするため、
      // 解放済み短絡は rerollSeed が無い通常アクセスのみに適用する。
      if (alreadyUnlocked && recordTodayId && !req.query.rerollSeed) {
        const seen = items.find(s => s.serviceId === recordTodayId);
        if (seen) return res.json({ service: seen, alreadyUnlocked });
      }
      // 再抽選では今日すでに解放したサービスも除外し、毎回別の未見サービスを返す
      const excluded = new Set(unlockedIds);
      if (req.query.rerollSeed && recordTodayId) excluded.add(recordTodayId);
      const unseen = items.filter(s => !excluded.has(s.serviceId));
      const pool = unseen.length > 0 ? unseen : items;
      const str = req.query.userId + jstDate + (req.query.rerollSeed || '');
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return res.json({ service: pool[Math.abs(hash) % pool.length], alreadyUnlocked });
    }

    // 匿名アクセス: 従来どおりグローバルの _schedule_ キューを使用（全ユーザー共通・偏りなく一巡）
    const schedule = JSON.parse(scheduleItem?.schedule || '{}');
    if (schedule[jstDate]) {
      const locked = items.find(s => s.serviceId === schedule[jstDate]);
      if (locked) return res.json({ service: locked, alreadyUnlocked });
    }

    // まだ決まっていない → シャッフルキューから今日のサービスを確定して保存
    // キューを使うことで全サービスを偏りなく一巡してから繰り返す（300件なら300日周期）
    let queue = scheduleItem?.queue ? JSON.parse(scheduleItem.queue) : null;
    let pointer = scheduleItem?.pointer ?? 0;

    // キュー未生成 or 全件消化済み → 全サービスIDをシャッフルしてキューを再生成
    if (!queue || pointer >= queue.length) {
      queue = items.map(i => i.serviceId);
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }
      pointer = 0;
    }

    const todayId = queue[pointer];
    const service = items.find(i => i.serviceId === todayId) ?? items[0];
    schedule[jstDate] = service.serviceId;
    pointer++;

    // 古いエントリを削除（直近90日分のみ保持）
    const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - 90 * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(schedule)) {
      if (d < cutoff) delete schedule[d];
    }

    await docClient.send(new PutCommand({
      TableName: 'DailyServices',
      Item: {
        serviceId: '_schedule_',
        schedule: JSON.stringify(schedule),
        queue: JSON.stringify(queue),
        pointer,
      },
    }));

    res.json({ service, alreadyUnlocked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：全件取得
app.get('/admin/daily-services', async (req, res) => {
  try {
    const docClient = getClient();
    const allItems = await getDailyServicesAll(docClient);
    const items = allItems
      .filter(i => i.serviceId !== '_schedule_')
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：追加
app.post('/admin/daily-services', async (req, res) => {
  try {
    const docClient = getClient();
    const { name, shortName, category, icon, description, trivia, docUrl, order, isActive } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'name and description are required' });
    const serviceId = uuidv4();
    await docClient.send(new PutCommand({
      TableName: 'DailyServices',
      Item: {
        serviceId,
        name: name.trim(),
        shortName: (shortName || '').trim(),
        category: (category || '').trim(),
        icon: (icon || '☁️').trim(),
        description: description.trim(),
        trivia: (trivia || '').trim(),
        docUrl: (docUrl || '').trim(),
        order: Number(order) || 0,
        isActive: isActive !== false,
        createdAt: new Date().toISOString(),
      },
    }));
    _dailyServicesCache = null; // キャッシュ無効化
    res.json({ serviceId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：更新
app.put('/admin/daily-services/:id', async (req, res) => {
  try {
    const docClient = getClient();
    const { name, shortName, category, icon, description, trivia, docUrl, order, isActive } = req.body;
    await docClient.send(new UpdateCommand({
      TableName: 'DailyServices',
      Key: { serviceId: req.params.id },
      UpdateExpression: 'SET #n = :name, shortName = :sn, category = :cat, icon = :icon, description = :desc, trivia = :tv, docUrl = :url, #o = :order, isActive = :active',
      ExpressionAttributeNames: { '#n': 'name', '#o': 'order' },
      ExpressionAttributeValues: {
        ':name': (name || '').trim(),
        ':sn': (shortName || '').trim(),
        ':cat': (category || '').trim(),
        ':icon': (icon || '☁️').trim(),
        ':desc': (description || '').trim(),
        ':tv': (trivia || '').trim(),
        ':url': (docUrl || '').trim(),
        ':order': Number(order) || 0,
        ':active': isActive !== false,
      },
    }));
    _dailyServicesCache = null; // キャッシュ無効化
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 管理者用：削除
app.delete('/admin/daily-services/:id', async (req, res) => {
  try {
    const docClient = getClient();
    await docClient.send(new DeleteCommand({
      TableName: 'DailyServices',
      Key: { serviceId: req.params.id },
    }));
    _dailyServicesCache = null; // キャッシュ無効化
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── テーマ設定 ───────────────────────────────────────────────────────────────
app.get('/admin/settings/admins', async (req, res) => {
  try {
    const emails = await getAdminEmails();
    res.json({ emails });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/admin/settings/admins', async (req, res) => {
  try {
    const docClient = getClient();
    const { emails } = req.body;
    if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails must be an array' });
    const filtered = emails.map(e => String(e).trim().toLowerCase()).filter(e => e && e.includes('@'));
    await docClient.send(new PutCommand({
      TableName: 'AppSettings',
      Item: { settingId: 'admins', emails: JSON.stringify(filtered), updatedAt: new Date().toISOString() },
    }));
    res.json({ success: true, emails: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/settings/about', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'about' } }));
    if (!result.Item) return res.json({ sections: {} });
    const sections = JSON.parse(result.Item.sections || '{}');
    res.json({ sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/admin/settings/about', requireAdmin, async (req, res) => {
  try {
    const docClient = getClient();
    const { sections } = req.body;
    if (!sections || typeof sections !== 'object') return res.status(400).json({ error: 'sections required' });
    await docClient.send(new PutCommand({
      TableName: 'AppSettings',
      Item: { settingId: 'about', sections: JSON.stringify(sections), updatedAt: new Date().toISOString() },
    }));
    res.json({ success: true, sections });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/settings/theme', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'theme' } }));
    if (!result.Item) return res.json({ colors: {}, enabled: true });
    const colors = JSON.parse(result.Item.colors || '{}');
    const enabled = result.Item.enabled !== false; // default true
    res.json({ colors, enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/admin/settings/theme', requireAdmin, async (req, res) => {
  try {
    const docClient = getClient();
    const { colors, enabled } = req.body;
    if (!colors || typeof colors !== 'object') return res.status(400).json({ error: 'colors required' });
    await docClient.send(new PutCommand({
      TableName: 'AppSettings',
      Item: {
        settingId: 'theme',
        colors: JSON.stringify(colors),
        enabled: enabled !== false,
        updatedAt: new Date().toISOString(),
      },
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 合格コメント ──
app.get('/settings/pass-comments', async (req, res) => {
  try {
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'passComments' } }));
    if (!result.Item) return res.json({ comments: {} });
    res.json({ comments: JSON.parse(result.Item.comments || '{}') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/admin/pass-comments', requireAdmin, async (req, res) => {
  try {
    const docClient = getClient();
    const { examType, comment } = req.body;
    if (!examType) return res.status(400).json({ error: 'examType required' });
    const existing = await docClient.send(new GetCommand({ TableName: 'AppSettings', Key: { settingId: 'passComments' } }));
    const comments = JSON.parse(existing.Item?.comments || '{}');
    if (comment === null || comment === undefined || comment === '') {
      delete comments[examType];
    } else {
      comments[examType] = comment;
    }
    await docClient.send(new PutCommand({
      TableName: 'AppSettings',
      Item: { settingId: 'passComments', comments: JSON.stringify(comments), updatedAt: new Date().toISOString() },
    }));
    res.json({ success: true, comments });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Encyclopedia unlocks sync ──
app.get('/users/me/encyclopedia-unlocks', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: T('EncyclopediaUnlocks'),
      Key: { userId },
    }));
    if (!result.Item) return res.json({ unlocks: {}, unlockDate: null, todayServiceId: null, services: {} });

    const unlocks = JSON.parse(result.Item.unlocks || '{}');
    const serviceIds = Object.keys(unlocks).filter(id => id && id !== '_schedule_');

    // アンロック済みサービスの詳細データをバッチ取得（新デバイスでもアイコン表示できるよう）
    const services = {};
    for (let i = 0; i < serviceIds.length; i += 100) {
      const chunk = serviceIds.slice(i, i + 100).map(id => ({ serviceId: id }));
      try {
        const batch = await docClient.send(new BatchGetCommand({
          RequestItems: { DailyServices: { Keys: chunk } },
        }));
        for (const item of (batch.Responses?.DailyServices || [])) {
          services[item.serviceId] = item;
        }
      } catch (_) { /* バッチ取得失敗は非致命的 */ }
    }

    res.json({
      unlocks,
      unlockDate: result.Item.unlockDate || null,
      todayServiceId: result.Item.todayServiceId || null,
      services,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/users/me/encyclopedia-unlocks', async (req, res) => {
  try {
    const { userId, unlocks, unlockDate, todayServiceId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const docClient = getClient();
    await docClient.send(new PutCommand({
      TableName: T('EncyclopediaUnlocks'),
      Item: {
        userId,
        unlocks: JSON.stringify(unlocks || {}),
        unlockDate: unlockDate || null,
        todayServiceId: todayServiceId || null,
        updatedAt: new Date().toISOString(),
      },
    }));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ユーザーポイント ──

// ── おひねり（specs/006）: 上限の確認・購入 ──
app.get('/users/me/limits', async (req, res) => {
  try {
    const cfg = await getOhineriConfig();
    const limits = await loadLimits(getClient(), req.authSub, cfg);
    res.json({ ...limits, purchaseEnabled: cfg.enabled, priceYen: ohineri.PRICE_YEN });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/users/me/checkout', async (req, res) => {
  try {
    const cfg = await getOhineriConfig();
    const stripe = getStripe();
    if (!cfg.enabled || !stripe) return res.status(503).json({ error: 'Not available' });
    const limits = await loadLimits(getClient(), req.authSub, cfg);
    if (limits.unlimited) return res.status(409).json({ error: 'Already purchased' });
    // メールはトークンから取る（クライアントの申告は信用しない）
    const payload = await jwtVerifier.verify((req.headers.authorization || '').slice(7));
    const session = await stripe.checkout.sessions.create(
      ohineri.buildCheckoutParams({ sub: req.authSub, email: payload.email, origin: req.headers.origin })
    );
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 決済ページから戻った直後に、Stripe API で支払いを確認して購入を記録する。
// URL の session_id は「確認の対象」を示すだけで、本人かつ支払い済みかは Stripe の応答で判断する。
// Webhook より先に戻ってきても反映が遅れないようにするため（記録は冪等なので Webhook と二重にならない）。
app.post('/users/me/checkout/confirm', async (req, res) => {
  try {
    const stripe = getStripe();
    const { sessionId } = req.body || {};
    if (!stripe || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) return res.status(400).json({ error: 'Bad request' });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const purchase = ohineri.purchaseFromSession(session);
    if (purchase && purchase.userId === req.authSub) {
      await ohineri.recordPurchase({ docClient: getClient(), PutCommand, table: T('UserEntitlements'), purchase });
    }
    const cfg = await getOhineriConfig();
    const limits = await loadLimits(getClient(), req.authSub, cfg);
    res.json({ ...limits, purchaseEnabled: cfg.enabled, priceYen: ohineri.PRICE_YEN });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/users/me/points', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: T('UserPoints'),
      Key: { userId },
    }));
    res.json({ points: result.Item?.points ?? 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/users/me/points', async (req, res) => {
  try {
    const { userId, points } = req.body;
    if (!userId || points === undefined) return res.status(400).json({ error: 'userId and points required' });
    const safePoints = Math.max(0, Math.round(Number(points)));
    const docClient = getClient();
    await docClient.send(new PutCommand({
      TableName: T('UserPoints'),
      Item: { userId, points: safePoints, updatedAt: new Date().toISOString() },
    }));
    res.json({ points: safePoints });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 日次演習カウント（サーバ集計・デバイス間合算） ──
// セッション終了ごとにクライアントが加算をPOSTする。DynamoDBのアトミック加算のため
// 複数デバイスの同日演習も正しく合算される（localStorage同期は不要）。

const jstDateStr = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

app.post('/users/me/daily-progress', async (req, res) => {
  try {
    const { userId, examType, count } = req.body;
    const n = Math.round(Number(count));
    if (!userId || !examType || !Number.isFinite(n) || n <= 0 || n > 1000) {
      return res.status(400).json({ error: 'userId, examType and positive count required' });
    }
    const key = `${examType}_${jstDateStr()}`;
    const totalKey = `total_${examType}`;
    const docClient = getClient();
    const result = await docClient.send(new UpdateCommand({
      TableName: 'AppSettings',
      Key: { settingId: `dailyProgress_${userId}` },
      UpdateExpression: 'SET #k = if_not_exists(#k, :z) + :n, #t = if_not_exists(#t, :z) + :n, updatedAt = :now',
      ExpressionAttributeNames: { '#k': key, '#t': totalKey },
      ExpressionAttributeValues: { ':z': 0, ':n': n, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    }));
    res.json({ count: result.Attributes?.[key] ?? n, total: result.Attributes?.[totalKey] ?? n, date: jstDateStr() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/users/me/daily-progress', async (req, res) => {
  try {
    const { userId, examType } = req.query;
    if (!userId || !examType) return res.status(400).json({ error: 'userId and examType required' });
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: 'AppSettings',
      Key: { settingId: `dailyProgress_${userId}` },
    }));
    const item = result.Item ?? {};
    const today = jstDateStr();
    // 肥大化防止: 日付付き属性が溜まったら14日より古いものを剪定（ベストエフォート）
    const dated = Object.keys(item).filter(k => /_\d{4}-\d{2}-\d{2}$/.test(k));
    if (dated.length > 100) {
      const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - 14 * 86400000).toISOString().slice(0, 10);
      const stale = dated.filter(k => k.slice(-10) < cutoff).slice(0, 80);
      if (stale.length) {
        const names = {};
        stale.forEach((k, i) => { names[`#s${i}`] = k; });
        docClient.send(new UpdateCommand({
          TableName: 'AppSettings',
          Key: { settingId: `dailyProgress_${userId}` },
          UpdateExpression: 'REMOVE ' + stale.map((_, i) => `#s${i}`).join(', '),
          ExpressionAttributeNames: names,
        })).catch(() => {});
      }
    }
    res.json({ count: item[`${examType}_${today}`] ?? 0, total: item[`total_${examType}`] ?? 0, date: today });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ユーザー設定（目標資格などのデバイス間同期） ──

app.get('/users/me/preferences', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const docClient = getClient();
    const result = await docClient.send(new GetCommand({
      TableName: 'AppSettings',
      Key: { settingId: `userPrefs_${userId}` },
    }));
    res.json({
      targetExam:    result.Item?.targetExam    ?? null,
      examDates:     result.Item?.examDates     ?? {},
      dailyGoal:     result.Item?.dailyGoal     ?? null,
      kv:            result.Item?.kv            ?? {},
      obtainedCerts: result.Item?.obtainedCerts ?? [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/users/me/preferences', async (req, res) => {
  try {
    const { userId, targetExam, examDates, dailyGoal, kvPatch, obtainedCerts } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const docClient = getClient();

    const sets = ['updatedAt = :now'];
    const names = {};
    const values = { ':now': new Date().toISOString() };

    // 汎用KV同期（設定・演習実績フラグ等のデバイス間同期）。
    // kvPatch: { key: { v: string|null, t: epochMs } }。v=null は削除トゥームストーン。
    // キーごとに Last-Writer-Wins（t が新しい方を採用）でマージし、肥大化防止の剪定を行う。
    if (kvPatch !== undefined && kvPatch !== null && typeof kvPatch === 'object') {
      const cur = await docClient.send(new GetCommand({
        TableName: 'AppSettings',
        Key: { settingId: `userPrefs_${userId}` },
      }));
      const kv = cur.Item?.kv ?? {};
      const now = Date.now();
      for (const [k, e] of Object.entries(kvPatch)) {
        if (!e || typeof e.t !== 'number') continue;
        if (k.length > 200) continue;
        if (typeof e.v === 'string' && e.v.length > 8192) continue; // 1キー8KB上限
        const prev = kv[k];
        if (prev && typeof prev.t === 'number' && prev.t >= e.t) continue;
        kv[k] = { v: e.v ?? null, t: e.t };
      }
      // 剪定: 日付付きカウンタ系は14日、それ以外は90日、削除トゥームストーンは30日で破棄
      const DAY = 86400000;
      for (const [k, e] of Object.entries(kv)) {
        const t = typeof e?.t === 'number' ? e.t : 0;
        const dated = k.startsWith('dailyQCount_') || k.startsWith('dailyGoalReward_');
        if ((dated && t < now - 14 * DAY) || t < now - 90 * DAY || (e?.v == null && t < now - 30 * DAY)) {
          delete kv[k];
        }
      }
      sets.push('#kv = :kv');
      names['#kv'] = 'kv';
      values[':kv'] = kv;
    }

    if (targetExam !== undefined) {
      sets.push('#targetExam = :targetExam');
      names['#targetExam'] = 'targetExam';
      values[':targetExam'] = targetExam ?? null;
    }
    if (examDates !== undefined) {
      sets.push('#examDates = :examDates');
      names['#examDates'] = 'examDates';
      values[':examDates'] = examDates;
    }
    if (dailyGoal !== undefined) {
      sets.push('#dailyGoal = :dailyGoal');
      names['#dailyGoal'] = 'dailyGoal';
      values[':dailyGoal'] = dailyGoal;
    }
    if (obtainedCerts !== undefined && Array.isArray(obtainedCerts)) {
      sets.push('#obtainedCerts = :obtainedCerts');
      names['#obtainedCerts'] = 'obtainedCerts';
      values[':obtainedCerts'] = obtainedCerts;
    }

    await docClient.send(new UpdateCommand({
      TableName: 'AppSettings',
      Key: { settingId: `userPrefs_${userId}` },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── 管理者によるユーザーデータ削除 ──

const USER_POOL_ID = 'ap-northeast-1_KIOFciGhQ';

async function findCognitoUserByEmail(email) {
  const client = new CognitoIdentityProviderClient({ region: 'ap-northeast-1' });
  const result = await client.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${email}"`,
    Limit: 1,
  }));
  const users = result.Users || [];
  if (users.length === 0) return null;
  const user = users[0];
  const sub = (user.Attributes || []).find(a => a.Name === 'sub')?.Value;
  return sub ? { userId: sub, username: user.Username } : null;
}


// ユーザーデータ削除の共通処理
async function executeUserDataDeletion(docClient, userId) {
  const deleteItems = async (table, keys) => {
    if (keys.length === 0) return;
    await Promise.all(keys.map(key => docClient.send(new DeleteCommand({ TableName: table, Key: key }))));
  };

  const [qsResult, tsResult, sessResult] = await Promise.all([
    docClient.send(new QueryCommand({
      TableName: T('UserQuestionStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, questionId',
    })),
    docClient.send(new QueryCommand({
      TableName: T('UserTagStats'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, tagId',
    })),
    docClient.send(new QueryCommand({
      TableName: T('Sessions'),
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, sessionId',
    })),
  ]);

  await Promise.all([
    deleteItems(T('UserQuestionStats'), (qsResult.Items || []).map(i => ({ userId: i.userId, questionId: i.questionId }))),
    deleteItems(T('UserTagStats'), (tsResult.Items || []).map(i => ({ userId: i.userId, tagId: i.tagId }))),
  ]);

  const sessionIds = (sessResult.Items || []).map(s => s.sessionId);
  for (const sessionId of sessionIds) {
    let lastKey;
    do {
      const ansResult = await docClient.send(new QueryCommand({
        TableName: T('UserAnswers'),
        KeyConditionExpression: 'userId = :uid AND begins_with(questionIdTimestamp, :prefix)',
        ExpressionAttributeValues: { ':uid': userId, ':prefix': `${sessionId}#` },
        ExclusiveStartKey: lastKey,
        ProjectionExpression: 'userId, questionIdTimestamp',
      }));
      await deleteItems(T('UserAnswers'), (ansResult.Items || []).map(a => ({ userId: a.userId, questionIdTimestamp: a.questionIdTimestamp })));
      lastKey = ansResult.LastEvaluatedKey;
    } while (lastKey);
  }
  await deleteItems(T('Sessions'), sessionIds.map(sid => ({ userId, sessionId: sid })));

  try { await docClient.send(new DeleteCommand({ TableName: T('EncyclopediaUnlocks'), Key: { userId } })); } catch {}
  try { await docClient.send(new DeleteCommand({ TableName: T('UserPoints'), Key: { userId } })); } catch {}

  const reportsResult = await docClient.send(new ScanCommand({
    TableName: 'Reports',
    FilterExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ProjectionExpression: 'reportId',
  }));
  await deleteItems('Reports', (reportsResult.Items || []).map(i => ({ reportId: i.reportId })));

  // クライアント側localStorageリセット用タイムスタンプ
  const resetAt = new Date().toISOString();
  await docClient.send(new PutCommand({
    TableName: 'AppSettings',
    Item: { settingId: `userReset_${userId}`, userId, resetAt },
  }));
}

// 管理者: メールアドレス指定で直接ユーザーデータを削除（admin認証のみで実行可能）
app.post('/admin/direct-delete', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const cognitoUser = await findCognitoUserByEmail(email);
    if (!cognitoUser) return res.status(404).json({ error: 'User not found' });

    const docClient = getClient();
    await executeUserDataDeletion(docClient, cognitoUser.userId);

    res.json({ success: true, userId: cognitoUser.userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = app;
