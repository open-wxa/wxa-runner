const DURATION = 300;

export function canAnimatePageTransition(frame: HTMLIFrameElement): boolean {
  return frame.isConnected && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export async function animatePageTransition(
  previous: HTMLIFrameElement,
  current: HTMLIFrameElement,
  direction: 'push' | 'pop'
): Promise<void> {
  const viewport = current.parentElement;
  const head = current.contentDocument?.head;
  if (!viewport || previous.parentElement !== viewport || !head) return;

  const { visibility, zIndex } = previous.style;
  const outgoing = previous.contentDocument?.documentElement ?? previous;
  const wasInert = outgoing.inert;
  // 新页面只阻止指针命中。限制要在 iframe 内生效，同时让基础库正常聚焦输入框。
  const pointerLock = head.ownerDocument.createElement('style');
  pointerLock.textContent = '* { pointer-events: none !important; }';
  const sliding = direction === 'push' ? current : previous;
  const transform = direction === 'push' ? ['translateX(100%)', 'translateX(0)'] : ['translateX(0)', 'translateX(100%)'];
  let animation: Animation | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // activate 已更新逻辑上的当前页，旧页只参与绘制。
    outgoing.inert = true;
    head.append(pointerLock);
    previous.style.visibility = 'visible';
    if (direction === 'pop') previous.style.zIndex = '2';
    animation = sliding.animate({ transform }, { duration: DURATION, easing: 'ease', fill: 'both' });
    await Promise.race([
      animation.finished.catch(() => undefined),
      // 切到后台后，浏览器可能暂停动画，路由队列仍需继续。
      new Promise<void>(resolve => { timer = setTimeout(resolve, DURATION + 60); })
    ]);
  } finally {
    clearTimeout(timer);
    animation?.cancel();
    previous.style.visibility = visibility;
    previous.style.zIndex = zIndex;
    outgoing.inert = wasInert;
    pointerLock.remove();
  }
}
