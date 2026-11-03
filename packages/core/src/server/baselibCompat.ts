/**
 * 基础库脚本下发到浏览器前需要的兼容补丁（开发服务器在 /__baselib__/* 路由上应用，源文件不改动）
 *
 * 基础库的广告、云开发、米大师支付等能力放在伴生 SDK 子包里（WAAppAd.js / WACloud.js 等），
 * 真机和开发者工具由原生层同步加载进上下文。运行时没有这套加载机制（见 runtime/sdkStubs.ts），
 * 基础库内部读到这些能力时会走 loadSdkSubPackage，在拿不到伴生文件的上下文里直接
 * `throw new Error("Fatal: unexpected loadSdkSubPackage case")`。
 *
 * 与广告接口不同，这个抛错不经过业务代码也拦不住：wx.cloud 的 getter、Taro 全局垫片
 * 拷贝宿主全局属性（br[e]=i[e]）都会踩到，沿 require 链炸掉 app.js，整个小程序无法启动。
 * 业务代码没法容错它，所以只能在这里让基础库本身降级：按同一分支里 Get=true 的处理方式
 * （提示后返回 undefined），缺失的能力照常不可用，但启动不再被阻断。
 *
 * 按精确字符串匹配，其他版本没有这段代码就原样下发。补丁结果按文件路径缓存。
 */

/** loadSdkSubPackage 在拿不到伴生子包的上下文里抛出的 Fatal（3.7.0 实测字符串） */
const SDK_SUBPACKAGE_FATAL = 'throw new Error("Fatal: unexpected loadSdkSubPackage case");';

export function patchBaseLibScript(code: string): string {
  if (!code.includes(SDK_SUBPACKAGE_FATAL)) return code;
  return code.replaceAll(
    SDK_SUBPACKAGE_FATAL,
    'return void console.warn("[wxa-runner] 基础库伴生 SDK 子包（云开发/广告等）在浏览器运行时不可用，相关读取返回 undefined");'
  );
}
