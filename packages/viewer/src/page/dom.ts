/** 查看页面用的 DOM 小工具：建元素、16px 线性图标 */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((event: any) => void)>;

/**
 * 建元素。属性里 on 开头的是事件（onClick → click），class 写类名，true 写成空属性，false / null / undefined 跳过
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = String(value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const PATHS = {
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
  refresh: 'M13.25 8A5.25 5.25 0 1 1 11.7 4.3M13.25 2.75v3h-3',
  import: 'M8 10V2.75M5.25 5.5 8 2.75l2.75 2.75M2.75 10.25v2a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-2',
  panel: 'M2.75 3.25h10.5v9.5H2.75zM10 3.25v9.5',
  check: 'm3.5 8.5 3 3 6-7',
  pencil: 'm10.25 2.75 3 3-7.5 7.5h-3v-3z',
  trash: 'M3 4.5h10M6.25 4.5V2.75h3.5V4.5M4.5 4.5l.6 8.75h5.8l.6-8.75',
  eye: 'M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8zM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5z',
  eyeOff:
    'M1.75 8S4.25 3.5 8 3.5 14.25 8 14.25 8 11.75 12.5 8 12.5 1.75 8 1.75 8zM8 9.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM2.5 2.5l11 11',
  plus: 'M8 3.25v9.5M3.25 8h9.5',
  close: 'm4.25 4.25 7.5 7.5m0-7.5-7.5 7.5',
  box: 'M8 1.75 13.5 4.75v6.5L8 14.25l-5.5-3v-6.5zM2.5 4.75 8 7.75l5.5-3M8 7.75v6.5',
  alert: 'M8 2.25 14.25 13.5H1.75zM8 6.5v3M8 11.5v.01'
};

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name]);
  svg.append(path);
  return svg;
}
