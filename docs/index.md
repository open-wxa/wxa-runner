---
layout: home
title: wxa-runner
titleTemplate: 在浏览器里运行微信小程序，做 E2E 测试和调试

hero:
  name: wxa-runner
  text: 在浏览器里<br>运行微信小程序
  tagline: 用微信官方基础库渲染，Playwright 无头 E2E 测试，Chrome DevTools 调试。CI 里不装开发者工具也能跑
  image:
    light: /logo.png
    dark: /logo-dark.png
    alt: wxa-runner
  actions:
    - theme: brand
      text: 快速开始
      link: /getting-started
    - theme: alt
      text: 在 Playwright 中测试
      link: /testing
    - theme: alt
      text: GitHub
      link: https://github.com/open-wxa/wxa-runner

features:
  - title: 和真机一致
    details: 直接运行小程序的编译产物，渲染、组件、setData、生命周期都是微信官方基础库的代码，不是 H5 那样由框架重新实现
  - title: 无头 E2E
    details: 用 Playwright 直接在浏览器里测试，不用远程控制开发者工具；CI 里无头运行，Linux 上不需要开发者工具
    link: /testing
    linkText: 在 Playwright 中测试
  - title: 用熟悉的工具调试
    details: Chrome DevTools 打断点、看网络请求、看 DOM；保存文件后热更新，页面栈和全局状态保留
    link: /hot-reload
    linkText: 热更新
  - title: 跳过走不通的环节
    details: 在 setup 里预置登录态、mock 原生 API、拦截请求，不用改业务代码
    link: /setup
    linkText: 启动前准备
  - title: 直接打开任意页面
    details: 地址加上 ?path=pages/detail/detail&id=1，开发和测试都能直接定位到页面
    link: /cli
    linkText: 命令与环境变量
  - title: 原生和框架项目都能用
    details: 原生小程序目录，或 uni-app、Taro 编译出的 mp-weixin 目录，一行命令启动
    link: /getting-started
    linkText: 快速开始
---

## 一行命令启动

```bash
npx wxa-runner dev ./dist/dev/mp-weixin   # 原生小程序目录，或 uni-app / Taro 编译产物
# → http://localhost:3000
```

不替代微信开发者工具：预览、上传、真机调试仍然要用开发者工具。

## 用它做什么

- [用 Playwright 写微信小程序的 E2E 测试](./testing.md)：打开页面、点击、断言页面 data 和发出的请求
- [在 CI 里跑小程序自动化测试](./ci.md)：GitHub Actions 的 Linux 机器上无头运行，不装开发者工具
- [给 uni-app 项目写 E2E 测试](./uni-app.md)：运行 `mp-weixin` 编译产物，源码改动后热更新
- [跳过登录、mock 原生 API 和 wx.request](./setup.md)：不用改业务代码
- [和 miniprogram-automator 怎么选](./vs-miniprogram-automator.md)：两种小程序自动化测试方案的区别
