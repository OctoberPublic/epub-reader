// 表示設定ドロワーの中身を生成する。変更のたびに onChange(newSettings) を呼ぶ。

const THEME_OPTIONS = [
  { value: 'light', label: '白' },
  { value: 'sepia', label: 'セピア' },
  { value: 'dark', label: '夜' },
]

// opts: { fixedLayout?: { value, onToggle }, version?: string }
//   fixedLayout … 「この本」固有の見開き(固定レイアウト)強制トグル(グローバル設定とは別)
//   version     … 設定パネル下部に表示するアプリのバージョン文字列
export function renderSettings(bodyEl, settings, onChange, opts = {}) {
  // settings はミューテートせずコピーを更新して通知する。
  const state = { ...settings }
  const emit = () => onChange({ ...state })

  bodyEl.textContent = ''

  // --- テーマ(セグメント) ---
  const themeRow = section('テーマ')
  const seg = document.createElement('div')
  seg.className = 'segment'
  const themeButtons = []
  for (const opt of THEME_OPTIONS) {
    const b = document.createElement('button')
    b.className = 'segment-button'
    b.textContent = opt.label
    b.dataset.value = opt.value
    if (state.theme === opt.value) b.classList.add('active')
    b.addEventListener('click', () => {
      state.theme = opt.value
      for (const x of themeButtons) x.classList.toggle('active', x.dataset.value === opt.value)
      emit()
    })
    themeButtons.push(b)
    seg.append(b)
  }
  themeRow.append(seg)
  bodyEl.append(themeRow)

  // --- 文字サイズ ---
  bodyEl.append(stepperRow('文字サイズ', () => `${state.fontSize}%`, [
    { label: 'A−', onClick: () => adjust('fontSize', -10, 50, 300) },
    { label: 'A＋', onClick: () => adjust('fontSize', +10, 50, 300) },
  ]))

  // --- 行間 ---
  bodyEl.append(stepperRow('行間', () => state.lineHeight.toFixed(1), [
    { label: '−', onClick: () => adjust('lineHeight', -0.1, 1.0, 2.6, 1) },
    { label: '＋', onClick: () => adjust('lineHeight', +0.1, 1.0, 2.6, 1) },
  ]))

  // --- 余白 ---
  bodyEl.append(stepperRow('余白', () => `${state.margin}px`, [
    { label: '−', onClick: () => adjust('margin', -8, 0, 120) },
    { label: '＋', onClick: () => adjust('margin', +8, 0, 120) },
  ]))

  // --- 両端揃え ---
  const justifyRow = section('両端揃え')
  const toggle = document.createElement('button')
  toggle.className = 'toggle-button'
  const renderToggle = () => {
    toggle.textContent = state.justify ? 'オン' : 'オフ'
    toggle.classList.toggle('active', state.justify)
  }
  renderToggle()
  toggle.addEventListener('click', () => {
    state.justify = !state.justify
    renderToggle()
    emit()
  })
  justifyRow.append(toggle)
  bodyEl.append(justifyRow)

  // --- この本の表示: 見開き(固定レイアウト)強制トグル ---
  if (opts.fixedLayout) {
    const row = section('この本の表示')
    const fxlToggle = document.createElement('button')
    fxlToggle.className = 'toggle-button'
    let on = !!opts.fixedLayout.value
    const renderFxl = () => {
      fxlToggle.textContent = on ? '見開き(固定レイアウト): オン' : '見開き(固定レイアウト): オフ'
      fxlToggle.classList.toggle('active', on)
    }
    renderFxl()
    fxlToggle.addEventListener('click', () => {
      on = !on
      renderFxl()
      opts.fixedLayout.onToggle(on) // 本を再オープンするため、これ以降この panel は閉じられる
    })
    row.append(fxlToggle)
    const hint = document.createElement('div')
    hint.className = 'settings-hint'
    hint.textContent = '漫画など画像主体の本が見開きにならない場合にオン'
    row.append(hint)
    bodyEl.append(row)
  }

  // --- バージョン表示(デプロイ確認用) ---
  if (opts.version) {
    const v = document.createElement('div')
    v.className = 'settings-version'
    v.textContent = `ver ${opts.version}`
    bodyEl.append(v)
  }

  // ---- helpers ----
  function section(title) {
    const row = document.createElement('div')
    row.className = 'settings-row'
    const label = document.createElement('div')
    label.className = 'settings-label'
    label.textContent = title
    row.append(label)
    return row
  }

  function stepperRow(title, getValueText, buttons) {
    const row = section(title)
    const ctrl = document.createElement('div')
    ctrl.className = 'stepper'
    const valueEl = document.createElement('span')
    valueEl.className = 'stepper-value'
    valueEl.textContent = getValueText()
    const refresh = () => { valueEl.textContent = getValueText() }
    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.className = 'stepper-button'
      btn.textContent = b.label
      btn.addEventListener('click', () => { b.onClick(); refresh() })
      ctrl.append(btn)
    }
    ctrl.append(valueEl)
    row.append(ctrl)
    return row
  }

  function adjust(key, delta, min, max, decimals = 0) {
    let v = state[key] + delta
    v = Math.min(max, Math.max(min, v))
    state[key] = decimals ? Number(v.toFixed(decimals)) : Math.round(v)
    emit()
  }
}
