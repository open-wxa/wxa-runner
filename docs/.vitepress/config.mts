import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type HeadConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';
import pkg from '../../package.json';

// 站点地址。换成自定义域名时改这里（末尾带 /），并在 docs/public/ 下放 CNAME
const SITE_URL = 'https://open-wxa.github.io/wxa-runner/';
const BASE = new URL(SITE_URL).pathname;
const REPO_URL = 'https://github.com/open-wxa/wxa-runner';

const title = 'wxa-runner';
const description =
  '在浏览器里用微信官方基础库运行微信小程序：Playwright 无头 E2E 测试，CI 和 Linux 上不需要开发者工具；Chrome DevTools 调试、热更新。支持原生小程序和 uni-app、Taro 编译产物';

export default defineConfig({
  lang: 'zh-CN',
  title,
  // 子页标题只写「快速开始」这类泛词，搜索结果里看不出是做什么的，后面带上用途
  titleTemplate: `:title | ${title} 微信小程序 E2E 测试`,
  description,
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,
  // 本机调研笔记，不发布
  srcExclude: ['research/**'],

  sitemap: { hostname: SITE_URL },

  vite: {
    plugins: [
      // 生成 llms.txt、llms-full.txt 和每个页面的 .md 版本，给 AI 读取
      llmstxt({
        domain: new URL(SITE_URL).origin,
        description: '在浏览器里用微信官方基础库运行微信小程序，用于本地调试和 E2E 自动化测试',
        details: [
          'wxa-runner 直接运行小程序的编译产物（原生小程序，或 uni-app、Taro 编译出的 mp-weixin 目录），',
          '渲染、组件、生命周期都是微信官方基础库的代码。可以用 Chrome DevTools 调试，用 Playwright 写无头 E2E 测试，',
          '在 setup 文件里预置登录态、mock 原生 API、拦截 wx.request。',
          '',
          '- 启动：`npx wxa-runner dev <小程序目录>`',
          '- Playwright 测试：`@open-wxa/wxa-runner-playwright`，提供 `miniProgram` fixture',
          '- setup 文件的类型：`@open-wxa/wxa-runner-core/setup`',
          `- 源码：${REPO_URL}`
        ].join('\n'),
        ignoreFiles: ['research/**'],
        // 默认会在首页插一段 display: none 的文字，搜索引擎可能当作隐藏文字作弊
        injectLLMHint: false
      })
    ]
  },

  // docs/public/ 下的图标、logo、分享卡片由项目图生成。head 里的地址不会自动加 base，要带上 BASE
  head: [
    ['link', { rel: 'icon', href: `${BASE}favicon.ico`, sizes: '48x48' }],
    ['link', { rel: 'icon', type: 'image/png', href: `${BASE}icon-192.png`, sizes: '192x192' }],
    ['link', { rel: 'apple-touch-icon', href: `${BASE}apple-touch-icon.png` }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          '微信小程序,小程序调试,小程序自动化测试,小程序 E2E 测试,Playwright,uni-app,Taro,基础库,小程序模拟器,wxa-runner'
      }
    ],
    // Google Search Console 的站点验证
    ['meta', { name: 'google-site-verification', content: 'Qg8RjNxDVZjF5N823_1M5gbWSYI5o2azEwxpXQeWt9Q' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: title }],
    ['meta', { property: 'og:locale', content: 'zh_CN' }],
    ['meta', { property: 'og:image', content: `${SITE_URL}og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:image:alt', content: 'wxa-runner：在浏览器里运行微信小程序' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE_URL}og.png` }]
  ],

  // 每个页面的 canonical、Open Graph；首页再加结构化数据
  transformHead({ pageData, title: pageTitle, description: pageDescription }) {
    const url = pageUrl(pageData.relativePath);
    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { property: 'og:title', content: pageTitle }],
      ['meta', { property: 'og:description', content: pageDescription }],
      ['meta', { name: 'twitter:title', content: pageTitle }],
      ['meta', { name: 'twitter:description', content: pageDescription }]
    ];
    if (pageData.relativePath === 'index.md') {
      const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: title,
        description,
        url: SITE_URL,
        image: `${SITE_URL}logo.png`,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Windows, Linux',
        softwareVersion: pkg.version,
        license: `${REPO_URL}/blob/main/LICENSE`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: [REPO_URL, 'https://www.npmjs.com/package/wxa-runner']
      };
      head.push(['script', { type: 'application/ld+json' }, JSON.stringify(jsonLd)]);
    }
    return head;
  },

  // robots.txt 必须在域名根目录才生效：部署在 github.io 的子路径下时搜索引擎读不到，换成自定义域名后才起作用
  buildEnd({ outDir }) {
    fs.writeFileSync(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
  },

  markdown: {
    codeCopyButtonTitle: '复制代码'
  },

  themeConfig: {
    // 深色模式下黑色的狐狸看不清，换成浅色的版本
    logo: { light: '/logo.png', dark: '/logo-dark.png', alt: 'wxa-runner' },

    nav: [
      {
        text: '指南',
        link: '/getting-started',
        activeMatch: '^/(getting-started|features|vs-miniprogram-automator|uni-app|setup|real-login|hot-reload|cli|faq)$'
      },
      { text: '测试', link: '/testing', activeMatch: '^/(testing|ci|test-api)$' },
      {
        text: `v${pkg.version}`,
        items: [
          { text: '更新日志', link: `${REPO_URL}/blob/main/CHANGELOG.md` },
          { text: '参与开发', link: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
          { text: '设计文档', link: `${REPO_URL}/blob/main/PROJECT_DESIGN.md` }
        ]
      }
    ],

    sidebar: [
      {
        text: '开始',
        items: [
          { text: '快速开始', link: '/getting-started' },
          { text: '功能与限制', link: '/features' },
          { text: '和 miniprogram-automator 对比', link: '/vs-miniprogram-automator' }
        ]
      },
      {
        text: '使用',
        items: [
          { text: '启动前准备（setup）', link: '/setup' },
          { text: '真实登录', link: '/real-login' },
          { text: '热更新', link: '/hot-reload' },
          { text: '在 Playwright 中测试', link: '/testing' },
          { text: '在 CI 中运行', link: '/ci' },
          { text: 'uni-app 项目', link: '/uni-app' }
        ]
      },
      {
        text: '参考',
        items: [
          { text: '命令与环境变量', link: '/cli' },
          { text: '测试 API', link: '/test-api' },
          { text: '常见问题', link: '/faq' }
        ]
      }
    ],

    socialLinks: [{ icon: 'github', link: REPO_URL }],

    editLink: {
      pattern: `${REPO_URL}/edit/main/docs/:path`,
      text: '在 GitHub 上编辑此页'
    },

    search: {
      provider: 'local',
      options: {
        miniSearch: {
          // 默认只按空格和标点分词，中文整句是一个词，搜不到句子中间的词。这里按词典分词。
          // 会序列化后在浏览器里执行，函数里不能引用外部变量
          options: {
            tokenize(text: string) {
              const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
              return Array.from(segmenter.segment(text))
                .filter(s => s.isWordLike)
                .map(s => s.segment);
            }
          },
          // 「页面栈」分成「页面」「栈」两个词，要都出现才算命中
          searchOptions: { combineWith: 'AND' }
        },
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详细列表',
            resetButtonTitle: '清除查询条件',
            backButtonTitle: '关闭搜索',
            noResultsText: '没有找到结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '上方向键',
              navigateDownKeyAriaLabel: '下方向键',
              closeText: '关闭',
              closeKeyAriaLabel: 'Esc'
            }
          }
        }
      }
    },

    footer: {
      message: '基于 MIT 许可发布。内置基础库是微信官方代码，版权归腾讯所有',
      copyright: `<a href="${REPO_URL}">open-wxa/wxa-runner</a>`
    },

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新于' },
    notFound: {
      title: '页面不存在',
      quote: '地址可能写错了，或者页面已经移动',
      linkText: '返回首页'
    },
    langMenuLabel: '切换语言',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳到正文'
  }
});

function pageUrl(relativePath: string) {
  return SITE_URL + relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
}
