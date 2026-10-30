/**
 * fixture 启动 Chrome 时追加的 V8 参数
 *
 * V8 默认编译函数时不记源码位置，等需要时再重新解析函数补上。Playwright 连着浏览器时 V8 要给每个函数补，
 * 基础库是一个几 MB 的压缩文件，外层几个函数几乎就是整个文件，每补一个要重新解析几十毫秒：
 * WAService.js 初始化从约 110ms 变成约 350ms，打开页面慢约 1/3。编译时就记下源码位置能省掉这一步，没连着浏览器时快慢不变
 */

const EAGER_SOURCE_POSITIONS = '--no-enable-lazy-source-positions';
const JS_FLAGS = '--js-flags=';

/**
 * 在 Chrome 启动参数里加上编译时就记源码位置的 V8 参数。
 * Chrome 只认最后一个 --js-flags，所以并进开发者已有的 --js-flags；开发者自己指定了怎么记源码位置时不改
 */
export function withEagerSourcePositions(args: readonly string[] = []): string[] {
  const index = args.findIndex(arg => arg.startsWith(JS_FLAGS));
  if (index < 0) return [...args, JS_FLAGS + EAGER_SOURCE_POSITIONS];
  if (args[index].includes('lazy-source-positions')) return [...args];
  return args.map((arg, i) => (i === index ? `${arg} ${EAGER_SOURCE_POSITIONS}` : arg));
}
