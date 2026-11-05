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
  if (!viewport || previous.parentElement !== viewport) return;

  const { visibility, zIndex } = previous.style;
  // 在渲染文档内锁定交互，iframe 内的命中检测也能看到页面不可点击。
  const pages = [previous, current].map(frame => frame.contentDocument?.documentElement ?? frame);
  const wasInert = pages.map(page => page.inert);
  const sliding = direction === 'push' ? current : previous;
  const transform = direction === 'push' ? ['translateX(100%)', 'translateX(0)'] : ['translateX(0)', 'translateX(100%)'];
  let animation: Animation | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // activate 已更新逻辑上的当前页。旧页仅参与绘制，转场期间页面区域不可交互。
    for (const page of pages) page.inert = true;
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
    pages.forEach((page, index) => { page.inert = wasInert[index]; });
  }
}
