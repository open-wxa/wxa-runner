/**
 * 其余 API：开放接口 Mock、剪贴板等
 *
 * 开放接口（登录、用户信息、支付）在浏览器里无法真实调用，返回可预测的假数据，
 * 测试中可以用 __wxa_test_api__.mock() 覆盖。开启 --devtools-login 时，登录、手机号、服务市场（wx.serviceMarket）和插件经开发服务器借开发者工具的登录态向微信取真实结果。
 */

import { ApiHandler, ApiResult, fail, ok } from './registry';
import { saveTempFile } from './tempFiles';

export interface MiscApiOptions {
  devtoolsLogin?: boolean;
  /** 经开发服务器向微信取结果失败时触发，用来在页面上提示开发者；业务代码照常收到 fail */
  onDevtoolsLoginFail?: (api: string, reason: string) => void;
}

/** wx.serviceMarket.invokeService 经原生 operateWXData 发出时的 api_name */
const SERVICE_MARKET = 'webapi_servicemarket_jsapi_comm';
/** 云开发（wx.cloud 的 init、callFunction、数据库、存储）经原生 operateWXData 发出时的 api_name，具体操作在 data.qbase_api_name 里 */
const CLOUD = 'qbase_commapi';

export function createMiscApis(appid: string, options?: MiscApiOptions): Record<string, ApiHandler> {
  /** 经开发服务器借开发者工具的登录态向微信取结果 */
  const viaDevtools = async (api: string, url: string, json?: object) => {
    try {
      return await postDevServer(url, json);
    } catch (error) {
      options?.onDevtoolsLoginFail?.(api, (error as Error).message);
      throw error;
    }
  };

  let cloudWarned = false;
  /**
   * 云开发要以用户身份访问微信后台，浏览器里做不到。明确失败而不是返回空的成功：后者让 SDK 报出
   * Cannot read properties of undefined (reading 'stat') 这类看不出原因的错误。失败原因会带进
   * callFunction、数据库等接口的 errMsg
   */
  const cloudUnavailable = (api: string, operation?: string) => {
    if (!cloudWarned) {
      cloudWarned = true;
      console.warn('[wxa-runner] 云开发（wx.cloud）在浏览器运行时不可用，调用会失败');
    }
    return fail(api, `wxa-runner 不支持云开发（${operation ?? 'unknown'}）`);
  };

  return {
    // canvas 导出图片、拍照、录像的结果都经过这里
    base64ToTempFilePath: async args => {
      const bytes = Uint8Array.from(atob(String(args.base64Data || '')), char => char.charCodeAt(0));
      return { tempFilePath: await saveTempFile(bytes, String(args.fileType || 'png')) };
    },

    // 基础库经这两个接口向后台拉各种配置和小程序信息
    operateWXData: (args, { api }) => {
      if (args.data?.api_name === SERVICE_MARKET) {
        // 基础库只在失败结果带 err_code 时把 errMsg 拼进 invokeService 的错误，否则业务代码只看到 [object Object]
        const serviceMarketFail = (reason: string) => fail(api, reason, { err_code: -1 });
        if (!options?.devtoolsLogin) return serviceMarketFail('wx.serviceMarket 要向微信服务市场真实调用，启动时加 --devtools-login');
        // 结果原样交回：服务市场的结果码和数据由基础库从 data 里解析
        return viaDevtools('serviceMarket.invokeService', '/__wxa__/api/operate-wx-data', { data: args.data }).then(
          ({ data }) => ok(api, { data }),
          (error: Error) => serviceMarketFail(error.message)
        );
      }
      if (args.data?.api_name === CLOUD) return cloudUnavailable(api, args.data.data?.qbase_api_name);
      if (args.data?.api_name === 'webapi_getwxanetwork') return bizDomainUnavailable(api);
      if (args.data?.api_name === 'webapi_getwxauserprivacyauthinfo') return ok(api, { data: { data: JSON.stringify(PRIVACY_AUTH_INFO) } });
      return ok(api);
    },
    getAppContact: (args, { api }) =>
      args.keyPath === 'WxaAppInfo.Network.BizDomain' ? bizDomainUnavailable(api) : ok(api),

    // 插件：基础库启动时校验插件、取插件信息，插件里的网络请求要等拿到这两样才发出。插件代码也只在 --devtools-login 时下载
    ...(options?.devtoolsLogin ? {
      verifyPlugin: (async (args, { api }) => ok(api, await viaDevtools(api, '/__wxa__/api/verify-plugin', { data: args.data }))) as ApiHandler,
      batchGetContact: (async (args, { api }) => ok(api, await viaDevtools(api, '/__wxa__/api/batch-get-contact', { appIds: args.appIds }))) as ApiHandler
    } : {}),

    // 向微信取不到时明确返回 fail，不退回假数据：配置或登录态的问题要让开发者马上发现
    login: options?.devtoolsLogin
      ? async (_args, { api }) => ok(api, { code: (await viaDevtools(api, '/__wxa__/api/login')).code })
      : (_args, { api }) => ok(api, { code: `wxa_mock_code_${Date.now().toString(36)}` }),
    // 基础库只从 JSON.parse(data) 里取手机号的 code
    getPhoneNumber: options?.devtoolsLogin
      ? async (_args, { api }) => ok(api, await viaDevtools(api, '/__wxa__/api/phone-number'))
      : (_args, { api }) => ok(api, { data: JSON.stringify({ code: `mock_phone_code_${Date.now()}` }), encryptedData: 'mock_encrypted', iv: 'mock_iv' }),
    checkSession: () => undefined,
    authorize: () => undefined,
    getSetting: (_args, { api }) => ok(api, {
      authSetting: { 'scope.userInfo': true, 'scope.userLocation': true }
    }),
    openSetting: (_args, { api }) => ok(api, { authSetting: {} }),
    getUserInfo: (_args, { api }) => ok(api, { userInfo: mockUser(), rawData: JSON.stringify(mockUser()), signature: '', encryptedData: '', iv: '' }),
    getUserProfile: (_args, { api }) => ok(api, { userInfo: mockUser(), rawData: JSON.stringify(mockUser()), signature: '', encryptedData: '', iv: '' }),
    getAccountInfoSync: (_args, { api }) => ok(api, { miniProgram: { appId: appid, envVersion: 'develop', version: '' } }),
    requestPayment: (_args, { api }) => fail(api, '浏览器运行时不支持支付，请在测试中通过 __wxa_test_api__.mock("requestPayment", ...) 模拟'),
    getLocation: (_args, { api }) => ok(api, { latitude: 39.908823, longitude: 116.39747, speed: 0, accuracy: 65, altitude: 0, verticalAccuracy: 65, horizontalAccuracy: 65 }),
    scanCode: (_args, { api }) => fail(api, 'cancel'),

    setClipboardData: async (args) => {
      clipboard = String(args.data ?? '');
      await navigator.clipboard?.writeText(clipboard).catch(() => undefined);
    },
    getClipboardData: (_args, { api }) => ok(api, { data: clipboard }),
    makePhoneCall: (args) => console.info(`[wxa-runner] makePhoneCall ${args.phoneNumber}`),
    showShareMenu: () => undefined,
    hideShareMenu: () => undefined,
    updateShareMenu: () => undefined
  };
}

let clipboard = '';

/** @throws 开发服务器返回的失败原因（由注册表转成 xxx:fail），返回的不是 JSON 时带上状态码 */
async function postDevServer(url: string, json?: object): Promise<Record<string, any>> {
  const init: RequestInit = json
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) }
    : { method: 'POST' };
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new Error(body?.error || `开发服务器返回 HTTP ${response.status}`);
  return body;
}

function mockUser() {
  return { nickName: 'wxa-runner', avatarUrl: '', gender: 0, country: '', province: '', city: '', language: 'zh_CN' };
}

/**
 * 隐私授权信息：不用弹窗、没有未授权的接口，等于用户已经同意了隐私协议。基础库调用剪贴板、定位、选图等涉及隐私的接口前
 * 先拉取它，从结果的 data 里解析；2.32.3 拿不到时在回调里抛错，这些接口一直不回调。wording 是弹窗的文案，不弹窗也要有
 */
const PRIVACY_AUTH_INFO = { action_code: 0, need_popup_scope_list: [], unauth_scope_list: [], wording: {} };

/**
 * 不校验业务域名，等同开发者工具的「不校验合法域名、web-view（业务域名）」：拿到空的业务域名列表时，
 * 基础库会把 web-view 事件里的网页地址清空，只有拉取失败才不校验。不同版本从不同的原生接口拉取
 * （如 3.13.2 用 getAppContact，3.17.3 用 operateWXData），两个都要失败
 */
function bizDomainUnavailable(api: string): ApiResult {
  return fail(api, 'not available in wxa-runner');
}
