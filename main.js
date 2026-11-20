const { ItemView, Plugin, PluginSettingTab, Notice, parseYaml, normalizePath } = require('obsidian');

const VIEW = 'skill-insight-view';
const LEGACY_ROOT = '4-运转中心/技能治理/';
const DEFAULT_ROOT = 'Skill Insight/';
const LEGACY_HISTORY = '.system/skill-history/';
const DEFAULT_SOURCES = ['.agents/skills', '.claude/skills', '.codex/skills'];
const DAY = 86400000;
const TRANSCRIPT_AGENTS = [['codex', 'Codex'], ['claude', 'Claude Code']];
const SKILL_PATH_RE = /skills[/\\]([^/\\]+)[/\\]SKILL\.md/giu;
const INGEST_VERSION = 6; // 口径升级时清空旧自动记录重采（v6：命令多技能路径读取各计 1 次，不再视为批量丢弃）

// Claudian 后端 providerId → 采集 agent 归一化
function claudianProvider(value) {
  const p = String(value || '').toLowerCase();
  if (p.startsWith('codex')) return 'codex';
  if (p.startsWith('claude') || p.startsWith('anthropic')) return 'claude';
  return null; // TODO: grok / opencode / pi 等后端接入位
}

// codex：读转录文件首行 session_meta 的 cwd（用于判定「本 vault 发起」）
async function sessionMetaCwd(fs, file) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const newline = text.indexOf('\n');
      const first = newline > 0 ? text.slice(0, newline) : text;
      const obj = JSON.parse(first);
      return (obj && obj.payload && obj.payload.cwd) || '';
    } finally { await handle.close(); }
  } catch { return ''; }
}

// claude：项目目录名是 vault 路径的编码形式（非字母数字 → '-'）
function claudeProjectToken(vaultBase) {
  return String(vaultBase).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
}

function defaultTranscriptRoot(agent) {
  const path = require('node:path');
  const home = require('node:os').homedir();
  return agent === 'claude' ? path.join(home, '.claude', 'projects') : path.join(home, '.codex', 'sessions');
}

function normalizeSkillHint(value) {
  let name = String(value || '').trim();
  if (name.startsWith('/')) name = name.slice(1);
  const space = name.search(/\s/u);
  if (space > 0) name = name.slice(0, space);
  return name;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function findSkillToolCalls(value, out = []) {
  if (Array.isArray(value)) for (const item of value) findSkillToolCalls(item, out);
  else if (value && typeof value === 'object') {
    if (value.type === 'tool_use' && typeof value.name === 'string' && value.name.toLowerCase() === 'skill') {
      const input = value.input || {};
      const hint = input.skill || input.skill_id || input.name || input.command || '';
      if (hint) out.push(hint);
    }
    for (const item of Object.values(value)) findSkillToolCalls(item, out);
  }
  return out;
}

async function walkJsonl(fs, path, root, depth = 0) {
  if (depth > 5) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkJsonl(fs, path, full, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
  }
  return files;
}

function latestRevision(store, skillId) {
  const changes = store.changes.filter(item => item.skill_id === skillId && /^r[1-9]\d*$/u.test(String(item.revision)));
  changes.sort((a, b) => Number(String(b.revision).slice(1)) - Number(String(a.revision).slice(1)));
  return changes.length ? String(changes[0].revision) : 'r0';
}

function toolUseCommandTexts(value, out = []) {
  if (Array.isArray(value)) for (const item of value) toolUseCommandTexts(item, out);
  else if (value && typeof value === 'object') {
    if (value.type === 'tool_use' && value.input !== undefined) {
      out.push(typeof value.input === 'string' ? value.input : collectStrings(value.input).join('\n'));
    }
    for (const item of Object.values(value)) toolUseCommandTexts(item, out);
  }
  return out;
}

// 只取「命令本体」文本：codex custom_tool_call 输入、CommandExecution 命令数组、claude tool_use 输入。
// 不含命令输出与聊天正文——目录清单、文档链接、读文件内容里的路径提及由此天然排除。
function commandTextsOf(line, out = []) {
  const p = line.payload;
  if (p) {
    if (p.type === 'custom_tool_call' && p.input !== undefined) {
      out.push(typeof p.input === 'string' ? p.input : collectStrings(p.input).join('\n'));
    }
    if (p.type === 'item_completed' && p.item && p.item.type === 'CommandExecution') {
      const cmd = p.item.command;
      if (Array.isArray(cmd)) out.push(cmd.join(' '));
      else if (typeof cmd === 'string') out.push(cmd);
    }
  }
  return toolUseCommandTexts(line, out);
}

function vaultSource(value) {
  const source = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!source || source.split('/').some(part => part === '..' || part === '.')) return null;
  return normalizePath(source);
}

function yamlString(value) { return JSON.stringify(String(value)); }

function safeSkillId(value) {
  const name = String(value || '').trim();
  return name && !/[\\/<>:"|?*\x00-\x1f]/u.test(name) && name !== '.' && name !== '..' ? name : null;
}

function el(parent, tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined && content !== null) node.textContent = String(content);
  parent.appendChild(node);
  return node;
}

function svgEl(parent, tag, attrs, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = String(content);
  parent.appendChild(node);
  return node;
}

function localDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shortDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  return `${localDay(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function inRange(event, range) {
  if (range === 'all') return true;
  const date = new Date(event.time);
  const days = range === '7d' ? 7 : 30;
  return !Number.isNaN(date.getTime()) && date.getTime() >= Date.now() - days * DAY;
}

function countsBy(items, key) {
  const result = new Map();
  for (const item of items) {
    const value = key(item);
    result.set(value, (result.get(value) || 0) + 1);
  }
  return result;
}

function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const grid = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      grid[i][j] = a[i] === b[j] ? grid[i + 1][j + 1] + 1 : Math.max(grid[i + 1][j], grid[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push([' ', a[i]]); i++; j++;
    } else if (j < b.length && (i === a.length || grid[i][j + 1] >= grid[i + 1][j])) {
      result.push(['+', b[j++]]);
    } else {
      result.push(['-', a[i++]]);
    }
  }
  return result;
}

class SkillInsightView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.range = '30d';
    this.query = '';
    this.selected = '';
    this.tab = 'overview';
    this.chartMode = 'bar';
    this.data = { cards: [], uses: [], changes: [] };
    this.candidates = [];
    this.discoveryMessage = '';
    this.collectMessage = '';
    this.filter = { skill: '', day: '' }; // 下钻筛选：点排行/热力图/技能 chip 生效
    this.sessionQuery = '';
    this.pending = new Map(); // 未登记变更草稿：refresh 时自动检测，纯内存不落库
  }

  getViewType() { return VIEW; }
  getDisplayText() { return 'Skill 洞察'; }
  getIcon() { return 'activity'; }

  async onOpen() {
    if (this.plugin.initPromise) await this.plugin.initPromise; // 等待全自动初始化完成
    const fresh = await this.plugin.autoInitialize(); // 幂等重扫：运行期间新装的技能打开看板即建卡，不必等重启
    await this.refresh();
    if (!this.data.cards.length) { await this.scanSources(); return; }
    if (fresh) this.plugin.pendingRescan = true; // 有新建卡：回扫历史转录，补计未建卡期间的用量
    await this.autoCollect(false);
  }

  async autoCollect(verbose) {
    try {
      const result = await this.plugin.collectTranscripts();
      this.collectMessage = `本次采集：新增 ${result.added} 条使用记录。${result.reports.join(' ')}`.trim();
      if (verbose) new Notice(result.added ? `转录采集完成：新增 ${result.added} 条` : '转录采集完成：无新增');
      if (result.added) await this.refresh();
      else this.render();
    } catch (error) {
      this.collectMessage = `转录采集失败：${error.message}`;
      if (verbose) new Notice(this.collectMessage);
      else this.render();
    }
  }

  async refresh() {
    if (this.plugin.refreshStore) await this.plugin.refreshStore();
    const state = this.plugin.store || { cards: [], uses: [], changes: [] };
    const data = { cards: [...state.cards], uses: [...state.uses], changes: [...state.changes] };
    data.cards.sort((a, b) => String(a.skill_id).localeCompare(String(b.skill_id), 'zh-CN'));
    data.uses.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    data.changes.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    this.data = data;
    try { this.pending = await this.plugin.detectPendingChanges(); } catch { this.pending = new Map(); }
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('skill-insight-root');
    this.renderHeader(root);
    if (!this.data.cards.length || this.tab === 'sources') this.renderDiscovery(root);
    else {
      if (this.tab === 'overview') this.renderOverview(root);
      if (this.tab === 'skills') this.renderSkills(root);
      if (this.tab === 'sessions') this.renderSessions(root);
      if (this.tab === 'changes') this.renderChanges(root);
    }
    this.renderFooter(root);
  }

  renderHeader(root) {
    const header = el(root, 'div', 'skill-insight-header');
    const title = el(header, 'div', 'skill-insight-title');
    el(title, 'div', 'skill-insight-eyebrow', 'SKILL INSIGHT · 本地洞察');
    el(title, 'h1', '', '技能持续优化看板');
    el(title, 'p', '', '看实际调用、版本演进和待优化信号，不用文件修改时间冒充使用量。');
    const controls = el(header, 'div', 'skill-insight-controls');
    for (const [value, label] of [['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部记录']]) {
      const button = el(controls, 'button', `skill-insight-pill ${this.range === value ? 'is-active' : ''}`, label);
      button.addEventListener('click', () => { this.range = value; this.render(); });
    }
    el(controls, 'span', 'skill-insight-divider');
    const collect = el(controls, 'button', 'skill-insight-pill is-action', '⚡ 采集转录');
    collect.title = '动作：扫描会话转录，自动补记技能调用（区别于左侧时间筛选）';
    collect.addEventListener('click', () => this.autoCollect(true));
    const refresh = el(controls, 'button', 'skill-insight-icon-button', '↻');
    refresh.title = '刷新记录';
    refresh.addEventListener('click', () => this.refresh());
    const tabs = el(root, 'div', 'skill-insight-tabs');
    const availableTabs = this.data.cards.length
      ? [['overview', '总览'], ['skills', '技能明细'], ['sessions', '会话'], ['changes', '迭代时间线'], ['sources', '来源与采集']]
      : [['sources', '来源与采集']];
    for (const [value, label] of availableTabs) {
      const button = el(tabs, 'button', (this.tab === value || !this.data.cards.length) ? 'is-active' : '', label);
      button.addEventListener('click', async () => {
        this.tab = value;
        if (value === 'sources' && !this.candidates.length) await this.scanSources();
        else this.render();
      });
    }
    if (this.filter.skill || this.filter.day) {
      const filters = el(root, 'div', 'skill-insight-filters');
      el(filters, 'span', 'skill-insight-muted', '筛选：');
      if (this.filter.skill) {
        const pill = el(filters, 'button', 'skill-insight-pill is-active', `技能 · ${this.filter.skill} ✕`);
        pill.addEventListener('click', () => { this.filter.skill = ''; this.render(); });
      }
      if (this.filter.day) {
        const pill = el(filters, 'button', 'skill-insight-pill is-active', `日期 · ${this.filter.day} ✕`);
        pill.addEventListener('click', () => { this.filter.day = ''; this.render(); });
      }
      const clear = el(filters, 'button', 'skill-insight-muted skill-insight-clear', '清除全部');
      clear.addEventListener('click', () => { this.filter = { skill: '', day: '' }; this.render(); });
    }
  }

  async scanSources() {
    try {
      this.candidates = await this.plugin.discoverSkills();
      const warning = this.plugin.scanWarnings?.length ? ` ${this.plugin.scanWarnings.length} 个来源读取异常，请检查路径或权限。` : '';
      const fresh = this.candidates.filter(item => !this.data.cards.some(card => card.skill_id === item.skill_id)).length;
      this.discoveryMessage = `发现 ${this.candidates.length} 个技能位置，其中 ${fresh} 个尚未建卡。新装技能由插件启动时自动建卡；本页仅用于维护来源目录与采集设置。${warning}`;
    } catch (error) {
      this.discoveryMessage = `扫描失败：${error.message}`;
    }
    this.render();
  }

  renderDiscovery(root) {
    const box = el(root, 'section', 'skill-insight-panel skill-insight-discovery');
    el(box, 'h2', '', this.data.cards.length ? '发现与初始化新技能' : '首次使用：发现你的技能');
    el(box, 'p', 'skill-insight-muted', '默认仅扫描当前 Vault 的常见技能目录；外部目录必须由你手动添加。扫描不会修改技能。');
    const label = el(box, 'label', 'skill-insight-discovery-label', '技能父目录（每行一个；支持 Vault 相对路径或本机绝对路径）');
    const input = el(label, 'textarea', 'skill-insight-discovery-input');
    input.value = (this.plugin.settings?.sources || DEFAULT_SOURCES).join('\n');
    const actions = el(box, 'div', 'skill-insight-discovery-actions');
    const scan = el(actions, 'button', 'skill-insight-pill', '保存来源并扫描');
    scan.addEventListener('click', async () => {
      try {
        const sources = [...new Set(input.value.split(/\r?\n/u).map(value => value.trim()).filter(Boolean))];
        await this.plugin.setSources(sources);
        await this.scanSources();
      } catch (error) {
        this.discoveryMessage = `保存失败：${error.message}`;
        this.render();
      }
    });
    el(box, 'p', 'skill-insight-muted', this.discoveryMessage || '点击扫描查看当前来源下的技能。');
    if (!this.candidates.length) return;
    const existing = new Set(this.data.cards.map(card => card.skill_id));
    const candidates = el(box, 'div', 'skill-insight-discovery-list');
    for (const item of this.candidates) {
      const row = el(candidates, 'div', 'skill-insight-discovery-row');
      const info = el(row, 'span', '');
      el(info, 'strong', '', item.skill_id);
      el(info, 'small', '', item.source_path);
      el(row, 'em', '', existing.has(item.skill_id) ? '已建卡' : '待自动建卡（下次启动）');
    }
    el(box, 'p', 'skill-insight-warning', '启动时自动把技能卡和 r0 内容快照写入插件私有 data.json（不写入 vault）；历史使用与迭代保持未知，不会伪造为 0 次。');
    this.renderTranscriptSettings(root);
  }

  renderTranscriptSettings(root) {
    const box = el(root, 'section', 'skill-insight-panel skill-insight-transcript');
    el(box, 'h2', '', '会话转录自动采集');
    el(box, 'p', 'skill-insight-muted', '打开看板时自动读取 Claudian 会话注册表（.claudian/sessions），精准解析本 vault 发起的 agent 会话转录（jsonl）补记使用。显式 Skill 工具调用逐次计数；无显式事件的后端只认「单技能定向读取 SKILL.md」类命令信号，按会话去重计 1 次。批量读取、目录清单、补丁写操作、文档引用不计。首次安装只回扫近 7 天历史，之后按字节偏移增量采集。来源标记为「转录自动」，结果留待显式记账补全；不存储聊天正文。');
    const inputs = {};
    for (const [agent, label] of TRANSCRIPT_AGENTS) {
      const config = this.plugin.settings.transcripts?.[agent] || { globalScan: false, root: '' };
      const row = el(box, 'div', 'skill-insight-transcript-row');
      const toggle = el(row, 'label', '');
      const check = el(toggle, 'input', '');
      check.type = 'checkbox';
      check.checked = config.globalScan;
      el(toggle, 'span', '', `${label} 全局兜底`);
      const input = el(row, 'input', 'skill-insight-search');
      input.type = 'text';
      input.placeholder = `全局转录根目录（默认 ${defaultTranscriptRoot(agent)}）`;
      input.value = config.root;
      inputs[agent] = { check, input };
    }
    const actions = el(box, 'div', 'skill-insight-discovery-actions');
    const save = el(actions, 'button', 'skill-insight-pill', '保存采集设置');
    save.addEventListener('click', async () => {
      try {
        for (const [agent, pair] of Object.entries(inputs)) {
          await this.plugin.setTranscriptConfig(agent, { globalScan: pair.check.checked, root: pair.input.value });
        }
        this.collectMessage = '采集设置已保存；下次打开看板或点击「立即采集」生效。';
        this.render();
      } catch (error) {
        this.collectMessage = `保存采集设置失败：${error.message}`;
        this.render();
      }
    });
    const collect = el(actions, 'button', 'skill-insight-pill is-active', '立即采集');
    collect.addEventListener('click', () => this.autoCollect(true));
    if (this.collectMessage) el(box, 'p', 'skill-insight-muted', this.collectMessage);
  }

  filtered() {
    const ok = item => (!this.filter.skill || item.skill_id === this.filter.skill)
      && (!this.filter.day || localDay(item.time) === this.filter.day)
      && inRange(item, this.range);
    return {
      uses: this.data.uses.filter(ok),
      changes: this.data.changes.filter(ok),
    };
  }

  currentRevision(skill) {
    const changes = this.data.changes.filter(item => item.skill_id === skill);
    return changes.length ? String(changes[0].revision || `r${changes.length}`) : 'r0';
  }

  renderOverview(root) {
    const { uses, changes } = this.filtered();
    if (this.pending.size) {
      // 未登记变更提示条：自动检测的 SKILL.md 变更，引导到技能明细确认登记
      const strip = el(root, 'div', 'skill-insight-pending-strip');
      el(strip, 'span', '', `⚠ ${this.pending.size} 个技能存在未登记变更：${[...this.pending.keys()].join('、')}`);
      const go = el(strip, 'button', '', '去处理');
      go.addEventListener('click', () => { this.tab = 'skills'; this.selected = [...this.pending.keys()][0]; this.render(); });
    }
    const used = new Set(uses.map(item => item.skill_id));
    const revise = this.data.cards.filter(item => item.maintenance === '优先修订').length;
    const kpis = el(root, 'div', 'skill-insight-kpis');
    for (const [label, value, hint, alert] of [
      ['技能总数', this.data.cards.length, '来自技能卡'],
      ['已记录使用', uses.length, '显式记账 + 转录自动'],
      ['活跃技能', used.size, '所选时间范围'],
      ['版本快照', this.data.cards.length + this.data.changes.length, 'r0 基线 + 后续修订'],
      ['已登记迭代', changes.length, '不含 r0 基线'],
      ['待优先修订', revise, '静态审计标记', revise > 0],
    ]) {
      const box = el(kpis, 'div', `skill-insight-kpi${alert ? ' is-alert' : ''}`);
      el(box, 'span', 'skill-insight-kpi-label', label);
      el(box, 'strong', '', value);
      el(box, 'small', '', hint);
    }
    const hero = el(root, 'div', 'skill-insight-hero');
    this.renderTrend(hero, uses, changes);
    this.renderInsights(hero, uses, changes);
    const compositions = el(root, 'div', 'skill-insight-compositions');
    const categoryColors = ['#517ee9', '#45baae', '#e88946', '#9c6be1', '#e35b9a'];
    const skillUsage = [...countsBy(uses, item => item.skill_id).entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-CN'));
    const skillParts = skillUsage.slice(0, 5).map(([label, count], index) =>
      ({ label, count, color: categoryColors[index % categoryColors.length] }));
    const othersCount = skillUsage.slice(5).reduce((sum, [, count]) => sum + count, 0);
    if (othersCount > 0) skillParts.push({ label: `其他 ${skillUsage.length - 5} 个技能`, count: othersCount, color: '#8b8f9f' });
    this.renderDonut(compositions, '技能使用构成', skillParts, uses.length, '次已记录调用');
    const resultColors = { '完成': '#45baae', '部分完成': '#e8a348', '失败': '#dc6262', '中止': '#8b8f9f' };
    const resultCounts = countsBy(uses, item => item.result || '未标结果');
    this.renderDonut(compositions, '使用结果构成', [...resultCounts].map(([label, count]) =>
      ({ label, count, color: resultColors[label] || '#9c6be1' })), uses.length, '次已记录结果');
    this.renderActivityRanking(compositions, uses);
    this.renderRecent(root, uses, changes);
  }

  renderDonut(parent, title, parts, total, unit) {
    const box = el(parent, 'section', 'skill-insight-panel skill-insight-donut-panel');
    el(box, 'h2', '', title);
    const layout = el(box, 'div', 'skill-insight-donut-layout');
    const ring = el(layout, 'div', 'skill-insight-donut');
    if (total > 0) {
      let offset = 0;
      const sections = [];
      for (const part of parts) {
        const end = offset + part.count / total * 100;
        sections.push(`${part.color} ${offset}% ${end}%`);
        offset = end;
      }
      ring.style.background = `conic-gradient(${sections.join(', ')})`;
    }
    const center = el(ring, 'div', 'skill-insight-donut-center');
    el(center, 'strong', '', total);
    el(center, 'small', '', unit);
    const legend = el(layout, 'div', 'skill-insight-donut-legend');
    if (!parts.length) el(legend, 'p', 'skill-insight-muted', '暂无已记账数据');
    for (const part of parts) {
      const row = el(legend, 'div', 'skill-insight-donut-item');
      const name = el(row, 'span', '', `● ${part.label}`);
      name.style.color = part.color;
      el(row, 'strong', '', `${part.count} · ${(part.count / total * 100).toFixed(0)}%`);
    }
  }

  renderTrend(parent, uses, changes) {
    const box = el(parent, 'section', 'skill-insight-panel skill-insight-grow');
    const head = el(box, 'div', 'skill-insight-chart-head');
    el(head, 'h2', '', '使用与迭代趋势');
    const modes = el(head, 'div', 'skill-insight-chart-modes');
    for (const [mode, label] of [['bar', '柱状图'], ['line', '折线图']]) {
      const button = el(modes, 'button', `skill-insight-pill ${this.chartMode === mode ? 'is-active' : ''}`, label);
      button.addEventListener('click', () => { this.chartMode = mode; this.render(); });
    }
    const days = this.range === '7d' ? 7 : 30;
    const usage = countsBy(uses, item => localDay(item.time));
    const updates = countsBy(changes, item => localDay(item.time));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - i);
      const key = localDay(date);
      series.push({ day: key, uses: usage.get(key) || 0, changes: updates.get(key) || 0 });
    }
    const max = Math.max(1, ...series.flatMap(item => [item.uses, item.changes]));
    const chart = el(box, 'div', 'skill-insight-chart');
    const svg = svgEl(chart, 'svg', { viewBox: '0 0 640 180', role: 'img', 'aria-label': `近 ${days} 天使用与迭代${this.chartMode === 'line' ? '折线' : '柱状'}图` });
    const left = 34, right = 625, top = 12, bottom = 142;
    const x = index => left + (right - left) * index / Math.max(1, series.length - 1);
    const y = value => bottom - value / max * (bottom - top);
    for (const value of [0, max]) {
      svgEl(svg, 'line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'skill-insight-chart-gridline' });
      svgEl(svg, 'text', { x: 25, y: y(value) + 4, 'text-anchor': 'end', class: 'skill-insight-chart-axis' }, value);
    }
    if (this.chartMode === 'line') {
      const defs = svgEl(svg, 'defs', {});
      const gradient = svgEl(defs, 'linearGradient', { id: 'si-area-gradient', x1: 0, y1: 0, x2: 0, y2: 1 });
      const stopTop = svgEl(gradient, 'stop', { offset: '0%' });
      stopTop.style.stopColor = 'var(--si-accent)';
      stopTop.style.stopOpacity = '0.24';
      const stopBottom = svgEl(gradient, 'stop', { offset: '100%' });
      stopBottom.style.stopColor = 'var(--si-accent)';
      stopBottom.style.stopOpacity = '0';
      const usePoints = series.map((item, index) => `${x(index)},${y(item.uses)}`).join(' ');
      svgEl(svg, 'polygon', { points: `${usePoints} ${right},${bottom} ${left},${bottom}`, class: 'skill-insight-chart-area' });
      for (const [field, cls] of [['uses', 'use'], ['changes', 'change']]) {
        const points = series.map((item, index) => `${x(index)},${y(item[field])}`).join(' ');
        svgEl(svg, 'polyline', { points, class: `skill-insight-chart-line ${cls}` });
        series.forEach((item, index) => {
          if (!item[field]) return;
          const dot = svgEl(svg, 'circle', { cx: x(index), cy: y(item[field]), r: 4, class: `skill-insight-chart-dot ${cls}` });
          svgEl(dot, 'title', {}, `${item.day} · ${field === 'uses' ? '使用' : '迭代'} ${item[field]}`);
        });
      }
    } else {
      const width = Math.min(10, (right - left) / series.length * 0.34);
      series.forEach((item, index) => {
        for (const [field, cls, offset] of [['uses', 'use', -width], ['changes', 'change', 0]]) {
          if (!item[field]) continue;
          const bar = svgEl(svg, 'rect', { x: x(index) + offset, y: y(item[field]), width, height: bottom - y(item[field]), rx: 2, class: `skill-insight-chart-bar ${cls}` });
          svgEl(bar, 'title', {}, `${item.day} · ${field === 'uses' ? '使用' : '迭代'} ${item[field]}`);
        }
      });
    }
    series.forEach((item, index) => {
      if (index !== 0 && index !== series.length - 1 && (days !== 7 && (index % 7 !== 0 || index >= series.length - 3))) return;
      svgEl(svg, 'text', { x: x(index), y: 166, 'text-anchor': index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle', class: 'skill-insight-chart-axis' }, item.day.slice(5));
    });
    const legend = el(box, 'div', 'skill-insight-legend');
    el(legend, 'span', 'use', '● 使用');
    el(legend, 'span', 'change', '● 迭代');
    el(legend, 'small', '', this.range === 'all' ? '图表仅显示近 30 天；指标为全部记录' : '按事件发生日期统计');
  }

  renderActivityRanking(parent, uses) {
    const heat = el(parent, 'section', 'skill-insight-panel skill-insight-activity-panel');
    el(heat, 'h2', '', '近 8 周活动');
    const all = countsBy(this.data.uses, item => localDay(item.time));
    const map = el(heat, 'div', 'skill-insight-heatmap');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const offset = (today.getDay() + 6) % 7; // 周一为一周起点
    const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + (6 - offset)); // 本周日
    for (let w = 7; w >= 0; w--) {
      const column = el(map, 'div', 'skill-insight-heatmap-week');
      for (let d = 0; d < 7; d++) {
        const date = new Date(weekEnd); date.setDate(weekEnd.getDate() - w * 7 - d);
        const key = localDay(date);
        const count = all.get(key) || 0;
        const cell = el(column, 'button', `skill-insight-heat ${count === 0 ? 'level-0' : count < 3 ? 'level-1' : count < 6 ? 'level-2' : 'level-3'}${this.filter.day === key ? ' is-picked' : ''}`);
        cell.title = `${key} · ${count} 次已记录使用${count ? '（点击筛选该天）' : ''}`;
        if (date > today) { cell.disabled = true; cell.classList.add('is-future'); }
        else cell.addEventListener('click', () => { this.filter.day = this.filter.day === key ? '' : key; this.render(); });
      }
    }
    el(heat, 'p', 'skill-insight-muted skill-insight-heat-note', `所选范围有 ${uses.length} 次记录；历史未记账不等于未使用。`);
    this.renderRanking(parent, uses);
  }

  renderRanking(parent, uses) {
    const box = el(parent, 'section', 'skill-insight-panel');
    el(box, 'h2', '', '已记录使用排行');
    const counts = countsBy(uses, item => item.skill_id);
    const ranked = this.data.cards.map(card => ({ card, count: counts.get(card.skill_id) || 0 }))
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count || String(a.card.skill_id).localeCompare(String(b.card.skill_id), 'zh-CN'))
      .slice(0, 10);
    if (!ranked.length) { el(box, 'p', 'skill-insight-muted', '所选时间范围内暂无已记录的技能使用。'); return; }
    const max = Math.max(1, ...ranked.map(item => item.count));
    for (const item of ranked) {
      const line = el(box, 'div', 'skill-insight-rank');
      line.setAttribute('role', 'button');
      line.tabIndex = 0;
      el(line, 'span', 'skill-insight-rank-name', item.card.skill_id);
      const track = el(line, 'span', 'skill-insight-rank-track');
      const fill = el(track, 'span', 'skill-insight-rank-fill');
      fill.style.width = `${item.count / max * 100}%`;
      el(line, 'strong', '', item.count);
      line.addEventListener('click', () => { this.filter.skill = item.card.skill_id; this.render(); });
      line.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.filter.skill = item.card.skill_id;
          this.render();
        }
      });
    }
    const unrecorded = this.data.cards.filter(card => !counts.get(card.skill_id)).length;
    const periodLabel = this.range === 'all' ? '暂无' : '本期未记录';
    if (unrecorded > 0) el(box, 'p', 'skill-insight-muted skill-insight-rank-footnote', `其余 ${unrecorded} 个技能${periodLabel}使用，不参与排行。`);
  }

  renderInsights(parent, uses, changes) {
    const box = el(parent, 'section', 'skill-insight-panel skill-insight-heat-panel');
    el(box, 'h2', '', '持续优化信号');
    const usage = countsBy(uses, item => item.skill_id);
    const failures = uses.filter(item => item.result === '失败' || item.result === '部分完成');
    const issueCounts = countsBy(failures, item => item.skill_id);
    const repeatedIssues = [...issueCounts].filter(([, count]) => count >= 2);
    const noUse = this.data.cards.filter(item => item.focus === '当前核心' && !usage.get(item.skill_id));
    const unverifiedChanges = changes.filter(change => !this.data.uses.some(item =>
      item.skill_id === change.skill_id && new Date(item.time).getTime() > new Date(change.time).getTime()));
    const noUseLabel = this.range === 'all' ? '现有记录中未出现' : '本期未记录到';
    this.insight(box, `${noUse.length} 个核心技能${noUseLabel}使用`, '可能是未触发、漏记或暂不需要；不能直接判为无价值。');
    this.insight(box, `${failures.length} 次失败或部分完成`, '先查看事件任务与产物，再判断是否应修改技能。');
    this.insight(box, `${repeatedIssues.length} 个技能本期至少出现 2 次问题`, '重复问题比单次失败更值得优先复盘；仍须核对任务条件。');
    this.insight(box, `${unverifiedChanges.length} 次迭代后未见新使用`, '还不能判断改动是否有效；下一次实际任务可优先验证。');
    if (this.data.uses.length <= 1) {
      el(box, 'p', 'skill-insight-warning', '样本很少：当前洞察只描述记录，不提供效果排名或成功率判断。');
    }
  }

  insight(parent, title, explanation) {
    const item = el(parent, 'div', 'skill-insight-insight');
    el(item, 'strong', '', title);
    el(item, 'span', '', explanation);
  }

  renderRecent(root, uses, changes) {
    const box = el(root, 'section', 'skill-insight-panel');
    el(box, 'h2', '', '最近事件');
    const events = [...uses.map(item => ({ ...item, kind: '使用' })), ...changes.map(item => ({ ...item, kind: '迭代' }))]
      .sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 8);
    if (!events.length) { el(box, 'p', 'skill-insight-muted', '这个时间范围内还没有记录。'); return; }
    for (const event of events) {
      const line = el(box, 'button', 'skill-insight-event');
      el(line, 'span', `skill-insight-badge ${event.kind === '迭代' ? 'change' : ''}`, event.kind);
      if (event.kind === '使用' && String(event.source || '').startsWith('转录自动')) el(line, 'span', 'skill-insight-badge auto', '转录');
      el(line, 'strong', '', event.skill_id);
      el(line, 'span', 'skill-insight-event-summary', event.kind === '使用' ? event.task : event.reason);
      el(line, 'time', '', shortDate(event.time));
      line.title = event.task || '';
    }
  }

  selectSkill(skill) {
    this.selected = skill;
    this.tab = 'skills';
    this.render();
  }

  // 会话卡片页（借鉴 dsh-context）：按会话分组的使用记录，可搜索、可下钻
  renderSessions(root) {
    const toolbar = el(root, 'div', 'skill-insight-toolbar');
    const input = el(toolbar, 'input', 'skill-insight-search');
    input.placeholder = '搜索会话 ID 或技能';
    input.value = this.sessionQuery;
    input.addEventListener('input', event => { this.sessionQuery = event.target.value; this.renderSessionsList(root); });
    this.renderSessionsList(root);
  }

  renderSessionsList(root) {
    const old = root.querySelector('.skill-insight-sessions-layout');
    if (old) old.remove();
    const layout = el(root, 'div', 'skill-insight-sessions-layout');
    const { uses } = this.filtered();
    const text = this.sessionQuery.trim().toLowerCase();
    const groups = new Map();
    for (const use of uses) {
      const key = use.session || '(显式记账)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(use);
    }
    const sessions = [...groups.entries()]
      .map(([session, items]) => ({
        session,
        items,
        skills: countsBy(items, i => i.skill_id),
        agents: [...new Set(items.map(i => String(i.source || '').replace(/^转录自动 · /u, '')))]
          .filter(a => a && a !== '看板手动记录' && a !== '显式记录'),
        first: items.map(i => String(i.time)).sort()[0],
        last: items.map(i => String(i.time)).sort().pop(),
      }))
      .filter(item => !text || item.session.toLowerCase().includes(text)
        || [...item.skills.keys()].some(s => s.toLowerCase().includes(text)))
      .sort((a, b) => String(b.last).localeCompare(String(a.last)));
    const grid = el(layout, 'div', 'skill-insight-session-grid');
    if (!sessions.length) { el(grid, 'p', 'skill-insight-muted', '没有匹配的会话记录。'); return; }
    for (const s of sessions) {
      const card = el(grid, 'div', 'skill-insight-session-card');
      const head = el(card, 'div', 'skill-insight-session-head');
      const titleBox = el(head, 'div', 'skill-insight-session-title');
      el(titleBox, 'strong', '', s.session === '(显式记账)' ? '未关联会话（显式记账）'
        : s.session.length > 26 ? `${s.session.slice(0, 26)}…` : s.session);
      el(titleBox, 'small', '', `${shortDate(s.first)} ~ ${shortDate(s.last)}`);
      const meta = el(head, 'div', 'skill-insight-session-meta');
      for (const a of s.agents) el(meta, 'span', 'skill-insight-badge auto', a);
      el(meta, 'span', 'skill-insight-badge', `${s.items.length} 条记录`);
      const chips = el(card, 'div', 'skill-insight-session-skills');
      for (const [skill, count] of [...s.skills.entries()].sort((a, b) => b[1] - a[1])) {
        const chip = el(chips, 'button', 'skill-insight-chip', `${skill} ×${count}`);
        chip.title = `筛选技能 ${skill}`;
        chip.addEventListener('click', () => { this.filter.skill = skill; this.render(); });
      }
    }
  }

  renderSkills(root) {
    const toolbar = el(root, 'div', 'skill-insight-toolbar');
    const input = el(toolbar, 'input', 'skill-insight-search');
    input.placeholder = '搜索技能、分类或状态';
    input.value = this.query;
    input.addEventListener('input', event => { this.query = event.target.value; this.renderSkillsList(root); });
    this.renderSkillsList(root);
  }

  renderSkillsList(root) {
    const old = root.querySelector('.skill-insight-skills-layout');
    if (old) old.remove();
    const layout = el(root, 'div', 'skill-insight-skills-layout');
    const list = el(layout, 'div', 'skill-insight-panel skill-insight-skill-list');
    const text = this.query.trim().toLowerCase();
    const cards = this.data.cards.filter(item => !text || [item.skill_id, item.category, item.maintenance, item.focus]
      .some(value => String(value || '').toLowerCase().includes(text)));
    el(list, 'h2', '', `技能清单 · ${cards.length}`);
    const usageCounts = countsBy(this.data.uses, item => item.skill_id);
    for (const card of cards) {
      const item = el(list, 'div', `skill-insight-skill-row ${this.selected === card.skill_id ? 'is-active' : ''}`);
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      const head = el(item, 'div', 'skill-insight-skill-row-head');
      el(head, 'strong', '', card.skill_id);
      el(head, 'span', 'skill-insight-skill-row-count', `${usageCounts.get(card.skill_id) || 0} 次`);
      el(item, 'span', '', `${card.category || '未分类'} · ${card.maintenance || '未标注'}`);
      item.addEventListener('click', () => { this.selected = card.skill_id; this.renderSkillsList(root); });
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.selected = card.skill_id;
          this.renderSkillsList(root);
        }
      });
    }
    const selected = cards.find(item => item.skill_id === this.selected) || cards[0];
    if (selected) this.renderSkillDetail(layout, selected);
  }

  renderSkillDetail(parent, card) {
    const box = el(parent, 'section', 'skill-insight-panel skill-insight-detail');
    const title = el(box, 'div', 'skill-insight-detail-title');
    el(title, 'h2', '', card.skill_id);
    const uses = this.data.uses.filter(item => item.skill_id === card.skill_id);
    const changes = this.data.changes.filter(item => item.skill_id === card.skill_id);
    const stats = el(box, 'div', 'skill-insight-detail-stats');
    for (const [label, value] of [['当前修订', this.currentRevision(card.skill_id)], ['记录使用', uses.length], ['迭代次数', changes.length], ['最近使用', uses[0] ? shortDate(uses[0].time) : '无记录']]) {
      const item = el(stats, 'div', '');
      el(item, 'small', '', label);
      el(item, 'strong', '', value);
    }
    const tags = el(box, 'div', 'skill-insight-tags');
    for (const value of [card.category, card.focus, card.maintenance, card.capability]) el(tags, 'span', '', value || '未标注');
    el(box, 'p', 'skill-insight-muted', `源码：${card.source_path || '未登记'}`);
    if (this.pending.has(card.skill_id)) this.renderPendingDraft(box, card);
    if (!uses.length) el(box, 'p', 'skill-insight-muted', '尚无使用记录。');
    this.renderRecording(box, card);
    el(box, 'h3', '', '版本与迭代');
    const revisions = new Map();
    for (const event of uses) {
      const key = event.revision || '未标版本';
      if (!revisions.has(key)) revisions.set(key, { total: 0, completed: 0, issues: 0 });
      const count = revisions.get(key);
      count.total++;
      if (event.result === '完成') count.completed++;
      if (event.result === '失败' || event.result === '部分完成') count.issues++;
    }
    const versionStats = key => {
      const count = revisions.get(key);
      return count ? `${count.total} 次 · 完成 ${count.completed} · 问题 ${count.issues}` : '0 次使用';
    };
    const baseline = el(box, 'div', 'skill-insight-version');
    el(baseline, 'strong', '', 'r0 · 盘点基线');
    el(baseline, 'span', 'skill-insight-version-stats', versionStats('r0'));
    el(baseline, 'code', '', String(card.baseline_sha256 || '').slice(0, 12));
    const baselineButton = el(baseline, 'button', '', '查看快照');
    baselineButton.addEventListener('click', () => this.showSnapshot(box, card.skill_id, 'r0'));
    for (const event of [...changes].reverse()) {
      const line = el(box, 'div', 'skill-insight-version');
      el(line, 'strong', '', `${event.revision || 'r?'} · ${event.reason || '未注明原因'}`);
      el(line, 'span', 'skill-insight-version-stats', versionStats(event.revision || '未标版本'));
      el(line, 'span', '', shortDate(event.time));
      const button = el(line, 'button', '', '查看快照');
      button.addEventListener('click', () => this.showSnapshot(box, card.skill_id, event.revision));
      const diff = el(line, 'button', '', '对比上一版');
      diff.addEventListener('click', () => this.showDiff(box, card.skill_id, event.revision));
    }
    el(box, 'h3', '', '最近使用');
    for (const event of uses.slice(0, 6)) {
      const resultClass = { '完成': 'ok', '部分完成': 'warn', '失败': 'fail', '中止': 'abort' }[event.result] || '';
      const line = el(box, 'button', 'skill-insight-event');
      el(line, 'span', `skill-insight-badge ${resultClass}`, event.result || '未标结果');
      if (String(event.source || '').startsWith('转录自动')) el(line, 'span', 'skill-insight-badge auto', '转录');
      el(line, 'span', 'skill-insight-event-summary', event.task || '未写任务');
      el(line, 'time', '', shortDate(event.time));
      line.title = event.task || '';
    }
  }

  // 待确认变更草稿：自动检测的 SKILL.md 变更 + 差异预览，确认仍走「登记新版本」人工流程
  renderPendingDraft(box, card) {
    const info = this.pending.get(card.skill_id);
    const draft = el(box, 'div', 'skill-insight-pending');
    const head = el(draft, 'div', 'skill-insight-pending-head');
    el(head, 'strong', '', `检测到未登记变更（自 ${info.revision} 之后）`);
    const toggle = el(head, 'button', '', '查看差异');
    el(draft, 'small', '', `当前哈希 ${String(info.hash).slice(0, 12)} · 基线 ${info.revision} · 检测于 ${shortDate(info.detectedAt)}`);
    let diffBox = null;
    toggle.addEventListener('click', async () => {
      if (diffBox) { diffBox.remove(); diffBox = null; toggle.textContent = '查看差异'; return; }
      const detail = await this.plugin.pendingDiff(card);
      if (!detail) { new Notice('无法读取差异（缺少基线快照）'); return; }
      const lines = detail.diff.filter(([tag]) => tag !== ' ').slice(0, 60);
      diffBox = el(draft, 'pre', 'skill-insight-diff-lines');
      el(diffBox, '', '', lines.map(([tag, text]) => `${tag === '+' ? '+ ' : '- '}${text}`).join('\n') || '（无文本差异）');
      toggle.textContent = '收起差异';
    });
    el(draft, 'p', 'skill-insight-muted', '在下方「技能迭代」填写修改原因与验证结果，点「登记新版本」即把当前内容登记为新版本；若属误改可直接还原文件，本提示会自动消失。');
  }

  renderRecording(box, card) {
    const panel = el(box, 'details', 'skill-insight-recording');
    el(panel, 'summary', '', '记录实际使用 / 技能迭代');
    el(panel, 'p', 'skill-insight-muted', '只记录真实任务；不要填客户原文、密钥或完整对话。仅查看技能说明不算使用。');
    const use = el(panel, 'div', 'skill-insight-recording-form');
    el(use, 'strong', '', '实际使用');
    const task = el(use, 'input', 'skill-insight-search');
    task.placeholder = '非敏感任务简述';
    task.maxLength = 200;
    const result = el(use, 'select', 'skill-insight-select');
    for (const value of ['完成', '部分完成', '失败', '中止']) {
      const option = el(result, 'option', '', value);
      option.value = value;
    }
    const useButton = el(use, 'button', 'skill-insight-pill', '记 1 次使用');
    useButton.addEventListener('click', async () => {
      try {
        await this.plugin.recordUse(card, task.value, result.value);
        new Notice('使用事件已记录');
        await this.refresh();
      } catch (error) { new Notice(`记录失败：${error.message}`); }
    });
    const change = el(panel, 'div', 'skill-insight-recording-form');
    el(change, 'strong', '', '技能迭代（修改 SKILL.md 后）');
    const reason = el(change, 'input', 'skill-insight-search');
    reason.placeholder = '修改原因';
    reason.maxLength = 200;
    const test = el(change, 'input', 'skill-insight-search');
    test.placeholder = '验证结果';
    test.maxLength = 200;
    const changeButton = el(change, 'button', 'skill-insight-pill', '登记新版本');
    changeButton.addEventListener('click', async () => {
      try {
        await this.plugin.recordChange(card, reason.value, test.value);
        new Notice('迭代事件已记录');
        await this.refresh();
      } catch (error) { new Notice(`登记失败：${error.message}`); }
    });
  }

  async showSnapshot(box, skill, revision) {
    const text = this.plugin.store?.snapshots?.[skill]?.[revision];
    if (typeof text !== 'string') {
      new Notice('没有可用的版本快照');
      return;
    }
    let viewer = box.querySelector('.skill-insight-snapshot');
    if (!viewer) viewer = el(box, 'div', 'skill-insight-snapshot');
    viewer.empty();
    el(viewer, 'strong', '', `${revision} · 只读快照`);
    el(viewer, 'pre', '', text);
    viewer.scrollIntoView({ block: 'nearest' });
  }

  async showDiff(box, skill, revision) {
    if (!/^[\p{L}\p{N}_-]+$/u.test(skill) || !/^r[1-9]\d*$/u.test(revision)) {
      new Notice('没有可比较的版本');
      return;
    }
    const number = Number(revision.slice(1));
    const before = this.plugin.store?.snapshots?.[skill]?.[`r${number - 1}`];
    const after = this.plugin.store?.snapshots?.[skill]?.[revision];
    if (typeof before !== 'string' || typeof after !== 'string') { new Notice('版本快照读取失败'); return; }
    let viewer = box.querySelector('.skill-insight-snapshot');
    if (!viewer) viewer = el(box, 'div', 'skill-insight-snapshot');
    viewer.empty();
    el(viewer, 'strong', '', `r${number - 1} → ${revision} · 只读差异`);
    const lines = el(viewer, 'div', 'skill-insight-diff');
    for (const [mark, text] of diffLines(before, after)) {
      const line = el(lines, 'div', `skill-insight-diff-line ${mark === '+' ? 'added' : mark === '-' ? 'removed' : ''}`);
      line.textContent = `${mark} ${text}`;
    }
    viewer.scrollIntoView({ block: 'nearest' });
  }

  renderChanges(root) {
    const box = el(root, 'section', 'skill-insight-panel');
    el(box, 'h2', '', '技能迭代时间线');
    const changes = this.filtered().changes;
    if (!changes.length) { el(box, 'p', 'skill-insight-muted', '还没有真实技能迭代记录。r0 基线不算一次迭代。'); return; }
    const skillCount = new Set(changes.map(item => item.skill_id)).size;
    el(box, 'p', 'skill-insight-muted', `本期共 ${changes.length} 次迭代，覆盖 ${skillCount} 个技能；点击事件可跳转到对应技能明细。`);
    for (const event of changes) {
      const item = el(box, 'button', 'skill-insight-change-event');
      el(item, 'time', '', shortDate(event.time));
      el(item, 'strong', '', `${event.skill_id} · ${event.revision || '未标版本'}`);
      el(item, 'span', '', event.reason || '未注明原因');
      el(item, 'small', '', `验收：${event.test_result || '未登记'} · ${String(event.before_sha256 || '').slice(0, 8)} → ${String(event.after_sha256 || '').slice(0, 8)}`);
      item.addEventListener('click', () => this.selectSkill(event.skill_id));
    }
  }

  renderFooter(root) {
    el(root, 'div', 'skill-insight-footer', '数据源：插件私有存储 · 显式记账 + 会话转录自动采集 · 不采集完整聊天');
  }

}

// 设置页：让插件出现在「第三方插件」侧栏，并提供看板入口与采集配置
class SkillInsightSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const root = this.containerEl;
    root.empty();
    root.addClass('skill-insight-root');
    el(root, 'h2', '', 'Skill 洞察');
    el(root, 'p', 'skill-insight-muted', '把 AI agent 会话里技能的使用与迭代整理成本地看板。所有数据保存在插件目录的 data.json，不写入 vault，也不发起任何网络请求。');
    const open = el(root, 'div', 'skill-insight-discovery-actions');
    const viewBtn = el(open, 'button', 'skill-insight-pill is-active', '打开看板');
    viewBtn.addEventListener('click', () => {
      // 设置页是模态弹层：先关闭再 reveal，否则焦点切不到工作区叶子
      if (this.app.setting && typeof this.app.setting.close === 'function') this.app.setting.close();
      this.plugin.activateView();
    });

    const box = el(root, 'section', 'skill-insight-panel skill-insight-transcript');
    el(box, 'h2', '', '会话转录自动采集');
    el(box, 'p', 'skill-insight-muted', '打开看板时自动读取 Claudian 会话注册表（.claudian/sessions），解析本 vault 发起的 agent 会话转录补记使用。显式 Skill 工具调用逐次计数；命令定向读取 SKILL.md 按会话每技能计 1 次。补丁写操作、大批量扫描、命令输出与聊天正文不计。首次安装只回扫近 7 天历史，之后按字节偏移增量采集；新技能建卡时自动回扫补录。');
    const inputs = {};
    for (const [agent, label] of TRANSCRIPT_AGENTS) {
      const config = this.plugin.settings.transcripts?.[agent] || { globalScan: false, root: '' };
      const row = el(box, 'div', 'skill-insight-transcript-row');
      const toggle = el(row, 'label', '');
      const check = el(toggle, 'input', '');
      check.type = 'checkbox';
      check.checked = config.globalScan;
      el(toggle, 'span', '', `${label} 全局兜底`);
      const input = el(row, 'input', 'skill-insight-search');
      input.type = 'text';
      input.placeholder = `全局转录根目录（默认 ${defaultTranscriptRoot(agent)}）`;
      input.value = config.root;
      inputs[agent] = { check, input };
    }
    const actions = el(box, 'div', 'skill-insight-discovery-actions');
    const save = el(actions, 'button', 'skill-insight-pill is-active', '保存采集设置');
    save.addEventListener('click', async () => {
      try {
        for (const [agent, pair] of Object.entries(inputs)) {
          await this.plugin.setTranscriptConfig(agent, { globalScan: pair.check.checked, root: pair.input.value });
        }
        new Notice('采集设置已保存');
        this.display();
      } catch (error) {
        new Notice(`保存采集设置失败：${error.message}`);
      }
    });
    el(box, 'p', 'skill-insight-muted', '立即采集、来源报告与迭代记账请打开看板的「来源与采集」页。');
  }
}

module.exports = class SkillInsightPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData() || {};
    const savedTranscripts = saved.transcripts && typeof saved.transcripts === 'object' ? saved.transcripts : {};
    this.settings = {
      sources: Array.isArray(saved.sources) ? saved.sources : DEFAULT_SOURCES,
      // v0.7：enabled 旧字段不再使用；globalScan = 全局转录目录兜底（默认关，仅统计非 Claudian 发起的使用）
      transcripts: Object.fromEntries(TRANSCRIPT_AGENTS.map(([agent]) => [
        agent,
        { globalScan: savedTranscripts[agent]?.globalScan === true, root: String(savedTranscripts[agent]?.root || '') },
      ])),
    };
    this.store = saved.store || await this.migrateLegacy();
    if (!saved.store) await this.persist();
    this.scanWarnings = [];
    this.registerView(VIEW, leaf => new SkillInsightView(leaf, this));
    this.addRibbonIcon('activity', '打开 Skill 洞察', () => this.activateView());
    this.addCommand({ id: 'open-skill-insight', name: '打开 Skill 洞察看板', callback: () => this.activateView() });
    this.addSettingTab(new SkillInsightSettingTab(this.app, this));
    // 全自动初始化：扫描已装技能直接建卡建 r0 快照（幂等，已建卡的跳过）
    this.initPromise = this.autoInitialize();
  }

  async persist() { await this.saveData({ ...this.settings, store: this.store }); }

  async refreshStore() {
    const saved = await this.loadData();
    if (saved?.store) this.store = saved.store;
  }

  // 自动识别默认来源中已安装的技能并建卡；不覆盖已有卡，失败静默（打开看板时仍可手动扫描）
  async autoInitialize() {
    try {
      const found = await this.discoverSkills();
      const existing = new Set(this.store.cards.map(card => card.skill_id));
      const seen = new Set();
      const fresh = found.filter(item => !existing.has(item.skill_id) && !seen.has(item.skill_id) && seen.add(item.skill_id));
      if (fresh.length) await this.initializeSkills(fresh);
      return fresh.length;
    } catch (error) {
      console.error('[skill-insight] 自动初始化失败', error);
      return 0;
    }
  }

  // 只读迁移：从旧版 vault 目录读历史 markdown 数据；插件自身从不写入 vault
  async migrateLegacy() {
    const legacyCards = await this.app.vault.adapter.exists(`${LEGACY_ROOT}技能卡`);
    const dataRoot = legacyCards ? LEGACY_ROOT : DEFAULT_ROOT;
    const historyRoot = legacyCards ? LEGACY_HISTORY : `${dataRoot}版本快照/`;
    const store = { cards: [], uses: [], changes: [], snapshots: {} };
    const folders = ['技能卡/', '使用记录/', '迭代记录/'].map(name => `${dataRoot}${name}`);
    for (const folder of folders) {
      if (!await this.app.vault.adapter.exists(folder)) continue;
      const files = (await this.app.vault.adapter.list(folder)).files.filter(path => path.endsWith('.md'));
      for (const file of files) {
      const raw = await this.app.vault.adapter.read(file);
      const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
      if (!match) continue;
      const props = parseYaml(match[1]);
      if (props?.type === 'skill-card') store.cards.push({ ...props });
      if (props?.type === 'skill-use') store.uses.push({ ...props });
      if (props?.type === 'skill-change') store.changes.push({ ...props });
      }
    }
    for (const card of store.cards) {
      const revisions = ['r0', ...store.changes.filter(item => item.skill_id === card.skill_id).map(item => item.revision)];
      const snapshots = {};
      for (const revision of revisions) {
        const path = `${historyRoot}${card.skill_id}/${revision}.md`;
        if (await this.app.vault.adapter.exists(path)) snapshots[revision] = await this.app.vault.adapter.read(path);
      }
      store.snapshots[card.skill_id] = snapshots;
    }
    return store;
  }

  async setSources(sources) {
    const path = require('node:path');
    for (const source of sources) {
      if (!path.isAbsolute(source) && !path.win32.isAbsolute(source) && !vaultSource(source)) {
        throw new Error(`无效的 Vault 相对路径：${source}`);
      }
    }
    this.settings.sources = sources;
    await this.persist();
  }

  async discoverSkills() {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const found = [];
    const seen = new Set();
    const warnings = [];
    for (const source of this.settings.sources) {
      const absolute = path.isAbsolute(source) || path.win32.isAbsolute(source);
      try {
        let dirs;
        if (absolute) {
          dirs = (await fs.readdir(source, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
            .map(entry => path.join(source, entry.name));
        } else {
          const base = vaultSource(source);
          if (!base || !await this.app.vault.adapter.exists(base)) continue;
          dirs = (await this.app.vault.adapter.list(base)).folders;
        }
        for (const dir of dirs) {
          const skillId = safeSkillId(absolute ? path.basename(dir) : dir.split('/').pop());
          if (!skillId) continue;
          const skillPath = absolute ? path.join(dir, 'SKILL.md') : `${dir}/SKILL.md`;
          try {
            const canonical = absolute ? await fs.realpath(skillPath) : skillPath;
            if (seen.has(canonical)) continue;
            const content = absolute ? await fs.readFile(skillPath, 'utf8') : await this.app.vault.adapter.read(skillPath);
            seen.add(canonical);
            const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
            let props = {};
            try { if (match) props = parseYaml(match[1]) || {}; }
            catch (error) { warnings.push(`${skillPath}: frontmatter 解析失败`); }
            found.push({ key: canonical, skill_id: skillId, source_path: skillPath, absolute,
              description: String(props.description || '').trim(), content });
          } catch (error) {
            if (error.code !== 'ENOENT') warnings.push(`${skillPath}: ${error.message}`);
          }
        }
      } catch (error) { warnings.push(`${source}: ${error.message}`); }
    }
    this.scanWarnings = warnings;
    return found.sort((a, b) => a.skill_id.localeCompare(b.skill_id, 'zh-CN') || a.source_path.localeCompare(b.source_path));
  }

  async initializeSkills(candidates) {
    const fs = require('node:fs/promises');
    const crypto = require('node:crypto');
    const ids = new Set();
    for (const item of candidates) {
      if (!safeSkillId(item.skill_id) || ids.has(item.skill_id)) throw new Error(`技能名称重复或无效：${item.skill_id}`);
      ids.add(item.skill_id);
      const current = item.absolute ? await fs.readFile(item.source_path, 'utf8') : await this.app.vault.adapter.read(item.source_path);
      if (current !== item.content) throw new Error(`${item.skill_id} 已变化，请重新扫描后再初始化`);
      if (this.store.cards.some(card => card.skill_id === item.skill_id)) throw new Error(`${item.skill_id} 已有技能卡，不会覆盖`);
    }
    const next = JSON.parse(JSON.stringify(this.store));
    for (const item of candidates) {
      const hash = crypto.createHash('sha256').update(item.content, 'utf8').digest('hex');
      next.cards.push({ type: 'skill-card', skill_id: item.skill_id, category: '未分类', focus: '按需调用',
        maintenance: '待核对', capability: '未逐项实测', source_path: item.source_path,
        baseline_sha256: hash, baseline_revision: 'r0', reviewed_on: new Date().toISOString().slice(0, 10), description: item.description });
      next.snapshots[item.skill_id] = { r0: item.content };
    }
    this.store = next;
    await this.persist();
    return candidates.length;
  }

  async readSource(card) {
    const source = String(card.source_path || '');
    if (!source) throw new Error('技能卡缺少源码路径');
    const path = require('node:path');
    if (path.isAbsolute(source) || path.win32.isAbsolute(source)) {
      return require('node:fs/promises').readFile(source, 'utf8');
    }
    const relative = vaultSource(source);
    if (!relative || !relative.endsWith('/SKILL.md')) throw new Error('技能源码路径无效');
    return this.app.vault.adapter.read(relative);
  }

  async latestState(card) {
    const changes = this.store.changes.filter(item => item.skill_id === card.skill_id && /^r[1-9]\d*$/u.test(String(item.revision)));
    changes.sort((a, b) => Number(String(b.revision).slice(1)) - Number(String(a.revision).slice(1)));
    return changes.length
      ? { revision: String(changes[0].revision), hash: String(changes[0].after_sha256 || '') }
      : { revision: 'r0', hash: String(card.baseline_sha256 || '') };
  }

  eventId(kind) {
    const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace('T', '-').replace(/\..*$/u, '');
    const nonce = require('node:crypto').randomBytes(4).toString('hex');
    return `${kind}-${stamp}-${nonce}`;
  }

  // 待确认草稿：刷新时自动比对 SKILL.md 哈希与最近已登记版本，检出「未登记变更」。
  // 只检测不登记——版本语义（原因/验证结果）仍由人工确认，迭代时间线不失真；
  // 纯内存计算不落库，文件回滚则草稿自动消失。
  async detectPendingChanges() {
    const crypto = require('node:crypto');
    const pending = new Map();
    for (const card of this.store.cards) {
      try {
        const content = await this.readSource(card);
        const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const state = await this.latestState(card);
        if (state.hash && hash !== state.hash) {
          pending.set(card.skill_id, { hash, revision: state.revision, detectedAt: new Date().toISOString() });
        }
      } catch {
        // 读不到源码（路径失效等）不视为变更
      }
    }
    return pending;
  }

  // 待确认草稿的差异预览：最近登记快照 vs 当前 SKILL.md
  async pendingDiff(card) {
    const state = await this.latestState(card);
    const before = this.store.snapshots?.[card.skill_id]?.[state.revision];
    if (typeof before !== 'string') return null;
    let current;
    try { current = await this.readSource(card); } catch { return null; }
    return { revision: state.revision, diff: diffLines(before, current) };
  }

  async recordUse(card, task, result) {
    const summary = String(task || '').trim();
    if (!summary || summary.length > 200) throw new Error('请填写 1–200 字任务简述');
    if (!['完成', '部分完成', '失败', '中止'].includes(result)) throw new Error('结果无效');
    const crypto = require('node:crypto');
    const currentHash = crypto.createHash('sha256').update(await this.readSource(card), 'utf8').digest('hex');
    const state = await this.latestState(card);
    if (!state.hash || currentHash !== state.hash) throw new Error('技能内容已有变化，请先登记迭代');
    const id = this.eventId('USE');
    this.store.uses.push({ type: 'skill-use', event_id: id, time: new Date().toISOString(), skill_id: card.skill_id,
      revision: state.revision, skill_sha256: currentHash, result, task: summary, artifact: '', source: '看板手动记录' });
    await this.persist();
    return id;
  }

  async recordChange(card, reason, testResult) {
    const why = String(reason || '').trim();
    const test = String(testResult || '').trim();
    if (!why || !test || why.length > 200 || test.length > 200) throw new Error('请填写 1–200 字修改原因和验证结果');
    const crypto = require('node:crypto');
    const content = await this.readSource(card);
    const after = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const state = await this.latestState(card);
    if (!state.hash) throw new Error('缺少已登记的基线哈希');
    if (after === state.hash) throw new Error('技能内容未变化，不能登记迭代');
    const revision = `r${Number(state.revision.slice(1)) + 1}`;
    if (this.store.snapshots?.[card.skill_id]?.[revision]) throw new Error('版本快照已存在，请先检查记录');
    const id = this.eventId('CHANGE');
    if (!this.store.snapshots[card.skill_id]) this.store.snapshots[card.skill_id] = {};
    this.store.snapshots[card.skill_id][revision] = content;
    this.store.changes.push({ type: 'skill-change', event_id: id, time: new Date().toISOString(), skill_id: card.skill_id,
      revision, before_sha256: state.hash, after_sha256: after, reason: why, test_result: test, source: '看板手动记录' });
    await this.persist();
    return id;
  }

  async setTranscriptConfig(agent, patch) {
    if (!this.settings.transcripts[agent]) throw new Error(`未知的转录来源：${agent}`);
    this.settings.transcripts[agent] = { globalScan: Boolean(patch.globalScan), root: String(patch.root || '').trim() };
    await this.persist();
  }

  // 读 Claudian 会话注册表（vault 内 .claudian/sessions/conv-*.meta.json）：
  // 每条给出 providerId 与 sessionFilePath（指向本机后端转录文件），
  // 以官方账本为准精准圈定「本 vault 发起的会话」，替代盲扫全局目录（dsh-context 同款设计）。
  async readClaudianRegistry() {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    let dir;
    try { dir = path.join(this.app.vault.adapter.getBasePath(), '.claudian', 'sessions'); } catch { return []; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('conv-') || !entry.name.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'));
        const provider = claudianProvider(meta.providerId);
        if (!provider) continue;
        const state = meta.providerState && typeof meta.providerState === 'object' ? meta.providerState : {};
        const activity = meta.lastActivityAt ?? meta.createdAt;
        const activityIso = typeof activity === 'number' && Number.isFinite(activity)
          ? new Date(activity).toISOString()
          : String(activity || '');
        out.push({
          provider,
          sessionId: String(meta.sessionId || state.threadId || ''),
          sessionFilePath: String(state.sessionFilePath || ''),
          lastActivityAt: activityIso,
        });
      } catch { /* 坏 meta 跳过 */ }
    }
    return out;
  }

  async collectTranscripts() {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const known = new Set(this.store.cards.map(card => card.skill_id));
    if (!this.store.ingest || typeof this.store.ingest !== 'object') this.store.ingest = { offsets: {} };
    if (!this.store.ingest.offsets || typeof this.store.ingest.offsets !== 'object') this.store.ingest.offsets = {};
    const offsets = this.store.ingest.offsets;
    // 建卡后回扫：新建技能卡时清空游标全量重读，靠 auto_key 确定性去重，只补漏不重复
    let rescanNote = '';
    if (this.pendingRescan) {
      this.pendingRescan = false;
      if (Object.keys(offsets).length) rescanNote = '检测到新建技能卡，已回扫历史转录补计未建卡期间的用量。';
      for (const key of Object.keys(offsets)) delete offsets[key];
    }
    // 采集口径升级（INGEST_VERSION）时一次性清理旧自动记录，从零重采
    if ((this.store.ingest.version || 1) < INGEST_VERSION) {
      this.store.uses = this.store.uses.filter(use => !(typeof use.auto_key === 'string' && /^auto[xs]?:/.test(use.auto_key)));
      for (const key of Object.keys(offsets)) delete offsets[key];
      this.store.ingest.version = INGEST_VERSION;
    }
    // 首次采集（或口径清零后）只回扫近 7 天历史对话；建卡触发的回扫不限时间，历史用量由去重兜底
    const firstScan = Object.keys(offsets).length === 0 && !this.store.ingest.everScanned;
    const windowStart = firstScan ? Date.now() - 7 * DAY : 0;
    const autoKeys = new Set(this.store.uses.map(use => use.auto_key).filter(Boolean));
    const reports = [];
    let added = 0;
    const registry = await this.readClaudianRegistry();
    const vaultBase = String(this.app.vault.adapter.getBasePath()).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
    for (const [agent] of TRANSCRIPT_AGENTS) {
      const config = this.settings.transcripts[agent] || {};
      const entries = registry.filter(item => item.provider === agent);
      const root = config.root || defaultTranscriptRoot(agent);
      // 主路径：注册表给出的转录文件；codex 会把旧会话压缩为 .zst，跳过并计数
      const files = new Set();
      let archived = 0;
      for (const entry of entries) {
        if (!entry.sessionFilePath) continue;
        try { const st = await fs.stat(entry.sessionFilePath); if (st.isFile()) { files.add(entry.sessionFilePath); continue; } } catch { /* 可能已归档压缩 */ }
        try { await fs.stat(`${entry.sessionFilePath}.zst`); archived++; continue; } catch { /* 注册表陈旧，交给 cwd 判定 */ }
      }
      if (config.globalScan) {
        // 兜底开关：额外扫描全局转录目录（统计非本 vault 发起的使用），默认关
        for (const file of await walkJsonl(fs, path, root)) files.add(file);
      } else {
        // 「仅本 vault」通道：注册表可能滞后（如终端直启的会话），用会话元数据判定补齐
        for (const file of await walkJsonl(fs, path, root)) {
          if (files.has(file)) continue;
          const isVault = agent === 'codex'
            ? String(await sessionMetaCwd(fs, file)).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase() === vaultBase
            : path.basename(path.dirname(file)).toLowerCase() === claudeProjectToken(vaultBase);
          if (isVault) files.add(file);
        }
      }
      if (!files.size) {
        reports.push(`${agent}:注册表 ${entries.length} 会话（${archived} 个已压缩归档跳过），无可读转录文件`);
        continue;
      }
      let agentAdded = 0;
      for (const file of files) {
        let stat;
        try { stat = await fs.stat(file); } catch { continue; }
        // 首扫窗口外的旧文件：偏移量直接记到末尾（标记已读），后续追加仍增量采集
        if (stat.mtimeMs < windowStart) { offsets[file] = stat.size; continue; }
        let start = Number(offsets[file]) || 0;
        if (start > stat.size) start = 0; // 文件被重写/截断时重新读取
        if (start === stat.size) continue;
        let buffer;
        try {
          const handle = await fs.open(file, 'r');
          try {
            buffer = Buffer.alloc(stat.size - start);
            await handle.read(buffer, 0, buffer.length, start);
          } finally { await handle.close(); }
        } catch { continue; }
        const text = buffer.toString('utf8');
        const newline = text.lastIndexOf('\n');
        if (newline < 0) continue; // 尾部行尚未写完整，等下次追加
        const complete = text.slice(0, newline + 1);
        const mtime = stat.mtime.toISOString();
        const fileSession = path.basename(file, '.jsonl');
        let sessionId = fileSession;
        let sessionTime = ''; // 会话起始时间，作行时间戳缺失时的兜底
        const recorded = new Set(); // 本会话已记账的技能（路径信号按会话去重）
        const fileRecords = []; // 先攒后审：跨层去重后再出账
        let cursor = start;
        for (const raw of complete.split('\n')) {
          const lineStart = cursor;
          cursor += Buffer.byteLength(raw, 'utf8') + 1;
          if (!raw.trim()) continue;
          let line;
          try { line = JSON.parse(raw); } catch { continue; }
          if (agent === 'codex' && line.type === 'session_meta' && line.payload?.session_id) {
            sessionId = String(line.payload.session_id);
            if (line.timestamp) sessionTime = String(line.timestamp);
          }
          if (sessionId === fileSession && line.sessionId) sessionId = String(line.sessionId);
          // 时间取值链：行时间戳（UTC ISO，展示层转本地时区）→ 会话起始时间 → 文件 mtime
          const parsed = new Date(line.timestamp || sessionTime);
          const time = Number.isNaN(parsed.getTime()) ? mtime : parsed.toISOString();
          if (!known.size) continue;
          const inWindow = !firstScan || new Date(time).getTime() >= windowStart; // 首扫只认近 7 天
          const records = []; // {skillId, explicit}
          for (const hint of findSkillToolCalls(line)) {
            const id = normalizeSkillHint(hint);
            if (known.has(id)) records.push({ skillId: id, explicit: true });
          }
          if (!records.length) {
            // 层2：命令中定向读取 SKILL.md 即为使用信号——一条命令出现多个技能路径
            // 各计 1 次（会话内去重）；补丁写操作（Add/Update/Delete File:）不计；
            // 单条命令出现 ≥6 个技能路径视为脚本化批量扫描，整条忽略。输出与正文不参与匹配。
            const cmdText = commandTextsOf(line).join('\n');
            if (cmdText) {
              const reads = new Set();
              for (const match of cmdText.matchAll(SKILL_PATH_RE)) {
                const id = match[1];
                if (!known.has(id)) continue;
                const before = cmdText.slice(Math.max(0, match.index - 40), match.index);
                if (/(Add|Update|Delete) File:\s*\S*$/u.test(before)) continue;
                reads.add(id);
              }
              if (reads.size && reads.size < 6) {
                for (const id of reads) records.push({ skillId: id, explicit: false });
              }
            }
          }
          if (!inWindow) continue;
          for (const { skillId, explicit } of records) {
            // 显式调用逐次计数（autox:）；路径信号按会话计 1 次（autos:）
            if (!explicit && recorded.has(skillId)) continue;
            if (!explicit) recorded.add(skillId);
            fileRecords.push({ skillId, explicit, time, lineStart });
          }
        }
        // 跨层去重：会话内技能已有显式调用时，其路径读取信号让位（读取多半是调用的伴生动作）
        const explicitSkills = new Set(fileRecords.filter(item => item.explicit).map(item => item.skillId));
        for (const item of fileRecords) {
          if (!item.explicit && explicitSkills.has(item.skillId)) continue;
          const autoKey = item.explicit ? `autox:${file}:${item.lineStart}` : `autos:${file}:${item.skillId}`;
          if (autoKeys.has(autoKey)) continue;
          autoKeys.add(autoKey);
          this.store.uses.push({
            type: 'skill-use',
            event_id: this.eventId('USE'),
            auto_key: autoKey,
            time: item.time,
            skill_id: item.skillId,
            revision: latestRevision(this.store, item.skillId),
            skill_sha256: '',
            result: '未标结果',
            task: item.explicit ? '转录信号 · Skill 工具调用' : '转录信号 · 命令定向读取 SKILL.md（按会话每技能计 1 次，补丁写与大批量扫描不计）',
            artifact: '',
            session: sessionId.slice(0, 64),
            source: `转录自动 · ${agent}`,
          });
          agentAdded++;
        }
        if (known.size) offsets[file] = cursor; // 一张卡都没有时不推进游标：首次建卡后可全量补采，不丢空白期
      }
      added += agentAdded;
      reports.push(`${agent}:注册表 ${entries.length} 会话（${archived} 个压缩归档跳过）· 本 vault 命中 ${files.size} 个转录 · 新增 ${agentAdded} 条${config.globalScan ? '（含全局兜底）' : ''}`);
    }
    this.store.ingest.everScanned = true; // 区分「首扫限 7 天」与「回扫不限时」
    if (rescanNote) reports.push(rescanNote);
    await this.persist(); // 游标/回扫标记每次落盘，避免 refreshStore 从磁盘回读后丢状态
    return { added, reports, firstScan };
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
};

/* nosourcemap */
/* nosourcemap */