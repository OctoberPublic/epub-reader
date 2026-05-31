// 目次(TOC)ドロワーの中身を生成する。
// foliate の book.toc は [{ label, href, subitems? }] という入れ子構造。

export function renderTOC(listEl, toc, onSelect) {
  listEl.textContent = ''
  const linkByHref = new Map()

  const build = (items, depth) => {
    for (const item of items ?? []) {
      if (item.label) {
        const a = document.createElement('a')
        a.className = 'toc-item'
        a.textContent = item.label.trim()
        a.style.paddingInlineStart = `${12 + depth * 16}px`
        if (item.href) {
          a.href = '#'
          a.dataset.href = item.href
          a.addEventListener('click', (e) => {
            e.preventDefault()
            onSelect(item.href)
          })
          linkByHref.set(item.href, a)
        }
        listEl.append(a)
      }
      if (item.subitems?.length) build(item.subitems, depth + 1)
    }
  }
  build(toc, 0)

  return {
    // 現在地に対応する目次項目をハイライトする。
    setCurrentHref(href) {
      for (const a of listEl.querySelectorAll('.toc-item.current')) {
        a.classList.remove('current')
      }
      if (!href) return
      const a = linkByHref.get(href)
      if (a) a.classList.add('current')
    },
    isEmpty: linkByHref.size === 0,
  }
}
