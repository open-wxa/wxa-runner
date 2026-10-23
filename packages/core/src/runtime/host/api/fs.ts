/**
 * 可写文件统一在开发服务器；代码包仍只读，由静态资源接口提供。
 * 同步接口通过同源 XHR 返回结果，不另建浏览器缓存，避免覆盖、删除后读取到旧数据。
 */
import { ApiHandler, fail, ok } from './registry';

type FileRequest = (operation: string, args: Record<string, any>) => Record<string, any>;

function requestFile(operation: string, args: Record<string, any>): Record<string, any> {
  const request = new XMLHttpRequest();
  request.open('POST', '/__wxa__/fs', false);
  request.setRequestHeader('content-type', 'application/json');
  request.send(JSON.stringify({ operation, args }));
  const result = JSON.parse(request.responseText);
  if (request.status !== 200) throw new Error(result.error || `filesystem HTTP ${request.status}`);
  return result;
}

export function createFileSystemApis(request: FileRequest = requestFile): Record<string, ApiHandler> {
  const apis: Record<string, ApiHandler> = {};
  for (const operation of [
    'access',
    'stat',
    'mkdir',
    'writeFile',
    'appendFile',
    'readdir',
    'unlink',
    'rmdir',
    'getFileInfo',
    'copyFile',
    'readFile'
  ]) {
    const handler: ApiHandler = (args, { api }) => {
      try {
        // JSON 传输只编码二进制边界，文件状态始终由服务器的同一个 FileStore 管理。
        const input = { ...args };
        // 数据来自逻辑层 iframe，不能用宿主 realm 的 instanceof 判断。
        const isBuffer = Object.prototype.toString.call(input.data) === '[object ArrayBuffer]';
        if (isBuffer || ArrayBuffer.isView(input.data)) {
          const view = isBuffer
            ? new Uint8Array(input.data)
            : new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
          let binary = '';
          for (let offset = 0; offset < view.length; offset += 32768) {
            binary += String.fromCharCode(...view.subarray(offset, offset + 32768));
          }
          input.data = btoa(binary);
          input.binary = true;
        }
        const result = request(operation, input);
        if (result.binary) {
          result.data = Uint8Array.from(atob(result.data), character => character.charCodeAt(0)).buffer;
          delete result.binary;
        }
        return ok(api, result);
      } catch (error) {
        return fail(api, (error as Error).message);
      }
    };
    apis[operation] = handler;
    apis[operation + 'Sync'] = handler;
    apis['fs_' + operation] = handler;
    apis['fs_' + operation + 'Sync'] = handler;
  }
  // 不带协议的是代码包里的文件，不能被用户目录下的同名文件顶替。
  apis.readFile = (args, context) =>
    /^[a-z]+:\/\//i.test(String(args.filePath)) || String(args.filePath).startsWith('/__wxa__/tmp/')
      ? apis.readFileSync(args, context)
      : readPackageFile(args.filePath, args.encoding).then(
          data => ok(context.api, { data }),
          error => fail(context.api, error.message)
        );
  apis.fs_readFile = apis.readFile;
  return apis;
}

/**
 * 开发服务器以项目目录为根目录提供代码包里的文件
 * @param filePath 以 / 开头、相对代码包根目录的路径
 * @param encoding 不指定时得到 ArrayBuffer
 * @throws 文件不存在，或 encoding 不是 utf8
 */
async function readPackageFile(filePath: string, encoding: unknown): Promise<string | ArrayBuffer> {
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8') {
    throw new Error(`读取代码包里的文件只支持 utf8 编码，或不指定编码得到 ArrayBuffer，不支持 ${encoding}`);
  }
  // encodeURI 不编码 # 和 ?，文件名里有的话会被当成地址的片段和查询
  const parts: string[] = [];
  for (const part of String(filePath).split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const response = await fetch('/' + parts.map(encodeURIComponent).join('/'));
  if (!response.ok) throw new Error(`no such file or directory, open ${filePath}`);
  return encoding ? response.text() : response.arrayBuffer();
}
