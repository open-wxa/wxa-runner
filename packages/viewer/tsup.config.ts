import { defineConfig } from 'tsup';

export default defineConfig([
  // Node 端：打包、本机预览、导出站点
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs', 'esm'],
    platform: 'node',
    target: 'node18',
    dts: true,
    sourcemap: true,
    shims: true,
    external: ['@open-wxa/wxa-runner-core', '@open-wxa/wxa-runner-extractor', 'express', 'fflate']
  },
  // 浏览器端：查看页面和它的 Service Worker。依赖要全部打进去，浏览器里没有 node_modules
  {
    entry: { 'runtime/viewer': 'src/page/index.ts', 'runtime/pack-sw': 'src/sw/index.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    noExternal: [/.*/],
    // logo 和标签页图标直接内联，站点不用多带图片文件
    loader: { '.png': 'dataurl' },
    outExtension: () => ({ js: '.js' })
  },
  // 转发 wx.request 的处理函数：不依赖 Node 的独立 ES 模块，接到任意支持 Fetch API 的平台上（见 src/proxy.ts）
  {
    entry: { proxy: 'src/proxy.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: true,
    noExternal: [/.*/]
  }
]);
