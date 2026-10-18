# 更新日志

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
