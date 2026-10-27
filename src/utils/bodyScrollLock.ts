// オーバーレイ表示中のスクロール・横スワイプを禁止するユーティリティ。
// iOS Safari 対応で position:fixed 方式を使う。
// 複数オーバーレイが重なっても安全なよう参照カウンタで管理する。
//
// 縦スクロール禁止: position:fixed（モバイル・デスクトップ共通）
// 横スワイプ禁止: touchmove preventDefault（モバイルのみ。デスクトップはタッチイベントが発生しないため無害）

let lockCount = 0;
let storedScrollY = 0;
let startX = 0;
let startY = 0;

function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 1) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }
}

function onTouchMove(e: TouchEvent) {
  if (e.touches.length !== 1) return;
  const dx = Math.abs(e.touches[0].clientX - startX);
  const dy = Math.abs(e.touches[0].clientY - startY);
  // 横方向が主体のスワイプ（ブラウザバックなど）を禁止
  if (dx > dy) e.preventDefault();
}

// lockBodyScroll で止めたオーバーレイが1つ以上開いているか
export function isBodyScrollLocked(): boolean {
  return lockCount > 0;
}

export function lockBodyScroll(): () => void {
  if (lockCount === 0) {
    storedScrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${storedScrollY}px`;
    document.body.style.width = '100%';
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  }
  lockCount++;
  return () => {
    lockCount--;
    if (lockCount === 0) {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, storedScrollY);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
    }
  };
}
