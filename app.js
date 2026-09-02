/* Herd — one dashboard for llama-swap across hosts.
   No build step: React UMD + htm (JSX-like templates in plain JS strings).
   All state lives in the <App> component; the host list persists to
   localStorage, everything else is refetched on each poll. */

const html = htm.bind(React.createElement);

const KEY = 'herd.hosts.v1';
const DEFAULT_HOSTS = [
  { id: 'local', name: 'localhost', url: 'http://localhost:8999' },
];
const HOST_COLORS = ['#c67139', '#7a8a5e', '#a19786', '#8c491a', '#56633f'];

/** Trim a llama-swap URL to its bare origin: no trailing slash, /ui, or #hash. */
const normUrl = (u) => (u || '').trim().replace(/#.*$/, '').replace(/\/ui\/?$/, '').replace(/\/+$/, '');
/** Compact number: 412000 → "412.0k", 2140000 → "2.1M", null → "–". */
const fmtNum = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(n));
/** Clock time "HH:MM:SS" from a timestamp or ISO string. */
const fmtTime = (ts) => { const d = new Date(ts); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':'); };
/** Remove ANSI color codes from raw log output. */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Canned host responses for ?demo=1, so the UI can be exercised with no live hosts. */
function demoData(hostId) {
  const now = Date.now();
  if (hostId === 'mbp') return {
    online: true, version: 'v182', models: [
      { id: 'qwen3-8b', name: 'Qwen3 8B', description: 'Q6_K, 32k ctx', state: 'ready' },
      { id: 'gemma3-4b', name: 'Gemma 3 4B', description: 'vision', state: 'stopped' },
      { id: 'nomic-embed', name: 'Nomic Embed v1.5', description: '', state: 'stopped' },
    ],
    activity: [
      { id: 1, timestamp: new Date(now - 40e3).toISOString(), model: 'qwen3-8b', req_path: '/v1/chat/completions', resp_status_code: 200, tokens: { input_tokens: 1240, output_tokens: 312, tokens_per_second: 41.2 }, duration_ms: 8300 },
      { id: 2, timestamp: new Date(now - 400e3).toISOString(), model: 'qwen3-8b', req_path: '/v1/chat/completions', resp_status_code: 200, tokens: { input_tokens: 480, output_tokens: 96, tokens_per_second: 43.7 }, duration_ms: 2900 },
    ],
    stats: { total_requests: 128, total_input_tokens: 412000, total_output_tokens: 98000 },
  };
  return {
    online: true, version: 'v182', models: [
      { id: 'qwen3-235b-a22b', name: 'Qwen3 235B A22B', description: 'Q4_K_M, 64k ctx', state: 'ready' },
      { id: 'glm-4.5-air', name: 'GLM 4.5 Air', description: 'Q5_K_M', state: 'starting' },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', description: 'Q4_K_M', state: 'stopped' },
      { id: 'whisper-large-v3', name: 'Whisper Large v3', description: 'transcription', state: 'stopped' },
    ],
    activity: [
      { id: 9, timestamp: new Date(now - 12e3).toISOString(), model: 'qwen3-235b-a22b', req_path: '/v1/chat/completions', resp_status_code: 200, tokens: { input_tokens: 6820, output_tokens: 1104, tokens_per_second: 18.4 }, duration_ms: 64200 },
      { id: 8, timestamp: new Date(now - 190e3).toISOString(), model: 'qwen3-235b-a22b', req_path: '/v1/messages', resp_status_code: 500, tokens: { input_tokens: 0, output_tokens: 0, tokens_per_second: -1 }, duration_ms: 120 },
      { id: 7, timestamp: new Date(now - 900e3).toISOString(), model: 'llama-3.3-70b', req_path: '/v1/chat/completions', resp_status_code: 200, tokens: { input_tokens: 2210, output_tokens: 540, tokens_per_second: 12.1 }, duration_ms: 47000 },
    ],
    stats: { total_requests: 342, total_input_tokens: 2140000, total_output_tokens: 610000 },
  };
}

const SunIcon = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>`;
const MoonIcon = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>`;
const PowerIcon = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round"><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /><path d="M12 2v8" /></svg>`;
const PlusIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>`;

class App extends React.Component {
  state = {
    hosts: (() => { try { const s = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(s) && s.length) return s; } catch (e) {} return DEFAULT_HOSTS; })(),
    data: {}, pending: {}, filter: '', hostFilter: 'all', loadedOnly: false,
    logsHost: null, logsText: '', editing: null, updatedAt: null, polling: false,
    theme: (() => { try { const t = localStorage.getItem('herd.theme'); if (t) return t; } catch (e) {} return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; })(),
    chat: null, // { hostId, modelId, messages: [{role, content, reasoning, meta}], input, streaming, error }
  };
  logsRef = React.createRef();
  chatRef = React.createRef();

  componentDidMount() { this.applyTheme(); this.pollAll(); this.startTimer(); }
  componentWillUnmount() { clearInterval(this.timer); }
  applyTheme() { document.documentElement.dataset.theme = this.state.theme; }
  toggleTheme() { const theme = this.state.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('herd.theme', theme); this.setState({ theme }, () => this.applyTheme()); }
  startTimer() { clearInterval(this.timer); this.timer = setInterval(() => this.pollAll(), Math.max(2, this.props.pollSeconds) * 1000); }

  saveHosts(hosts) { localStorage.setItem(KEY, JSON.stringify(hosts)); this.setState({ hosts }, () => this.pollAll()); }

  async fetchJson(base, path, opt) {
    const r = await fetch(base + path, { cache: 'no-store', ...opt });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return r.json();
  }

  /** Fetch one host's models, running states, activity, stats, and version.
      Tolerates partial failures — only throws when the host is unreachable. */
  async pollHost(h) {
    if (this.props.demoData) return demoData(h.id);
    const base = normUrl(h.url);
    const [models, running, act, stats, ver] = await Promise.allSettled([
      this.fetchJson(base, '/v1/models'), this.fetchJson(base, '/running'),
      this.fetchJson(base, '/api/metrics/activity?limit=25'), this.fetchJson(base, '/api/metrics/stats'), this.fetchJson(base, '/api/version'),
    ]);
    if (models.status !== 'fulfilled' && running.status !== 'fulfilled') {
      const msg = String(models.reason?.message || models.reason || 'unreachable');
      throw new Error(/Failed to fetch|NetworkError|Load failed/i.test(msg) ? 'Unreachable (offline, Tailscale down, or CORS blocked)' : msg);
    }
    const stateById = {};
    for (const m of running.value?.running || []) stateById[m.model] = m.state;
    // Aliases/selectors/profiles are routing entries, not loadable models — hide them.
    const list = (models.value?.data || []).filter((m) => m.meta?.llamaswap?.type !== 'alias' && !['selector', 'profile'].includes(m.meta?.llamaswap?.type)).map((m) => ({
      id: m.id, name: m.name || '', description: m.description || '',
      aliases: m.meta?.llamaswap?.aliases || [], state: stateById[m.id] || 'stopped',
    }));
    for (const m of running.value?.running || []) if (!list.find((x) => x.id === m.model)) list.push({ id: m.model, name: '', description: '', aliases: [], state: m.state });
    list.sort((a, b) => (a.name + a.id).localeCompare(b.name + b.id, undefined, { numeric: true }));
    return { online: true, version: ver.value?.version || '', models: list, activity: act.value?.data || [], stats: stats.value || null };
  }

  async pollAll() {
    const { hosts, logsHost } = this.state;
    this.setState({ polling: true });
    const results = await Promise.allSettled(hosts.map((h) => this.pollHost(h)));
    const data = {};
    hosts.forEach((h, i) => {
      const r = results[i];
      data[h.id] = r.status === 'fulfilled' ? r.value : { online: false, error: String(r.reason?.message || r.reason), models: this.state.data[h.id]?.models || [], activity: [], stats: null };
    });
    let logsText = this.state.logsText;
    if (logsHost) {
      const h = hosts.find((x) => x.id === logsHost);
      if (h) logsText = await this.fetchLogs(h);
    }
    this.setState({ data, logsText, updatedAt: Date.now(), polling: false }, () => {
      const el = this.logsRef.current; if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async fetchLogs(h) {
    if (this.props.demoData) return `[llama-swap] ${new Date().toISOString()} sample log output for ${h.name}\nllama_model_loader: loaded meta data\nsrv  log_server_r: request: POST /v1/chat/completions 200`;
    try { const r = await fetch(normUrl(h.url) + '/logs', { cache: 'no-store' }); return stripAnsi(await r.text()).slice(-60000); }
    catch (e) { return 'Could not fetch logs: ' + e.message; }
  }

  async openLogs(h) {
    this.setState({ logsHost: h.id, logsText: '' });
    const logsText = await this.fetchLogs(h);
    this.setState({ logsText }, () => { const el = this.logsRef.current; if (el) el.scrollTop = el.scrollHeight; });
  }

  setPending(key, val) { this.setState((s) => { const p = { ...s.pending }; if (val) p[key] = val; else delete p[key]; return { pending: p }; }); }

  /** Load, unload, or unload-all on a host. Loading works by touching the
      model's /upstream/ URL — llama-swap starts the model on first request. */
  async act(h, modelId, kind) {
    const key = h.id + '|' + (modelId || '*');
    this.setPending(key, kind);
    const base = normUrl(h.url);
    try {
      if (this.props.demoData) await new Promise((r) => setTimeout(r, 900));
      else if (kind === 'load') await fetch(`${base}/upstream/${encodeURIComponent(modelId)}/?_=${Date.now()}`, { cache: 'no-store' });
      else if (kind === 'unload') await fetch(`${base}/api/models/unload/${encodeURIComponent(modelId)}`, { method: 'POST' });
      else await fetch(`${base}/api/models/unload`, { method: 'POST' });
    } catch (e) { console.error(e); }
    this.setPending(key, null);
    this.pollAll();
  }

  // — chat playground —
  openChat(hostId, modelId) {
    const c = this.state.chat;
    this.setState({ chat: { hostId, modelId, messages: c && c.hostId === hostId && c.modelId === modelId ? c.messages : [], input: c?.input || '', streaming: false, error: '' } });
  }
  setChat(patch) { this.setState((s) => ({ chat: s.chat ? { ...s.chat, ...(typeof patch === 'function' ? patch(s.chat) : patch) } : s.chat })); }
  scrollChat() { const el = this.chatRef.current; if (el) el.scrollTop = el.scrollHeight; }

  /** Stream a chat completion from the model, collecting reasoning deltas
      (if the model emits them) and llama.cpp timing info for the meta line. */
  async sendChat() {
    const c = this.state.chat;
    if (!c || c.streaming || !c.input.trim()) return;
    const h = this.state.hosts.find((x) => x.id === c.hostId); if (!h) return;
    const userMsg = { role: 'user', content: c.input.trim() };
    const history = [...c.messages, userMsg];
    this.setChat({ messages: [...history, { role: 'assistant', content: '', reasoning: '' }], input: '', streaming: true, error: '' });
    setTimeout(() => this.scrollChat(), 0);
    const ctrl = new AbortController(); this.chatAbort = ctrl;
    const started = performance.now(); let firstReasoning = 0, reasoningEnd = 0, timings = null;
    // Patch the trailing assistant message in place as tokens stream in.
    const upd = (fn) => this.setChat((s) => { const msgs = s.messages.slice(); const last = { ...msgs[msgs.length - 1] }; fn(last); msgs[msgs.length - 1] = last; return { messages: msgs }; });
    try {
      if (this.props.demoData) {
        const words = 'Sure — this is a sample streamed reply from the demo host. Remove ?demo=1 from the URL to talk to your real models.'.split(' ');
        for (const w of words) { if (ctrl.signal.aborted) break; await new Promise((r) => setTimeout(r, 60)); upd((m) => { m.content += (m.content ? ' ' : '') + w; }); this.scrollChat(); }
        upd((m) => { m.meta = `${words.length} tokens · ${(words.length / ((performance.now() - started) / 1000)).toFixed(1)} tok/s`; });
      } else {
        const r = await fetch(normUrl(h.url) + '/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ model: c.modelId, stream: true, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') continue;
            let j; try { j = JSON.parse(payload); } catch (e) { continue; }
            if (j.timings) timings = j.timings;
            const d = j.choices?.[0]?.delta || {};
            const rc = d.reasoning_content || d.reasoning || '';
            if (rc) { if (!firstReasoning) firstReasoning = performance.now(); upd((m) => { m.reasoning += rc; }); }
            if (d.content) { if (firstReasoning && !reasoningEnd) reasoningEnd = performance.now(); upd((m) => { m.content += d.content; }); }
          }
          this.scrollChat();
        }
        upd((m) => {
          const parts = [];
          if (timings) { if (timings.predicted_n) parts.push(`${timings.predicted_n} tokens`); if (timings.predicted_per_second) parts.push(`${timings.predicted_per_second.toFixed(1)} tok/s`); if (timings.prompt_n) parts.push(`${timings.prompt_n} prompt`); }
          parts.push(`${((performance.now() - started) / 1000).toFixed(1)}s`);
          m.meta = parts.join(' · ');
          if (firstReasoning) m.reasoningTime = `· ${(((reasoningEnd || performance.now()) - firstReasoning) / 1000).toFixed(1)}s`;
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') this.setChat({ error: String(e.message || e) });
    }
    this.chatAbort = null;
    this.setChat({ streaming: false });
    this.scrollChat(); this.pollAll();
  }

  /** Derive everything the template renders — display strings, tag colors,
      and click handlers — from raw state. Keeps render() itself declarative. */
  renderVals() {
    const { hosts, data, pending, filter, hostFilter, loadedOnly, logsHost, logsText, editing, updatedAt, polling } = this.state;
    const colorOf = (i) => HOST_COLORS[i % HOST_COLORS.length];

    const hostCards = hosts.map((h, i) => {
      const d = data[h.id];
      const ready = (d?.models || []).filter((m) => m.state === 'ready').length;
      const loading = !d;
      const online = !!d?.online;
      const busyAll = !!pending[h.id + '|*'];
      return {
        id: h.id, name: h.name, url: normUrl(h.url), versionLabel: d?.version ? '· ' + d.version : '',
        delay: i * 60 + 'ms',
        dotColor: loading ? '#c0b6a5' : online ? colorOf(i) : '#c0b6a5', dotAnim: loading ? 'pulse 1.2s ease-in-out infinite' : 'none',
        statusLabel: loading ? 'connecting' : online ? 'online' : 'offline',
        statusBg: loading ? 'var(--neutral-bg)' : online ? 'var(--ok-bg)' : 'var(--danger-bg)', statusFg: loading ? 'var(--neutral-fg)' : online ? 'var(--ok-fg)' : 'var(--danger-fg)',
        hasError: !!d?.error, error: d?.error || '',
        readyCount: loading ? '–' : ready, totalCount: loading ? '–' : (d?.models || []).length, requestCount: fmtNum(d?.stats?.total_requests),
        unloadAllDisabled: !online || ready === 0 || busyAll,
        onUnloadAll: () => this.act(h, null, 'unloadAll'), onLogs: () => this.openLogs(h), onEdit: () => this.setState({ editing: { ...h } }),
        uiUrl: normUrl(h.url) + '/ui/',
      };
    });

    // Header "herd": one dot per host in its table color — pulsing while a
    // poll is in flight (or before first data), dimmed when the host is offline.
    const herdDots = hosts.map((h, i) => {
      const d = data[h.id];
      return { id: h.id, color: colorOf(i), off: !!d && !d.online, pulse: polling || !d, title: `${h.name} · ${!d ? 'connecting' : d.online ? 'online' : 'offline'}` };
    });

    const q = filter.trim().toLowerCase();
    const rows = [];
    hosts.forEach((h, i) => {
      if (hostFilter !== 'all' && hostFilter !== h.id) return;
      const d = data[h.id]; if (!d) return;
      for (const m of d.models) {
        if (loadedOnly && m.state !== 'ready' && m.state !== 'starting') continue;
        if (q && !(m.id + ' ' + m.name + ' ' + (m.aliases || []).join(' ')).toLowerCase().includes(q)) continue;
        const key = h.id + '|' + m.id;
        const busy = !!pending[key] || !!pending[h.id + '|*'];
        const st = busy ? (pending[key] === 'load' ? 'loading' : 'unloading') : m.state;
        const tone = st === 'ready' ? ['var(--ok-bg)', 'var(--ok-fg)'] : ['starting', 'stopping', 'loading', 'unloading'].includes(st) ? ['var(--warn-bg)', 'var(--warn-fg)'] : ['var(--neutral-bg)', 'var(--neutral-fg)'];
        const isReady = m.state === 'ready';
        const canAct = d.online && !busy && (isReady || m.state === 'stopped');
        const sub = [m.name ? m.id : '', m.description, (m.aliases || []).length ? 'aka ' + m.aliases.join(', ') : ''].filter(Boolean).join(' · ');
        rows.push({
          key, hostName: h.name, hostColor: colorOf(i), name: m.name || m.id, sub, stateLabel: st, tagBg: tone[0], tagFg: tone[1],
          busy: !canAct,
          actionLabel: busy ? (pending[key] === 'load' ? 'Loading…' : 'Unloading…') : isReady ? 'Unload' : 'Load',
          btnBg: isReady ? 'transparent' : 'var(--accent)', btnFg: isReady ? 'var(--text)' : 'var(--on-accent)', btnBorder: isReady ? 'var(--line)' : 'transparent',
          onAction: () => this.act(h, m.id, isReady ? 'unload' : 'load'),
          onChat: () => this.openChat(h.id, m.id), chatOpacity: d.online ? 1 : 0.45,
          upstreamUrl: normUrl(h.url) + '/upstream/' + encodeURIComponent(m.id) + '/', upstreamOpacity: isReady ? 1 : 0.35, upstreamPointer: isReady ? 'auto' : 'none',
        });
      }
    });

    const hostFilters = [{ id: 'all', label: 'All hosts' }, ...hosts.map((h) => ({ id: h.id, label: h.name }))].map((f) => ({
      id: f.id, label: f.label, on: hostFilter === f.id, onSelect: () => this.setState({ hostFilter: f.id }),
    }));

    const activity = [];
    let totalRequests = 0, totalIn = 0, totalOut = 0;
    hosts.forEach((h, i) => {
      const d = data[h.id]; if (!d) return;
      totalRequests += d.stats?.total_requests || 0; totalIn += d.stats?.total_input_tokens || 0; totalOut += d.stats?.total_output_tokens || 0;
      for (const a of d.activity || []) {
        const ok = a.resp_status_code < 400;
        activity.push({
          key: h.id + '|' + a.id, ts: Date.parse(a.timestamp), time: fmtTime(a.timestamp), hostName: h.name, hostColor: colorOf(i), model: a.model,
          path: ok ? a.req_path : `${a.req_path} · ${a.resp_status_code}`, pathColor: ok ? 'var(--text-60)' : 'var(--danger-fg)',
          tokIn: fmtNum(a.tokens?.input_tokens), tokOut: fmtNum(a.tokens?.output_tokens),
          tps: a.tokens?.tokens_per_second > 0 ? a.tokens.tokens_per_second.toFixed(1) : '–', took: a.duration_ms < 1000 ? a.duration_ms + 'ms' : (a.duration_ms / 1000).toFixed(1) + 's',
        });
      }
    });
    activity.sort((a, b) => b.ts - a.ts); activity.length = Math.min(activity.length, 30);

    const anyData = hosts.some((h) => data[h.id]);
    const logsHostObj = hosts.find((h) => h.id === logsHost);

    const { chat } = this.state;
    const chatTargets = [];
    hosts.forEach((h, i) => { for (const m of data[h.id]?.models || []) chatTargets.push({ value: h.id + '|' + m.id, label: `${h.name} · ${m.name || m.id}` }); });
    const chatHostIdx = chat ? hosts.findIndex((x) => x.id === chat.hostId) : -1;
    const chatModel = chat ? (data[chat.hostId]?.models || []).find((m) => m.id === chat.modelId) : null;
    const cs = chatModel?.state || 'unknown';
    const csTone = cs === 'ready' ? ['var(--ok-bg)', 'var(--ok-fg)'] : ['starting', 'stopping'].includes(cs) ? ['var(--warn-bg)', 'var(--warn-fg)'] : ['var(--neutral-bg)', 'var(--neutral-fg)'];
    const chatMessages = (chat?.messages || []).map((m, i, arr) => {
      const user = m.role === 'user';
      const last = i === arr.length - 1;
      return {
        key: i, align: user ? 'flex-end' : 'flex-start', bg: user ? 'var(--accent)' : 'var(--bg)', fg: user ? 'var(--on-accent)' : 'var(--text)',
        content: m.content, showCaret: !user && last && chat.streaming,
        hasReasoning: !!m.reasoning, reasoning: m.reasoning || '', reasoningTime: m.reasoningTime || '',
        hasMeta: !!m.meta, meta: m.meta || '',
      };
    });

    return {
      showChat: !!chat, chatTargets, chatTarget: chat ? chat.hostId + '|' + chat.modelId : '',
      chatHostColor: chatHostIdx >= 0 ? colorOf(chatHostIdx) : '#c0b6a5', chatStateLabel: cs, chatStateBg: csTone[0], chatStateFg: csTone[1],
      chatMessages, chatEmpty: chatMessages.length === 0, chatInput: chat?.input || '', chatHasError: !!chat?.error, chatError: chat?.error || '',
      chatBtnLabel: chat?.streaming ? 'Stop' : 'Send', chatBtnBg: chat?.streaming ? 'transparent' : 'var(--accent)', chatBtnFg: chat?.streaming ? 'var(--text)' : 'var(--on-accent)', chatBtnBorder: chat?.streaming ? 'var(--line)' : 'transparent',
      onChatTarget: (e) => { const [hid, ...rest] = e.target.value.split('|'); this.openChat(hid, rest.join('|')); },
      onChatInput: (e) => this.setChat({ input: e.target.value }),
      onChatKey: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); this.sendChat(); } },
      onChatSend: () => { if (chat?.streaming) this.chatAbort?.abort(); else this.sendChat(); },
      onClearChat: () => { this.chatAbort?.abort(); this.setChat({ messages: [], error: '' }); },
      onCloseChat: () => { this.chatAbort?.abort(); this.setState({ chat: null }); },
      hostCards, rows, hostFilters, activity, herdDots, showActivity: this.props.showActivity,
      rowCountLabel: `${rows.length} across ${hosts.length} host${hosts.length === 1 ? '' : 's'}`,
      showSkeleton: rows.length === 0 && !anyData,
      noRows: rows.length === 0 && anyData, emptyRowsMessage: q || loadedOnly || hostFilter !== 'all' ? 'No models match.' : 'No models reported — are the hosts reachable?',
      noActivity: activity.length === 0, totalRequests: fmtNum(totalRequests), totalIn: fmtNum(totalIn), totalOut: fmtNum(totalOut),
      updatedLabel: updatedAt ? `Updated ${fmtTime(updatedAt)} · every ${this.props.pollSeconds}s` : 'Connecting…',
      refreshIconStyle: polling ? { animation: 'spin 0.9s linear infinite' } : undefined,
      onRefresh: () => this.pollAll(),
      onToggleTheme: () => this.toggleTheme(), themeTitle: this.state.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      filter, onFilter: (e) => this.setState({ filter: e.target.value }),
      loadedOnly, onToggleLoadedOnly: (e) => this.setState({ loadedOnly: e.target.checked }),
      showLogs: !!logsHostObj, logsHostName: logsHostObj?.name || '', logsText: logsText || 'Loading logs…', onCloseLogs: () => this.setState({ logsHost: null, logsText: '' }),
      showEditor: !!editing, editorTitle: editing?.id ? 'Edit host' : 'Add host', editIsExisting: !!editing?.id,
      editName: editing?.name || '', editUrl: editing?.url || '',
      onEditName: (e) => this.setState({ editing: { ...editing, name: e.target.value } }),
      onEditUrl: (e) => this.setState({ editing: { ...editing, url: e.target.value } }),
      onAddHost: () => this.setState({ editing: { name: '', url: '' } }),
      onCancelEdit: () => this.setState({ editing: null }),
      stop: (e) => e.stopPropagation(),
      onSaveHost: () => {
        if (!editing?.url.trim()) return;
        const h = { id: editing.id || 'h' + Date.now().toString(36), name: editing.name.trim() || normUrl(editing.url).replace(/^https?:\/\//, ''), url: normUrl(editing.url) };
        const next = editing.id ? hosts.map((x) => (x.id === h.id ? h : x)) : [...hosts, h];
        this.setState({ editing: null }); this.saveHosts(next);
      },
      onDeleteHost: () => { const next = hosts.filter((x) => x.id !== editing.id); this.setState({ editing: null, hostFilter: 'all' }); this.saveHosts(next); },
    };
  }

  render() {
    const v = this.renderVals();
    const dark = this.state.theme === 'dark';
    return html`
      <div className="wrap">
        <header className="topbar">
          <div className="brand">
            <div className="kicker">llama-swap · all hosts</div>
            <div className="brand-row">
              <h1>Herd</h1>
              <div className="herd-dots">
                ${v.herdDots.map((d) => html`<span key=${d.id} className=${'herd-dot' + (d.off ? ' off' : '') + (d.pulse ? ' pulse' : '')} style=${{ background: d.color }} title=${d.title}></span>`)}
              </div>
            </div>
          </div>
          <div className="top-actions">
            <span className="updated">${v.updatedLabel}</span>
            <button className="icon-btn" onClick=${v.onToggleTheme} title=${v.themeTitle}>${dark ? SunIcon : MoonIcon}</button>
            <button className="icon-btn" onClick=${v.onRefresh} title="Refresh now">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" style=${v.refreshIconStyle}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>
            </button>
            <button className="btn-accent" onClick=${v.onAddHost}>${PlusIcon} Add host</button>
          </div>
        </header>

        <section className="cards">
          ${v.hostCards.map((h) => html`
            <div className="host-card" key=${h.id} style=${{ animationDelay: h.delay }}>
              <div className="host-head">
                <span className="host-dot" style=${{ background: h.dotColor, animation: h.dotAnim }}></span>
                <div className="host-name">${h.name}</div>
                <span className="pill" style=${{ background: h.statusBg, color: h.statusFg }}>${h.statusLabel}</span>
              </div>
              <div className="host-url">${h.url} <span>${h.versionLabel}</span></div>
              ${h.hasError && html`<div className="callout-danger">${h.error}</div>`}
              <div className="stats">
                <div className="stat"><span className="stat-num">${h.readyCount}</span><span className="stat-label">loaded</span></div>
                <div className="stat"><span className="stat-num">${h.totalCount}</span><span className="stat-label">configured</span></div>
                <div className="stat"><span className="stat-num">${h.requestCount}</span><span className="stat-label">requests</span></div>
              </div>
              <div className="host-actions">
                <button className="pill-btn" onClick=${h.onUnloadAll} disabled=${h.unloadAllDisabled}>${PowerIcon} Unload all</button>
                <button className="pill-btn" onClick=${h.onLogs}>Logs</button>
                <a className="link-pill" href=${h.uiUrl} target="_blank" rel="noopener">Open UI ↗</a>
                <button className="edit-btn" onClick=${h.onEdit}>Edit</button>
              </div>
            </div>
          `)}
        </section>

        <section style=${{ marginBottom: '36px' }}>
          <div className="sec-head">
            <h2>Models <span className="sec-count">${v.rowCountLabel}</span></h2>
            <div className="seg">
              ${v.hostFilters.map((f) => html`
                <button className=${'seg-btn' + (f.on ? ' on' : '')} onClick=${f.onSelect} key=${f.id}>${f.label}</button>
              `)}
            </div>
            <label className="check">
              <input type="checkbox" checked=${v.loadedOnly} onChange=${v.onToggleLoadedOnly} />
              Loaded only
            </label>
            <input className="filter-input" value=${v.filter} onChange=${v.onFilter} placeholder="Filter models…" />
          </div>

          <div className="panel">
            <div className="mrow thead"><div>Host</div><div>Model</div><div>State</div><div></div></div>
            ${v.showSkeleton && [0, 1, 2].map((i) => html`
              <div className="mrow rrow sk-row" key=${'sk' + i} style=${{ animationDelay: i * 120 + 'ms' }}>
                <div className="host-cell"><span className="dot8" style=${{ background: 'var(--hover)' }}></span><div className="sk-bar" style=${{ width: '70px' }}></div></div>
                <div style=${{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  <div className="sk-bar" style=${{ width: '150px' }}></div>
                  <div className="sk-bar" style=${{ width: '95px', height: '8px' }}></div>
                </div>
                <div><div className="sk-bar" style=${{ width: '62px', height: '20px' }}></div></div>
                <div className="row-actions"><div className="sk-bar" style=${{ width: '96px', height: '30px' }}></div></div>
              </div>
            `)}
            ${v.noRows && html`<div className="empty">${v.emptyRowsMessage}</div>`}
            ${v.rows.map((r) => html`
              <div className="mrow rrow" key=${r.key}>
                <div className="host-cell"><span className="dot8" style=${{ background: r.hostColor }}></span><span className="ellip">${r.hostName}</span></div>
                <div style=${{ minWidth: 0 }}>
                  <div className="mname ellip">${r.name}</div>
                  <div className="msub ellip">${r.sub}</div>
                </div>
                <div><span className="pill" style=${{ background: r.tagBg, color: r.tagFg }}>${r.stateLabel}</span></div>
                <div className="row-actions">
                  <a className="link-pill" href=${r.upstreamUrl} target="_blank" rel="noopener" title="Open upstream server" style=${{ opacity: r.upstreamOpacity, pointerEvents: r.upstreamPointer }}>Upstream ↗</a>
                  <button className="link-pill" onClick=${r.onChat} title="Chat with this model" style=${{ opacity: r.chatOpacity }}>Chat</button>
                  <button className="act-btn" onClick=${r.onAction} disabled=${r.busy} style=${{ background: r.btnBg, color: r.btnFg, borderColor: r.btnBorder }}>${r.actionLabel}</button>
                </div>
              </div>
            `)}
          </div>
        </section>

        ${v.showActivity && html`
          <section style=${{ marginBottom: '36px' }}>
            <div className="sec-head baseline">
              <h2>Recent requests</h2>
              <div className="totals">
                <span><strong>${v.totalRequests}</strong> requests</span>
                <span><strong>${v.totalIn}</strong> in</span>
                <span><strong>${v.totalOut}</strong> out</span>
              </div>
            </div>
            <div className="panel">
              <div className="arow thead">
                <div>Time</div><div>Host</div><div>Model</div><div>Path</div>
                <div className="num">In</div><div className="num">Out</div><div className="num">Tok/s</div><div className="num">Took</div>
              </div>
              ${v.noActivity && html`<div className="empty">No requests recorded yet.</div>`}
              ${v.activity.map((a) => html`
                <div className="arow rrow" key=${a.key}>
                  <div className="dim">${a.time}</div>
                  <div className="host-cell"><span className="dot8" style=${{ background: a.hostColor }}></span><span className="ellip">${a.hostName}</span></div>
                  <div className="ellip" style=${{ fontWeight: 600 }}>${a.model}</div>
                  <div className="ellip" style=${{ color: a.pathColor }}>${a.path}</div>
                  <div className="num">${a.tokIn}</div>
                  <div className="num">${a.tokOut}</div>
                  <div className="num">${a.tps}</div>
                  <div className="num">${a.took}</div>
                </div>
              `)}
            </div>
          </section>
        `}

        ${v.showLogs && html`
          <div className="logs-drawer">
            <div className="logs-head">
              <span className="logs-title">${v.logsHostName}</span>
              <span className="logs-sub">logs · refreshes with each poll</span>
              <button className="logs-close" onClick=${v.onCloseLogs}>×</button>
            </div>
            <pre className="logs-body" ref=${this.logsRef}>${v.logsText}</pre>
          </div>
        `}

        ${v.showChat && html`
          <div className="chat-panel">
            <div className="chat-head">
              <div className="chat-title-row">
                <span className="chat-title">Playground</span>
                <button className="chat-clear" onClick=${v.onClearChat}>Clear</button>
                <button className="chat-close" onClick=${v.onCloseChat}>×</button>
              </div>
              <div className="chat-target-row">
                <span className="dot10" style=${{ background: v.chatHostColor }}></span>
                <select className="chat-select" value=${v.chatTarget} onChange=${v.onChatTarget}>
                  ${v.chatTargets.map((t) => html`<option value=${t.value} key=${t.value}>${t.label}</option>`)}
                </select>
                <span className="pill" style=${{ background: v.chatStateBg, color: v.chatStateFg }}>${v.chatStateLabel}</span>
              </div>
            </div>
            <div className="chat-msgs" ref=${this.chatRef}>
              ${v.chatEmpty && html`<div className="chat-hint">Send a message. A stopped model loads on first request, so the first reply can take a while.</div>`}
              ${v.chatMessages.map((m) => html`
                <div className="msg" style=${{ alignSelf: m.align }} key=${m.key}>
                  ${m.hasReasoning && html`
                    <details className="reasoning">
                      <summary>Thinking ${m.reasoningTime}</summary>
                      <div>${m.reasoning}</div>
                    </details>
                  `}
                  <div className="bubble" style=${{ background: m.bg, color: m.fg }}>${m.content}${m.showCaret && html`<span className="caret"></span>`}</div>
                  ${m.hasMeta && html`<div className="msg-meta">${m.meta}</div>`}
                </div>
              `)}
              ${v.chatHasError && html`<div className="chat-error">${v.chatError}</div>`}
            </div>
            <div className="chat-foot">
              <textarea className="chat-input" value=${v.chatInput} onChange=${v.onChatInput} onKeyDown=${v.onChatKey} placeholder="Message… (Enter to send, Shift+Enter for a new line)" rows="2"></textarea>
              <button className="send-btn" onClick=${v.onChatSend} style=${{ background: v.chatBtnBg, color: v.chatBtnFg, borderColor: v.chatBtnBorder }}>${v.chatBtnLabel}</button>
            </div>
          </div>
        `}

        ${v.showEditor && html`
          <div className="modal-backdrop" onClick=${v.onCancelEdit}>
            <div className="modal" onClick=${v.stop}>
              <div className="modal-title">${v.editorTitle}</div>
              <label>Name
                <input value=${v.editName} onChange=${v.onEditName} placeholder="Mac Studio" />
              </label>
              <label>llama-swap URL
                <input value=${v.editUrl} onChange=${v.onEditUrl} placeholder="http://host.tailnet.ts.net:8999" />
              </label>
              <div className="modal-foot">
                ${v.editIsExisting && html`<button className="danger-ghost" onClick=${v.onDeleteHost}>Remove</button>`}
                <div className="spacer">
                  <button className="pill-btn" onClick=${v.onCancelEdit}>Cancel</button>
                  <button className="save-btn" onClick=${v.onSaveHost}>Save</button>
                </div>
              </div>
            </div>
          </div>
        `}
      </div>
    `;
  }
}

// URL options: ?demo=1 uses canned data, ?poll=N sets the poll interval (2–30s),
// ?activity=0 hides the Recent requests section.
const params = new URLSearchParams(location.search);
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, {
  demoData: params.get('demo') === '1',
  pollSeconds: Math.min(30, Math.max(2, Number(params.get('poll')) || 5)),
  showActivity: params.get('activity') !== '0',
}));
