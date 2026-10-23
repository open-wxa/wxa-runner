import { defineConfig } from 'tsup';

export default defineConfig([
  // Node 端：开发服务器与构建器
  {
    entry: { index: 'src/index.ts', setup: 'src/setup.ts' },
    format: ['cjs', 'esm'],
    platform: 'node',
    target: 'node18',
    // test-api 只有类型：给 window.__wxa_test_api__ 的全局声明
    dts: { entry: { index: 'src/index.ts', setup: 'src/setup.ts', 'test-api': 'src/test-api.ts' } },
    sourcemap: true,
    shims: true,
    external: ['express', 'chokidar', 'ws', 'esbuild', '@open-wxa/wxa-runner-compiler', '@open-wxa/wxa-runner-extractor']
  },
  // 浏览器端：宿主页面、注入 iframe 的桥、Worker 里的原生接口、在 Network 面板里显示被拦截请求的 Service Worker
  {
    entry: {
      'runtime/host': 'src/runtime/host/index.ts',
      'runtime/frame': 'src/runtime/frame.ts',
      'runtime/worker': 'src/runtime/worker.ts',
      'runtime/sw': 'src/runtime/sw.ts'
    },
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    sourcemap: true,
    outExtension: () => ({ js: '.js' })
  }
]);
