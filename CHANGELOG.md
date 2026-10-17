# 更新日志

## [0.2.2](https://github.com/open-wxa/wxa-runner/compare/v0.2.1...v0.2.2) (2026-10-17)


### 问题修复

* 临时文件能用 getFileInfo 查到大小，saveFile 等保存文件的接口按真机行为实现，Painter 的图片缓存不再报错 ([c4c00fc](https://github.com/open-wxa/wxa-runner/commit/c4c00fc1e306ad7a5dc6abd29368dedf8742fbb5))
* 旧版 canvas 能画出临时文件里的图片：转发绘制指令时把临时文件地址换成根路径，基础库不再当成网络图片跳过 ([e5de0cf](https://github.com/open-wxa/wxa-runner/commit/e5de0cfc224066627948e14f38056054f0c2268f))

## [0.2.1](https://github.com/open-wxa/wxa-runner/compare/v0.2.0...v0.2.1) (2026-10-17)


### 新功能

* 真实登录失败时在页面右上角提示原因，不再只能翻控制台 ([9c12149](https://github.com/open-wxa/wxa-runner/commit/9c1214970a016bb9fc0cb9b827a8f8b20492c7fb))

## 0.2.0 (2026-10-17)

首次发布到 npm，`npx wxa-runner` 即可使用。
