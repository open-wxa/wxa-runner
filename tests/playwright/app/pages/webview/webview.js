Page({
  data: { src: '' },

  onLoad(query) {
    this.setData({ src: decodeURIComponent(query.src || '') });
  },

  setSrc(src) {
    this.setData({ src });
  }
});
