// 表示設定ドロワーの中身を生成する。変更のたびに onChange(newSettings) を呼ぶ。

const THEME_OPTIONS = [
  { value: 'light', label: '白' },
  { value: 'sepia', label: 'セピア' },
  { value: 'dark', label: '夜' },
]

export function renderSettings(bodyEl, settings, onChange) {
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
