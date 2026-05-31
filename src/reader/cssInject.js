// 設定とテーマから、foliate の本文(コンテンツ iframe)へ注入する CSS を組み立てる。
// renderer.setStyles(css) に渡す。

import { getTheme } from './themes.js'

// 本文へ注入する user stylesheet。
export function buildContentCSS(settings) {
  const t = getTheme(settings.theme)
  const colorScheme = settings.theme === 'dark' ? 'dark' : 'light'
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${colorScheme};
      background: ${t.bg} !important;
      color: ${t.fg} !important;
      font-size: ${settings.fontSize}% !important;
      -webkit-text-size-adjust: none;
    }
    body {
      background: ${t.bg} !important;
      color: ${t.fg} !important;
    }
    p, li, blockquote, dd {
      line-height: ${settings.lineHeight};
      text-align: ${settings.justify ? 'justify' : 'start'};
      -webkit-hyphens: auto;
      hyphens: auto;
      hanging-punctuation: allow-end last;
      widows: 2;
    }
    /* align 属性は尊重する */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    pre { white-space: pre-wrap !important; }
    a, a:link { color: ${t.link} !important; }
    /* 脚注の inline 表示を抑制(reader.js 準拠) */
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] { display: none; }
  `
}

// アプリのクローム(セーフエリア/ノッチ裏など)に使う地色・文字色を返す。
export function getChromeColors(settings) {
  return getTheme(settings.theme)
}
