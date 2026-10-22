# 更新日志

## [0.6.0](https://github.com/open-wxa/wxa-runner/compare/v0.5.0...v0.6.0) (2026-10-22)


### 新功能

* 支持 Worker（wx.createWorker） ([#59](https://github.com/open-wxa/wxa-runner/issues/59)) ([f89bf3a](https://github.com/open-wxa/wxa-runner/commit/f89bf3aed0d3899d907c341399f601e2ddb252fa)), closes [#55](https://github.com/open-wxa/wxa-runner/issues/55)

## [0.5.0](https://github.com/open-wxa/wxa-runner/compare/v0.4.1...v0.5.0) (2026-10-20)


### 新功能

* 原生组件与 API 向开发者工具看齐（选视频、画布、picker、swiper 拖动） ([#51](https://github.com/open-wxa/wxa-runner/issues/51)) ([4ea9be2](https://github.com/open-wxa/wxa-runner/commit/4ea9be24e9c55f5868c73cab2fcd6a257c6ca48d))

## [0.4.1](https://github.com/open-wxa/wxa-runner/compare/v0.4.0...v0.4.1) (2026-10-20)


### 问题修复

* 修复隐式组件入口遗漏导致自定义 tabBar 不显示 ([#47](https://github.com/open-wxa/wxa-runner/issues/47)) ([c0822ce](https://github.com/open-wxa/wxa-runner/commit/c0822ce2bcf1d20f3ced69828c89201a0689313f))

## [0.4.0](https://github.com/open-wxa/wxa-runner/compare/v0.3.2...v0.4.0) (2026-10-20)


### 新功能

* 支持分包异步化，补齐分包加载任务协议 ([#48](https://github.com/open-wxa/wxa-runner/issues/48)) ([c55958a](https://github.com/open-wxa/wxa-runner/commit/c55958ab08a90f97527f468bacb3d6128e7a092f))

## [0.3.2](https://github.com/open-wxa/wxa-runner/compare/v0.3.1...v0.3.2) (2026-10-19)


### 问题修复

* 压缩成一行、export 不在行首的 ES Module 也转换为 CommonJS，能正常加载 ([18b3037](https://github.com/open-wxa/wxa-runner/commit/18b3037c7f584c44814e5a0339e695453a5e68e5))

## [0.3.1](https://github.com/open-wxa/wxa-runner/compare/v0.3.0...v0.3.1) (2026-10-19)


### 问题修复

* 逻辑层去掉真机上没有的 MutationObserver，用 core-js 2 等按它判断环境的库的小程序能启动 ([e7d8029](https://github.com/open-wxa/wxa-runner/commit/e7d8029cadd60c97d0bc50cbcaf1b6d00fd03b37))

## [0.3.0](https://github.com/open-wxa/wxa-runner/compare/v0.2.5...v0.3.0) (2026-10-18)


### 新功能

* 3.10.1 起的基础库上，带经纬度的 moveToLocation 能移动地图 ([15ba22b](https://github.com/open-wxa/wxa-runner/commit/15ba22bb52a5500f27f61efc3427459cae77f551))
* map 组件的 moveToLocation 能用，地图上的当前位置就是 wx.getLocation 的位置（[#35](https://github.com/open-wxa/wxa-runner/issues/35)） ([78b2fa7](https://github.com/open-wxa/wxa-runner/commit/78b2fa7387eb0fc6f6b7499dfaaa05227bc784b3))


### 问题修复

* 2.32.3 上 chooseImage、authorize、getLocation 等要做隐私检查的接口能收到回调（[#36](https://github.com/open-wxa/wxa-runner/issues/36)） ([ccf47de](https://github.com/open-wxa/wxa-runner/commit/ccf47deac9fc52862b80bde772111fb0145d51d3))
* Playwright 里 route 的函数和 requests() 能拿到小程序发出的二进制请求体 ([2d5ab5f](https://github.com/open-wxa/wxa-runner/commit/2d5ab5f560b1d48f8e6b86db04c004ef47490558))
* wx.request 按 responseType: arraybuffer 拿到 ArrayBuffer，WebSocket 能收到二进制消息（[#34](https://github.com/open-wxa/wxa-runner/issues/34)） ([366521a](https://github.com/open-wxa/wxa-runner/commit/366521a6fa0378355de9d1a16d3b1210ebaeec56))

## [0.2.5](https://github.com/open-wxa/wxa-runner/compare/v0.2.4...v0.2.5) (2026-10-18)


### 问题修复

* InnerAudioContext 能播放网络和代码包里的音频，readFile 能读代码包里的文件 ([504fd06](https://github.com/open-wxa/wxa-runner/commit/504fd0664e9f1b59043645f8f85e227130f72c14))
* 原生音频 stop 后不再收到多余的 pause 等事件，未播放时设置 startTime 立即生效，readFile 读对代码包文件 ([aa1f34c](https://github.com/open-wxa/wxa-runner/commit/aa1f34cab5aaed3566da50b3e70be2f56ee2378c))
* 旧版基础库上 InnerAudioContext 能播放音频、video 组件能显示 ([5f7a102](https://github.com/open-wxa/wxa-runner/commit/5f7a102940f546947c2a8b998813c44f69d6fe6c))

## [0.2.4](https://github.com/open-wxa/wxa-runner/compare/v0.2.3...v0.2.4) (2026-10-18)


### 问题修复

* 支持新版开发者工具（Electron）：编译器从 app.asar.unpacked 找，地区选择器的行政区划数据从 app.asar 读 ([98e6827](https://github.com/open-wxa/wxa-runner/commit/98e682789eed8d4f603738691414b5c24dc46643))
* 新版开发者工具（Electron）上真实登录向正在运行的开发者工具要 ticket，不再用磁盘上作废的旧 ticket ([779f045](https://github.com/open-wxa/wxa-runner/commit/779f0454abeb08e8cf3e2a38fc8ca6feddbadb5b))
* 自动化接口收到非对象消息时不再让开发服务器崩溃，命令行错误原因用双引号或不是 JSON 时也能取出 ([ae1b582](https://github.com/open-wxa/wxa-runner/commit/ae1b582804f47ee392e787f2c69e6b6c54b826b9))

## [0.2.3](https://github.com/open-wxa/wxa-runner/compare/v0.2.2...v0.2.3) (2026-10-17)


### 问题修复

* 没装开发者工具时（Linux、CI）偶发 wcc 编译崩溃：组件配置的分隔符固定为 4 位数字，不再取自当前毫秒数 ([b99e2d9](https://github.com/open-wxa/wxa-runner/commit/b99e2d9a88c8bb227edab16c216dfa95f351ab47))

## [0.2.2](https://github.com/open-wxa/wxa-runner/compare/v0.2.1...v0.2.2) (2026-10-17)


### 问题修复

* 临时文件能用 getFileInfo 查到大小，saveFile 等保存文件的接口按真机行为实现，Painter 的图片缓存不再报错 ([c4c00fc](https://github.com/open-wxa/wxa-runner/commit/c4c00fc1e306ad7a5dc6abd29368dedf8742fbb5))
* 旧版 canvas 能画出临时文件里的图片：转发绘制指令时把临时文件地址换成根路径，基础库不再当成网络图片跳过 ([e5de0cf](https://github.com/open-wxa/wxa-runner/commit/e5de0cfc224066627948e14f38056054f0c2268f))

## [0.2.1](https://github.com/open-wxa/wxa-runner/compare/v0.2.0...v0.2.1) (2026-10-17)


### 新功能

* 真实登录失败时在页面右上角提示原因，不再只能翻控制台 ([9c12149](https://github.com/open-wxa/wxa-runner/commit/9c1214970a016bb9fc0cb9b827a8f8b20492c7fb))

## 0.2.0 (2026-10-17)

首次发布到 npm，`npx wxa-runner` 即可使用。
