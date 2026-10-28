import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    // e2e 每个文件都要起一个 Chrome 和一个开发服务器。完整版 Chrome 多个实例同时运行时偶尔会卡死
    // （launch / newPage 不返回，macOS 上的原因见 tests/e2e/runner.ts 的 chromeLaunchOptions），所以 e2e 单独放进一个进程池并限制并发
    poolMatchGlobs: [['**/tests/e2e/**', 'forks']],
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        // 只做 re-export
        'packages/*/src/index.ts',
        // 依赖 DOM、只在浏览器里运行，由 tests/e2e 覆盖（Node 的覆盖率工具统计不到）
        'packages/core/src/runtime/frame.ts',
        'packages/core/src/runtime/host/index.ts',
        'packages/core/src/runtime/host/Host.ts',
        'packages/core/src/runtime/host/PageView.ts',
        'packages/core/src/runtime/host/pageStackRestore.ts',
        'packages/core/src/runtime/host/realm.ts',
        'packages/core/src/runtime/host/testApi.ts',
        'packages/core/src/runtime/host/api/webView.ts',
        'packages/core/src/runtime/host/api/libFiles.ts',
        'packages/core/src/runtime/syncScript.ts',
        'packages/core/src/runtime/host/ui/!(tabBarView).ts'
      ],
      reporter: ['text-summary', 'text']
    }
  }
});
