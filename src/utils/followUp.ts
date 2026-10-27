// 解いた問題の「もっと知りたい」質問（specs/009-follow-up-questions）。
// 質問は夜間スクリプト（11-add-follow-up-questions.py）が作り、そのときの選択肢のハッシュを followUpBasis に残す。
// 選択肢があとから直されたら古い質問は出さない。ハッシュはスクリプトと同じ FNV-1a 32bit（choices を \n でつないだ UTF-8）。

export type FollowUpQuestion = { angle: string; text: string; createdAt?: string };

export function followUpBasis(choices: string[]): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(choices.join('\n'))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function validFollowUps(q: { choices?: string[]; followUpQuestions?: FollowUpQuestion[]; followUpBasis?: string }): FollowUpQuestion[] {
  const fu = q.followUpQuestions;
  if (!Array.isArray(fu) || fu.length === 0 || !q.choices || !q.followUpBasis) return [];
  return q.followUpBasis === followUpBasis(q.choices) ? fu.filter(f => f && typeof f.text === 'string' && f.text) : [];
}
