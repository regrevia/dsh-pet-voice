/**
 * DSH Web GUI 里的「大肥鱼」面板：配对二维码、已绑定设备、宿主侧参数。
 *
 * 侧栏那一行由 shell 自己画（按钮、文字、图标尺寸、折叠态都是它的），这里只交
 * 一个鲸鱼图标和中心栏页面，和 skill-center、task-board 是同一个席位协议。
 * 两条注册都套 `slots.inject`：席位没被声明时回调不跑，面板就是没有，而不是炸掉启动。
 *
 * 数据全走同源的 `/pet-voice/panel/*`（宿主只放行回环地址）：网页这边没有手机令牌，
 * 也就不该假装有。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-voice',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'pet-voice'
    const API = '/pet-voice/panel'

    const S = {
      view: {
        padding: '28px 32px 64px',
        maxWidth: 720,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        color: 'inherit',
      },
      section: { display: 'flex', flexDirection: 'column', gap: 12 },
      title: { fontSize: 13, opacity: 0.6, margin: 0, fontWeight: 500 },
      row: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
      device: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        padding: '10px 0',
        borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      },
      name: { fontSize: 14 },
      meta: { fontSize: 12, opacity: 0.55 },
      grow: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      input: {
        font: 'inherit',
        fontSize: 13,
        padding: '5px 8px',
        borderRadius: 6,
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        background: 'transparent',
        color: 'inherit',
        minWidth: 0,
      },
      qr: { width: 200, height: 200, padding: 8, background: '#fff', borderRadius: 8 },
      error: { fontSize: 12, color: '#d6584f' },
      empty: { fontSize: 13, opacity: 0.55 },
    }

    /** 侧栏那一行的图标：只画鲸鱼，尺寸与选中态由 shell 给。 */
    function WhaleIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M1.6 8.4c0-2.3 2-4.1 4.4-4.1 2.3 0 3.6 1.3 4.3 2.5.4-.5 1.1-.8 1.8-.6-.2.5-.2 1.1 0 1.6.9.3 1.6 1 1.9 2-.1 2-1.8 3.6-4 3.6-1 0-1.6-.3-2.2-.7-.5.4-1 .6-1.7.6-.9 0-1.6-.4-2-.9.5-.2.8-.6.8-1.1',
        }),
        h('path', { d: 'M6.4 6.9 5.7 5.2' }),
        h('circle', { cx: 5.9, cy: 8.2, r: 0.55, fill: 'currentColor', stroke: 'none' }),
      )
    }

    async function request(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'request failed')
      return data
    }

    const draftOf = (s) => ({
      mode: s.mode,
      customUrl: s.customUrl,
      maxDevices: String(s.maxDevices),
      voice: s.voice,
      projectTitle: s.projectTitle,
      wakeName: s.wakeName,
      persona: s.persona ?? '',
      maxWords: s.maxWords ?? '短',
      bubble: s.bubble !== false,
      transport: s.transport === 'poll' ? 'poll' : 'auto',
    })

    const TRANSPORT_OPTIONS = [
      { id: 'auto', label: '自动' },
      { id: 'poll', label: '只用轮询' },
    ]

    const MAXWORD_OPTIONS = [
      { id: '短', label: '短' },
      { id: '中', label: '中' },
      { id: '长', label: '长' },
    ]

    function ago(ms) {
      const t = Number(ms) || 0
      if (!t) return ''
      const d = Date.now() - t
      if (d < 60e3) return '刚刚'
      if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`
      if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`
      return `${Math.floor(d / 86400e3)} 天前`
    }

    function Section({ title, children }) {
      return h('section', { style: S.section }, h('h3', { style: S.title }, title), children)
    }

    function Input({ value, onChange, onCommit, type, width }) {
      return h('input', {
        type: type ?? 'text',
        value,
        style: { ...S.input, width: width ?? 200 },
        onChange: (e) => onChange(e.target.value),
        onBlur: () => onCommit(),
        onKeyDown: (e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        },
      })
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [qr, setQr] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const [confirmRotate, setConfirmRotate] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const next = await request('/state')
          setState(next)
          setDraft(draftOf(next))
          setError('')
          return next
        } catch {
          setError('读取失败')
          return null
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        load()
        return () => {
          alive = false
        }
      }, [load])

      const pairingUrl = state?.pairingUrl ?? ''
      React.useEffect(() => {
        if (!pairingUrl) {
          setQr('')
          return
        }
        let alive = true
        fetch(`${API}/qr.svg?text=${encodeURIComponent(pairingUrl)}`, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.text() : ''))
          .then((text) => {
            if (alive) setQr(text)
          })
          .catch(() => {
            if (alive) setQr('')
          })
        return () => {
          alive = false
        }
      }, [pairingUrl])

      const save = React.useCallback(
        async (patch) => {
          try {
            const next = await request('/state', patch)
            setState(next)
            setDraft(draftOf(next))
            setError('')
          } catch (e) {
            setError(String(e?.message || '保存失败'))
          }
        },
        [],
      )

      const field = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }))
      const commit = (key) => () => {
        if (!draft || !state) return
        const raw = draft[key]
        if (String(raw) === String(state[key])) return
        save(key === 'maxDevices' ? { maxDevices: Number(raw) || 1 } : { [key]: raw })
      }

      if (!state || !draft) {
        return h('div', { style: S.view }, error ? h('div', { style: S.error }, error) : null)
      }

      const mode = state.modes.find((m) => m.id === draft.mode)

      const copyLink = async () => {
        if (!pairingUrl) return
        try {
          await navigator.clipboard.writeText(pairingUrl)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          setError('复制失败，手动选中链接复制')
        }
      }

      const rotate = async () => {
        if (!confirmRotate) {
          setConfirmRotate(true)
          setTimeout(() => setConfirmRotate(false), 4000)
          return
        }
        setConfirmRotate(false)
        try {
          setState(await request('/rotate-token', {}))
        } catch {
          setError('换新令牌失败')
        }
      }

      const linkRow = pairingUrl
        ? h(
            'div',
            { style: { ...S.row, gap: 8 } },
            h('input', {
              value: pairingUrl,
              readOnly: true,
              onFocus: (e) => e.target.select(),
              style: { ...S.input, flex: 1, minWidth: 240, opacity: 0.75 },
            }),
            h(
              'button',
              { style: S.button, onClick: copyLink },
              copied ? '已复制' : '复制链接',
            ),
            h(
              'button',
              { style: S.button, onClick: rotate },
              confirmRotate ? '再点一次' : '换新令牌',
            ),
          )
        : null

      const pairSection = h(
        Section,
        { title: '连上手机' },
        h(
          'div',
          { style: S.row },
          qr
            ? h('div', { style: S.qr, dangerouslySetInnerHTML: { __html: qr } })
            : h('div', { style: S.empty }, '先选一种连法'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'select',
              {
                value: draft.mode,
                style: { ...S.input, width: 160 },
                onChange: (e) => save({ mode: e.target.value }),
              },
              state.modes.map((m) => h('option', { key: m.id, value: m.id }, m.label)),
            ),
            mode?.url ? h('div', { style: S.meta }, mode.url) : null,
            draft.mode === 'domain'
              ? h(Input, {
                  value: draft.customUrl,
                  onChange: field('customUrl'),
                  onCommit: commit('customUrl'),
                  width: 240,
                  placeholder: 'https://你的域名',
                })
              : null,
          ),
        ),
        linkRow,
      )

      const devices = state.devices ?? []
      const deviceSection = h(
        Section,
        { title: '已连上的手机' },
        devices.length
          ? h(
              'div',
              null,
              devices.map((d) =>
                h(
                  'div',
                  { key: d.id, style: S.device },
                  h('span', { style: S.name }, d.label || d.id),
                  h('span', { style: S.meta }, d.platform),
                  h('span', { style: S.meta }, ago(d.lastSeen)),
                  h('span', { style: S.grow }),
                  h(
                    'button',
                    {
                      style: S.button,
                      onClick: async () => {
                        try {
                          const next = await request('/unbind', { id: d.id })
                          setState(next)
                        } catch {
                          setError('解绑失败')
                        }
                      },
                    },
                    '移出列表',
                  ),
                ),
              ),
            )
          : h('div', { style: S.empty }, '还没有手机连上'),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '同时绑定'),
          h(Input, {
            type: 'number',
            value: draft.maxDevices,
            onChange: field('maxDevices'),
            onCommit: commit('maxDevices'),
            width: 72,
          }),
        ),
      )

      const paramsSection = h(
        Section,
        { title: '对话' },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '唤醒词'),
          h(Input, { value: draft.wakeName, onChange: field('wakeName'), onCommit: commit('wakeName') }),
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '音色'),
          h(Input, { value: draft.voice, onChange: field('voice'), onCommit: commit('voice') }),
        ),
        h(
          'div',
          { style: { ...S.row, alignItems: 'flex-start' } },
          h('span', { style: S.meta }, '人设'),
          h('textarea', {
            value: draft.persona,
            rows: 4,
            style: { ...S.input, width: '100%', maxWidth: 520, resize: 'vertical', lineHeight: 1.5 },
            onChange: (e) => field('persona')(e.target.value),
            onBlur: () => commit('persona')(),
          }),
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '输出长度'),
          h(
            'select',
            {
              value: draft.maxWords,
              style: { ...S.input, width: 96 },
              onChange: (e) => {
                field('maxWords')(e.target.value)
                save({ maxWords: e.target.value })
              },
            },
            MAXWORD_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '气泡'),
          h(
            'button',
            {
              style: S.button,
              onClick: () => {
                const next = !draft.bubble
                field('bubble')(next)
                save({ bubble: next })
              },
            },
            draft.bubble ? '开' : '关',
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '传输方式'),
          h(
            'select',
            {
              value: draft.transport,
              style: { ...S.input, width: 96 },
              onChange: (e) => {
                field('transport')(e.target.value)
                save({ transport: e.target.value })
              },
            },
            TRANSPORT_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.meta }, '专属项目'),
          h(Input, {
            value: draft.projectTitle,
            onChange: field('projectTitle'),
            onCommit: commit('projectTitle'),
          }),
        ),
        error ? h('div', { style: S.error }, error) : null,
      )

      return h('div', { style: S.view, 'data-dsh-panel': PANEL_ID }, pairSection, deviceSection, paramsSection)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        const disposers = []
        disposers.push(
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: '大肥鱼' }, WhaleIcon),
          ),
        )
        disposers.push(
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Panel)),
        )
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      },
    }
  },
})
