/**
 * 临时文件：canvas 导出、拍照、选图、下载的结果都存在开发服务器上
 *
 * 返回的是 http 地址：image、video 组件只原样使用 http(s) 地址，其余的会被当成页面相对路径；
 * uploadFile 也能直接读取。
 */

import { fileSession } from '../../fileSession';

const TEMP_DIR = '/__wxa__/tmp';

/**
 * @param type 扩展名（如 png），读取时按它返回 Content-Type
 * @throws 开发服务器拒绝保存时，带上它给出的原因（如扩展名不合法）
 */
export async function saveTempFile(data: BodyInit, type: string): Promise<string> {
  const res = await fetch(`${TEMP_DIR}/${fileSession()}?type=${encodeURIComponent(type)}`, { method: 'POST', body: data });
  if (!res.ok) throw new Error(await res.text());
  const { url } = await res.json();
  return url;
}

/**
 * 临时文件的地址换成根路径（/__wxa__/tmp/…），其他地址原样返回。
 * 根路径在页面和组件里都按开发服务器的根目录解析，指向的还是同一个文件
 */
export function tempFileRootPath(url: string): string {
  const prefix = `${location.origin}${TEMP_DIR}/`;
  return url.startsWith(prefix) ? url.slice(location.origin.length) : url;
}

/** 临时文件的扩展名：优先用原文件名的，其次按 MIME 类型（如 image/png），都看不出来时用 fallback */
export function tempFileType(name: string, mimeType: string, fallback: string): string {
  const fromName = /\.([a-z\d]+)$/i.exec(name)?.[1];
  const fromType = /^[a-z]+\/([a-z\d]+)\s*(;|$)/i.exec(mimeType)?.[1];
  return (fromName || fromType || fallback).toLowerCase();
}

/** 是不是开发服务器上的临时文件，保存的文件（wx.saveFile）也存在这里 */
export function isTempFile(filePath: unknown): filePath is string {
  return typeof filePath === 'string' && filePath.startsWith(`${location.origin}${TEMP_DIR}/`);
}

/** @returns 文件大小（字节），文件不存在时为 null */
export async function tempFileSize(url: string): Promise<number | null> {
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok ? Number(res.headers.get('content-length')) : null;
}

/** 文件不存在时什么也不做 */
export async function removeTempFile(url: string): Promise<void> {
  await fetch(url, { method: 'DELETE' });
}
