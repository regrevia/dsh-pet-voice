/**
 * DSH Web GUI 里的「大肥鱼」面板：连接方式、配对二维码、已绑定设备、对话参数。
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

    const C = {
      bg: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
      dim: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      brand: 'var(--dsw-alias-brand-primary, #10a37f)',
      error: 'var(--dsw-alias-state-error-primary, #d6584f)',
      errorBg: 'var(--dsw-alias-state-error-primary, #d6584f)',
    }

    const S = {
      // 宿主给的面板槽位是 overflow:hidden 的定高容器：根节点必须自己滚，
      // 不然超出一屏的「手机」那节永远看不到，滚轮也带不动。
      view: {
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        padding: '32px 32px 72px',
        color: 'inherit',
      },
      inner: {
        maxWidth: 640,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      title: { fontSize: 12, color: C.dim, margin: 0, fontWeight: 500, letterSpacing: '0.04em' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: 'hidden',
      },
      row: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' },
      rowBorder: { borderTop: `1px solid ${C.border}` },
      label: { fontSize: 13, minWidth: 64 },
      grow: { flex: 1 },
      link: { fontSize: 13, color: C.brand, textDecoration: 'none' },
      meta: { fontSize: 12, color: C.dim },
      rowSub: { fontSize: 12, color: C.dim, lineHeight: 1.5, padding: '0 14px 10px' },
      device: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' },
      name: { fontSize: 13 },
      button: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: C.brand,
        color: '#fff',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      input: {
        font: 'inherit',
        fontSize: 13,
        padding: '6px 9px',
        borderRadius: 8,
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: 'inherit',
        minWidth: 0,
      },
      mode: (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '13px 14px',
        cursor: 'pointer',
        background: active ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))' : 'transparent',
      }),
      radio: (active) => ({
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `1.5px solid ${active ? C.brand : C.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }),
      radioDot: { width: 6, height: 6, borderRadius: '50%', background: C.brand },
      qrCard: {
        width: 176,
        height: 176,
        padding: 10,
        borderRadius: 12,
        background: '#fff',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      },
      hint: { fontSize: 12, color: C.dim, padding: '0 2px', margin: 0 },
      switch: (on) => ({
        width: 34,
        height: 20,
        borderRadius: 10,
        border: 'none',
        padding: 0,
        position: 'relative',
        cursor: 'pointer',
        flex: 'none',
        background: on ? C.brand : 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      }),
      knob: (on) => ({
        position: 'absolute',
        top: 2,
        left: on ? 16 : 2,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 120ms ease',
      }),
      pair: { display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' },
      pairSide: { display: 'flex', flexDirection: 'column', gap: 10, flex: '1 1 240px', minWidth: 0 },
      error: { fontSize: 12, color: C.error, padding: '8px 12px', border: `1px solid ${C.errorBg}`, borderRadius: 8 },
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
      voice: s.voice,
      ttsProvider: s.ttsProvider ?? 'edge',
      ttsUrl: s.ttsUrl ?? '',
      ttsVoice: s.ttsVoice ?? '',
      wakeName: s.wakeName,
      persona: s.persona ?? '',
      maxWords: s.maxWords ?? '短',
      peek: s.peek ?? 'ask',
      newReasoning: s.newReasoning ?? '',
      bubble: s.bubble !== false,
    })

    /** 服务器转发的三个字段：账号、公网地址、私钥。 */
    const pubDraftOf = (p) => ({
      account: p?.user && p?.host ? `${p.user}@${p.host}${p.sshPort && Number(p.sshPort) !== 22 ? `:${p.sshPort}` : ''}` : '',
      addr: p?.url ?? '',
      keyPath: p?.keyPath ?? '',
    })

    /** 选中的连法还没有地址时，二维码位置说什么。 */
    const MODE_HINT = {
      server: '服务器还没连上。',
      lan: '手机得和这台电脑同一个 Wi-Fi，电脑防火墙放行才连得上。',
      domain: '填好域名，二维码就出来。',
    }

    /** 每种方案要用户先准备好什么，只有一行。 */
    const MODE_NEED = {
      server: '要一台能 SSH 的服务器',
      lan: '手机和电脑连同一个 Wi-Fi',
      domain: '要已经能打开的域名',
    }

    const VOICES = [
      { id: 'zh-CN-XiaoyiNeural', label: '晓伊' },
      { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓' },
      { id: 'zh-CN-YunxiNeural', label: '云希' },
      { id: 'zh-CN-YunjianNeural', label: '云健' },
      { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北' },
    ]

    const TTS_PROVIDERS = [
      { id: 'edge', label: '微软在线' },
      { id: 'local', label: '这台电脑' },
      { id: 'http', label: '自己的接口' },
    ]

    /** 旁听：手机上问进展时只读看一眼同项目里另一只的活。 */
    const PEEK_OPTIONS = [
      { id: 'ask', label: '问进展时' },
      { id: 'always', label: '每一句' },
      { id: 'off', label: '关' },
    ]

    /** App 新建会话默认用哪一档推理；'' = 跟随桌面端。 */
    const REASONING_OPTIONS = [
      { id: '', label: '跟随桌面端' },
      { id: 'off', label: '关闭' },
      { id: 'minimal', label: '最低' },
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
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

    function Input({ value, onChange, onCommit, type, width, placeholder }) {
      return h('input', {
        type: type ?? 'text',
        value,
        placeholder,
        style: { ...S.input, width: width ?? 180 },
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
      const [pub, setPub] = React.useState(null)
      const [pubDraft, setPubDraft] = React.useState(null)
      const [pubBusy, setPubBusy] = React.useState(false)
      const [pubError, setPubError] = React.useState('')

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

      const loadPub = React.useCallback(async () => {
        try {
          const data = await request('/public')
          setPub(data)
          setPubDraft(pubDraftOf(data))
        } catch {
          /* 拿不到就把这块留空 */
        }
      }, [])

      React.useEffect(() => {
        loadPub()
      }, [loadPub])

      // 二维码只跟「已经能用的地址」走：面板不给还没填好的连法画码。
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

      const save = React.useCallback(async (patch) => {
        try {
          const next = await request('/state', patch)
          setState(next)
          setDraft(draftOf(next))
          setError('')
        } catch (e) {
          setError(String(e?.message || '保存失败'))
        }
      }, [])

      // 本机音色是开机状态里带上来的（say 的音色名），和微软那份白名单不是一套。
      const LOCAL_VOICES = Array.isArray(state?.localVoices) ? state.localVoices : []
      const voiceList = draft?.ttsProvider === 'local' ? LOCAL_VOICES : VOICES
      const voiceValue = draft?.ttsProvider === 'local' ? draft.ttsVoice : draft?.voice
      const setVoice = (id) => {
        if (draft?.ttsProvider === 'local') {
          setDraft((d) => ({ ...d, ttsVoice: id }))
          save({ ttsVoice: id })
        } else {
          field('voice')(id)
          save({ voice: id })
        }
      }

      const field = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }))
      const commit = (key) => () => {
        if (!draft || !state) return
        const raw = draft[key]
        if (String(raw) === String(state[key])) return
        save({ [key]: raw })
      }

      if (!state || !draft) {
        return h('div', { style: S.view }, error ? h('div', { style: S.error }, error) : null)
      }

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
          setError('换新链接失败')
        }
      }

      /* ---------------- 自己的服务器：只有选了这个方案才展开 ---------------- */

      const pubField = (key) => (value) => setPubDraft((d) => ({ ...(d ?? {}), [key]: value }))

      const postPub = async (patch) => {
        try {
          const data = await request('/public', patch)
          setPub(data)
          setPubDraft(pubDraftOf(data))
          setPubError('')
        } catch (e) {
          setPubError(String(e?.message || '存不进去'))
        }
      }

      const commitAccount = async () => {
        const raw = String(pubDraft?.account ?? '').trim()
        const m = /^([^@\s]+)@([A-Za-z0-9._:\-[\]]+?)(?::(\d{1,5}))?$/.exec(raw)
        if (!m) return setPubError('写成 账号@服务器')
        await postPub({ user: m[1], host: m[2], sshPort: m[3] ?? 22 })
      }

      const commitAddr = async () => {
        const raw = String(pubDraft?.addr ?? '').trim()
        if (!raw) return
        let parsed
        try {
          parsed = new URL(raw)
        } catch {
          return setPubError('写成 https://服务器:8443')
        }
        if (parsed.protocol !== 'https:') return setPubError('要以 https:// 开头')
        await postPub({ host: parsed.hostname, remotePort: parsed.port || 443 })
      }

      const connectPub = async () => {
        setPubBusy(true)
        setPubError('')
        try {
          const data = await request('/public/connect', {})
          setPub(data)
          setPubDraft(pubDraftOf(data))
          await load()
        } catch (e) {
          setPubError(String(e?.message || '连不上服务器'))
          await loadPub()
        } finally {
          setPubBusy(false)
        }
      }

      const disconnectPub = async () => {
        setPubBusy(true)
        try {
          setPub(await request('/public/disconnect', {}))
          setPubError('')
        } catch {
          setPubError('断开失败，再点一次')
        } finally {
          setPubBusy(false)
        }
      }

      const pubStatus = !pub
        ? ''
        : pub.running
          ? '正在转发'
          : pub.lastError
            ? String(pub.lastError)
            : pub.configured
              ? '没有在跑'
              : ''

      const pubInline = h(
        'div',
        { style: { ...S.mode(false), flexDirection: 'column', alignItems: 'stretch', gap: 8, cursor: 'default' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { style: S.label }, '服务器'),
          h(Input, {
            value: pubDraft?.account ?? '',
            onChange: pubField('account'),
            onCommit: commitAccount,
            placeholder: 'ubuntu@1.2.3.4',
            width: '100%',
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { style: S.label }, '公网地址'),
          h(Input, {
            value: pubDraft?.addr ?? '',
            onChange: pubField('addr'),
            onCommit: commitAddr,
            placeholder: 'https://1.2.3.4:8443',
            width: '100%',
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { style: S.label }, '私钥'),
          h(Input, {
            value: pubDraft?.keyPath ?? '',
            onChange: pubField('keyPath'),
            onCommit: () => postPub({ keyPath: String(pubDraft?.keyPath ?? '') }),
            placeholder: '~/.ssh/id_ed25519',
            width: '100%',
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          pub?.running
            ? h('button', { style: S.button, disabled: pubBusy, onClick: disconnectPub }, '断开')
            : h('button', { style: S.button, disabled: pubBusy, onClick: connectPub }, pubBusy ? '正在连…' : '连接'),
          h('span', { style: { ...S.hint, flex: 1, minWidth: 0 } }, pubError || pubStatus),
        ),
      )

      /* ---------------- 连上手机：三种方案，选一个填好就出二维码 ---------------- */

      const pairSection = h(
        Section,
        { title: '连上手机' },
        h(
          'div',
          { style: S.card },
          state.modes.map((m, index) => {
            const active = m.id === draft.mode
            const address = m.id === 'domain' ? draft.customUrl : m.url
            return h(
              'div',
              {
                key: m.id,
                style: { ...S.mode(active), ...(index ? S.rowBorder : null) },
                onClick: () => {
                  if (active) return
                  field('mode')(m.id)
                  save({ mode: m.id })
                },
              },
              h('span', { style: S.radio(active) }, active ? h('span', { style: S.radioDot }) : null),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('span', { style: S.name }, m.label),
                h(
                  'span',
                  { style: { ...S.meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  active && address ? address : MODE_NEED[m.id] || '',
                ),
              ),
            )
          }),
          draft.mode === 'domain'
            ? h(
                'div',
                { style: { ...S.row, ...S.rowBorder }, onClick: (e) => e.stopPropagation() },
                h(Input, {
                  value: draft.customUrl,
                  onChange: field('customUrl'),
                  onCommit: commit('customUrl'),
                  width: '100%',
                  placeholder: 'https://你的域名',
                }),
              )
            : null,
          draft.mode === 'server' ? pubInline : null,
        ),
        qr
          ? h(
              'div',
              { style: S.pair },
              h('div', { style: S.qrCard, dangerouslySetInnerHTML: { __html: qr } }),
              h(
                'div',
                { style: S.pairSide },
                h('input', {
                  value: pairingUrl,
                  readOnly: true,
                  onFocus: (e) => e.target.select(),
                  style: { ...S.input, width: '100%', color: C.dim },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('button', { style: S.primary, onClick: copyLink }, copied ? '已复制' : '复制链接'),
                  h('button', { style: S.button, onClick: rotate }, confirmRotate ? '再点一次' : '换新链接'),
                ),
              ),
            )
          : h('div', { style: S.hint }, MODE_HINT[draft.mode] || '选一种连法'),
      )

      /* ---------------- 人设 ---------------- */

      const paramRow = (label, control) =>
        h('div', { style: { ...S.row, ...S.rowBorder } }, h('span', { style: S.label }, label), control)

      const paramsSection = h(
        Section,
        { title: '人设' },
        h(
          'div',
          { style: S.card },
          paramRow(
            '怎么叫它',
            h(Input, {
              value: draft.wakeName,
              onChange: field('wakeName'),
              onCommit: commit('wakeName'),
              placeholder: '大肥鱼',
            }),
          ),
          paramRow(
            '语音来源',
            h(
              'select',
              {
                value: draft.ttsProvider,
                style: { ...S.input, width: 140 },
                onChange: (e) => {
                  const ttsProvider = e.target.value
                  setDraft((d) => ({ ...d, ttsProvider }))
                  save({ ttsProvider })
                },
              },
              TTS_PROVIDERS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
          ),
          draft.ttsProvider === 'http' && !String(draft.ttsUrl || '').trim()
            ? h(
                'div',
                { style: { ...S.row, color: 'var(--dsw-alias-state-warning-primary, #b7791f)', fontSize: 12 } },
                '填上接口地址，手机才会出声。',
              )
            : null,
          draft.ttsProvider === 'http'
            ? paramRow(
                '接口地址',
                h(Input, {
                  value: draft.ttsUrl,
                  onChange: field('ttsUrl'),
                  onCommit: commit('ttsUrl'),
                  placeholder: 'http://127.0.0.1:9880/tts',
                }),
              )
            : null,
          state.ttsReady === false && draft.ttsProvider === 'edge'
            ? h(
                'div',
                { style: { ...S.row, color: 'var(--dsw-alias-state-warning-primary, #b7791f)', fontSize: 12 } },
                '这台电脑还没装语音：在仓库里跑 bash plugins/dsh-pet-voice/tts/setup.sh，装完刷新这一页。',
              )
            : null,
          paramRow(
            '音色',
            draft.ttsProvider === 'http'
              ? h(Input, {
                  value: draft.ttsVoice,
                  onChange: field('ttsVoice'),
                  onCommit: commit('ttsVoice'),
                  placeholder: '接口默认',
                  width: 140,
                })
              : h(
                  'select',
                  {
                    value: voiceValue,
                    style: { ...S.input, width: 140 },
                    onChange: (e) => setVoice(e.target.value),
                  },
                  (voiceList.some((item) => item.id === voiceValue)
                    ? voiceList
                    : [...voiceList, { id: voiceValue, label: voiceValue || '默认' }]
                  ).map((item) => h('option', { key: item.id, value: item.id }, item.name || item.label)),
                ),
          ),
          h(
            'div',
            { style: { ...S.row, ...S.rowBorder, flexDirection: 'column', alignItems: 'stretch', gap: 8 } },
            h('span', { style: { ...S.label, minWidth: 0 } }, '说话方式'),
            h('textarea', {
              value: draft.persona,
              rows: 4,
              placeholder: '它该怎么说话',
              style: { ...S.input, width: '100%', resize: 'vertical', lineHeight: 1.6 },
              onChange: (e) => field('persona')(e.target.value),
              onBlur: () => commit('persona')(),
            }),
          ),
          paramRow(
            '旁听',
            h(
              'select',
              {
                value: draft.peek,
                style: { ...S.input, width: 120 },
                onChange: (e) => {
                  setDraft((d) => ({ ...d, peek: e.target.value }))
                  save({ peek: e.target.value })
                },
              },
              PEEK_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
          ),
          paramRow(
            '新会话推理',
            h(
              'select',
              {
                value: draft.newReasoning,
                style: { ...S.input, width: 140 },
                onChange: (e) => {
                  setDraft((d) => ({ ...d, newReasoning: e.target.value }))
                  save({ newReasoning: e.target.value })
                },
              },
              REASONING_OPTIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
            ),
          ),
          paramRow(
            '一句话长短',
            h(
              'select',
              {
                value: draft.maxWords,
                style: { ...S.input, width: 84 },
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
            { style: { ...S.row, ...S.rowBorder, justifyContent: 'space-between' } },
            h('span', { style: S.label }, '气泡'),
            h(
              'button',
              {
                style: S.switch(draft.bubble),
                'aria-label': '气泡',
                onClick: () => {
                  const next = !draft.bubble
                  field('bubble')(next)
                  save({ bubble: next })
                },
              },
              h('span', { style: S.knob(draft.bubble) }),
            ),
          ),
        ),
      )

      /* ---------------- 手机 App ---------------- */

      const app = state.app ?? {}
      const appSection = h(
        Section,
        { title: '手机 App' },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.device },
            h('span', { style: S.name }, '装到新手机上'),
            h('span', { style: S.grow }),
            h('a', { href: app.url || '', target: '_blank', rel: 'noreferrer', style: S.link }, app.versionName ? `下载 ${app.versionName}` : '去下载'),
          ),
        ),
      )

      /* ---------------- 已连上的手机 ---------------- */

      const devices = state.devices ?? []
      const maxDevices = Number(state.maxDevices) || 2
      // 上限以前只能手改文件：手机被 429 挡住时面板里没有出路。加减各一步就够。
      const saveMax = async (raw) => {
        const next = Math.min(8, Math.max(1, raw))
        if (next === maxDevices) return
        try {
          setState(await request('/state', { maxDevices: next }))
        } catch {
          setError('设备数没存上')
        }
      }
      const step = (delta) => ({
        ...S.button,
        minWidth: 28,
        opacity: (delta < 0 ? maxDevices <= 1 : maxDevices >= 8) ? 0.4 : 1,
        cursor: (delta < 0 ? maxDevices <= 1 : maxDevices >= 8) ? 'default' : 'pointer',
      })
      const deviceSection = h(
        Section,
        { title: '手机' },
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '最多连几台'),
            h('span', { style: S.grow }),
            h('button', { style: step(-1), onClick: () => saveMax(maxDevices - 1) }, '−'),
            h('span', { style: { ...S.name, minWidth: 20, textAlign: 'center' } }, String(maxDevices)),
            h('button', { style: step(1), onClick: () => saveMax(maxDevices + 1) }, '+'),
          ),
          devices.length
            ? devices.map((d, index) =>
                h(
                  'div',
                  { key: d.id, style: { ...S.device, ...S.rowBorder } },
                  h('span', { style: S.name }, d.label || (d.platform === 'android' ? 'Android 手机' : '手机')),
                  h('span', { style: S.grow }),
                  h('span', { style: S.meta }, ago(d.lastSeen)),
                  h(
                    'button',
                    {
                      style: S.button,
                      onClick: async () => {
                        try {
                          setState(await request('/unbind', { id: d.id }))
                        } catch {
                          setError('移出失败')
                        }
                      },
                    },
                    '移出',
                  ),
                ),
              )
            : h('div', { style: { ...S.device, color: C.dim, fontSize: 13 } }, '还没有手机连上'),
      h('div', { style: { ...S.rowSub, paddingLeft: 0 } }, '移出一台会让所有手机都断开，手机要重新扫码'),
        ),
      )

      return h(
        'div',
        { style: S.view, 'data-dsh-panel': PANEL_ID },
        h(
          'div',
          { style: S.inner },
          error ? h('div', { style: S.error }, error) : null,
          paramsSection,
          pairSection,
          appSection,
          deviceSection,
        ),
      )
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
