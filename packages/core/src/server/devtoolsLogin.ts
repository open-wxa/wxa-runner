/**
 * --devtools-login 的接口：借本机开发者工具的登录态，向微信换取真实的 wx.login code 和手机号，转发服务市场和插件的请求
 *
 *   POST /login         → { code }
 *   POST /phone-number  → { data, encryptedData, iv }，code 在 data（JSON 字符串）里，与基础库的约定一致
 *   POST /operate-wx-data  { data } → { data }：wx.serviceMarket 经原生 operateWXData 发出的请求，同开发者工具转发给微信
 *   POST /verify-plugin    { data } → { data: { list } }：插件校验，list 是每个插件能访问的域名
 *   POST /batch-get-contact  { appIds } → { contactList }：插件信息
 *
 * 失败时返回 500 和 { error: 原因 }。开发者 ticket 只留在 Node 进程里，接口只接受本机访问，
 * 并校验 Host 头防止 DNS rebinding。
 */

import express, { NextFunction, Request, Response, Router } from 'express';
import { findDeveloperTicket } from '@open-wxa/wxa-runner-extractor';
import { TicketNotAllowed } from './developerTicket';
import { explainErrcode, FindTicket, requireOk, WechatDevClient } from './wechatDev';

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 经 /operate-wx-data 转发的 operateWXData：只放行服务市场。别的（用户信息、授权等）在开发者工具里
 * 会弹窗让用户确认，不能让业务代码借开发者的登录态直接调用
 */
const FORWARDED_WX_DATA_APIS = ['webapi_servicemarket_jsapi_comm'];

/**
 * @param findTicket 每次请求都重新查找：开发者工具重新登录、切换账号后不用重启服务器
 * @param loginCode 微信后台不给这个 appid 取 ticket 时，wx.login 退回让开发者工具的模拟器自己调。手机号等没有这条路
 */
export function devtoolsLoginRouter(appid: string, findTicket: FindTicket = findDeveloperTicket, loginCode?: (() => Promise<string>) | null): Router {
  const wechat = new WechatDevClient(appid, findTicket);
  const router = express.Router();
  router.use(onlyLoopback);

  router.post('/login', respond(async () => {
    try {
      const body = requireOk(await wechat.postJson('wxa-dev-logic/jslogin', { scope: ['snsapi_base'] }), '微信登录失败');
      if (!body.code) throw new Error('微信登录失败：微信没有返回 code');
      return { code: body.code };
    } catch (error) {
      // 只有取不到 ticket 这一种情况才换路；别的失败（账号不是开发者、网络不通）原因照旧报出来
      if (!loginCode || !(error instanceof TicketNotAllowed)) throw error;
      return { code: await loginCode() };
    }
  }));

  router.post('/phone-number', respond(async () => {
    const body = await wechat.postJson('wxa-dev-logic/jsgetuserwxphone', { appid });
    // 结果码在 jsapi_baseresponse 里，不是 jslogin 那样的 baseresponse
    const errcode = body.jsapi_baseresponse?.errcode ?? body.BaseResponse?.Ret;
    if (errcode !== 0 || typeof body.data !== 'string') {
      const errmsg = body.jsapi_baseresponse?.errmsg || body.BaseResponse?.ErrMsg?.String || '未知错误';
      throw new Error(`获取手机号失败 ${errcode}: ${errmsg}${explainErrcode(errcode)}`);
    }
    // data 原样转交：基础库从 JSON.parse(data) 里取 code 和 request_id
    const { encryptedData, iv } = JSON.parse(body.data);
    return { data: body.data, encryptedData, iv };
  }));

  router.post('/operate-wx-data', express.json({ limit: '10mb' }), (req, res, next) => {
    const apiName = req.body?.data?.api_name;
    if (FORWARDED_WX_DATA_APIS.includes(apiName)) return next();
    res.status(403).json({ error: `operateWXData 只转发服务市场的请求，不转发 ${apiName}` });
  }, respond(async req => {
    // 与开发者工具一致：基础库给的 data 序列化成文本放在 data 字段里
    const body = requireOk(await wechat.postJson('wxa-dev-logic/jsoperatewxdata', { data: JSON.stringify(req.body.data) }), '服务市场调用失败');
    if (typeof body.data !== 'string') throw new Error('服务市场调用失败：微信没有返回结果');
    // 服务市场自己的结果码在 data 里，由基础库解析成 invokeService 的结果
    return { data: JSON.parse(body.data) };
  }));

  // 插件：基础库启动时校验插件、取插件信息，插件里的网络请求要等拿到这两样才发出
  router.post('/verify-plugin', express.json(), respond(async req => {
    // 与开发者工具一致：基础库给的 data 序列化后放在 ext_info 里
    const body = requireOk(await wechat.postJson('wxa-dev-logic/verifyplugin', { ext_info: JSON.stringify(req.body?.data || {}) }), '插件校验失败');
    return { data: { list: body.list || [] } };
  }));

  router.post('/batch-get-contact', express.json(), respond(async req => {
    const body = requireOk(await wechat.postJson('wxa-dev-logic/batchgetcontact', { appid_list: req.body?.appIds || [] }), '获取插件信息失败');
    const contacts: Array<{ appid: string; plugin_info?: { plugin_list?: unknown[] } }> = body.contact_list || [];
    return { contactList: contacts.filter(contact => contact.plugin_info).map(contact => ({ appId: contact.appid, plugin_list: contact.plugin_info!.plugin_list })) };
  }));

  return router;
}

function onlyLoopback(req: Request, res: Response, next: NextFunction) {
  // req.hostname 去掉端口时能正确处理 IPv6 的 [::1]:3000
  if (!LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress || '') || !LOOPBACK_HOSTS.includes(req.hostname)) {
    res.status(403).json({ error: '开发者登录态接口只允许本机访问' });
    return;
  }
  next();
}

function respond(action: (req: Request) => Promise<object>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await action(req));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  };
}
