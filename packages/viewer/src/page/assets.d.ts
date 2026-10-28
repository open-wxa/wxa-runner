/** 图片由 tsup 以 data URL 内联进 viewer.js（见 tsup.config.ts 的 loader） */
declare module '*.png' {
  const url: string;
  export default url;
}
