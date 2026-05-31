// 配色テーマ定義。bg=地色, fg=文字色, link=リンク色。

export const THEMES = {
  light: { bg: '#ffffff', fg: '#1a1a1a', link: '#1a6dd0' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a5a2b' },
  dark: { bg: '#121212', fg: '#cfcfcf', link: '#8ab4f8' },
}

export function getTheme(name) {
  return THEMES[name] ?? THEMES.light
}
