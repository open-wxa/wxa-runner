/** JSON 序列化并转义 </script> 与行分隔符，结果可安全嵌入脚本。不依赖 Node：查看器的 Service Worker 也用它生成页面 */
export function toJs(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
