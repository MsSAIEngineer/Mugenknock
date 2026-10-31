import { API_ENDPOINT, EXAM_TYPES } from '../constants';

/**
 * 目標資格を変更したときに「サクッと演習」「しっかり対策」の設定を初期化する。
 *
 * これらの設定は資格に紐づく内容（出題ドメイン・出題数・フィルタ）を持つ。
 * 特に quickExercisePrefs の domains は資格ごとのドメイン配列インデックスで
 * 保存されるため、資格をまたいで引き継ぐと別ドメインを指してしまう。
 * キーを削除すると読み出し側が {} を得て既定値に戻る。
 *
 * kvSync が removeItem を拾ってサーバへも反映するため、他端末にも初期化が伝播する。
 * 同じ資格を選び直したときは何もしない（不要な同期を発生させない）。
 */
export function resetExercisePrefsOnExamChange(
  uid: string,
  prevExam: string | null,
  nextExam: string,
): void {
  if (prevExam === nextExam) return;
  localStorage.removeItem(`quickExercisePrefs_${uid}`);
  localStorage.removeItem(`focusedExercisePrefs_${uid}`);
}

export async function syncTargetExamToServer(userId: string, uid: string, examType: string | null): Promise<void> {
  try {
    await fetch(`${API_ENDPOINT}/users/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, targetExam: examType }),
    });
  } catch {}
}

export async function loadTargetExamFromServer(userId: string, uid: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_ENDPOINT}/users/me/preferences?userId=${encodeURIComponent(userId)}`);
    const data = await res.json();
    const serverExam: string | null = data.targetExam ?? null;
    if (serverExam) {
      const localExam = localStorage.getItem(`targetExam_${uid}`);
      if (localExam !== serverExam) {
        localStorage.setItem(`targetExam_${uid}`, serverExam);
        window.dispatchEvent(new CustomEvent('targetExamChanged', { detail: serverExam }));
      }
    }

    applyServerPrefs(userId, uid, data);
    return serverExam;
  } catch {
    return null;
  }
}

/**
 * GET /users/me/preferences の受験日・目標演習量・取得済資格を端末へ反映する（サーバーが正。2026-10-31〜）。
 *
 * 以前は受験日を「サーバーにある日付だけ上書き」、取得済資格を「端末とサーバーの和集合」にしていたため、
 * ある端末で消した受験日や外した資格が、別の端末では残り続けた（その端末で保存すると復活もした）。
 * サーバーが項目を一度も持っていない（null）ときだけ、端末の値をサーバーへ上げる（移行用）。
 * 変わった値はイベントで知らせる（examDateChanged / dailyGoalChanged / obtainedCertsChanged）。
 */
export function applyServerPrefs(
  userId: string,
  uid: string,
  data: { examDates?: Record<string, string> | null; dailyGoal?: number | null; obtainedCerts?: string[] | null },
): void {
  // 受験日
  if (data.examDates && typeof data.examDates === 'object') {
    for (const et of EXAM_TYPES) {
      const key = `examDate_${et}_${uid}`;
      const server = data.examDates[et] || '';
      const local = localStorage.getItem(key) ?? '';
      if (server === local) continue;
      if (server) localStorage.setItem(key, server);
      else localStorage.removeItem(key);
      window.dispatchEvent(new CustomEvent('examDateChanged', { detail: { examType: et, date: server } }));
    }
  } else if (data.examDates === null) {
    const local = collectExamDatesFromLocal(uid, EXAM_TYPES);
    if (Object.keys(local).length > 0) syncPreferencesToServer(userId, uid, { examDates: local });
  }

  // 目標演習量
  if (data.dailyGoal != null && localStorage.getItem(`dailyGoal_${uid}`) !== String(data.dailyGoal)) {
    localStorage.setItem(`dailyGoal_${uid}`, String(data.dailyGoal));
    window.dispatchEvent(new CustomEvent('dailyGoalChanged', { detail: Number(data.dailyGoal) }));
  }

  // 取得済資格
  if (Array.isArray(data.obtainedCerts)) {
    const next = JSON.stringify(data.obtainedCerts);
    if (localStorage.getItem(`obtainedCerts_${uid}`) !== next) {
      localStorage.setItem(`obtainedCerts_${uid}`, next);
      window.dispatchEvent(new CustomEvent('obtainedCertsChanged', { detail: data.obtainedCerts }));
    }
  } else if (data.obtainedCerts === null) {
    try {
      const local: string[] = JSON.parse(localStorage.getItem(`obtainedCerts_${uid}`) ?? '[]');
      if (local.length > 0) syncPreferencesToServer(userId, uid, { obtainedCerts: local });
    } catch {}
  }
}

/** examDates と dailyGoal をサーバーに保存する */
export async function syncPreferencesToServer(
  userId: string,
  uid: string,
  patch: { examDates?: Record<string, string>; dailyGoal?: number; obtainedCerts?: string[] },
): Promise<void> {
  try {
    await fetch(`${API_ENDPOINT}/users/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, ...patch }),
    });
  } catch {}
}

/** localStorage から全資格の受験日を収集して返す */
export function collectExamDatesFromLocal(uid: string, examTypes: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const et of examTypes) {
    const d = localStorage.getItem(`examDate_${et}_${uid}`);
    if (d) result[et] = d;
  }
  return result;
}
