'use strict';

const state = {
  asOf: null,
  warehouseId: '',
  category: '',
  caliber: 'available',
  strategyId: '',
  batchId: '',
  strategies: [],
  analysis: null,
  timeline: null,
  view: 'analysis',
  selectedPlan: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmt(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function money(n) {
  if (n == null) return '—';
  return `¥${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}
function pct(n, d = 0) {
  if (n == null) return '—';
  return `${(Number(n) * 100).toFixed(d)}%`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function debounce(fn, ms = 250) {
  let h;
  return (...args) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------ bootstrap ------------------------------ */

async function boot() {
  const meta = await api('/api/meta');
  state.asOf = meta.demo_as_of || meta.as_of;
  $('#f-asof').value = state.asOf;
  $('#f-asof').max = meta.as_of;

  const wh = $('#f-warehouse');
  for (const w of meta.warehouses) wh.append(el('option', { value: w.id, text: `${w.name} (${w.id})` }));
  for (const c of meta.categories) $('#f-category').append(el('option', { value: c, text: c }));

  const caliberLabels = {
    available: '可用：良品 − 预留 − 过期',
    sellable: '可售：可用 − 安全库存',
    good: '良品：含过期',
    physical: '在手：含残损/过期',
  };
  for (const c of meta.calibers) {
    $('#f-caliber').append(el('option', { value: c.id, text: caliberLabels[c.id] || c.label }));
  }
  $('#f-caliber').value = state.caliber;

  state.strategies = meta.strategies;
  renderStrategySelect(meta.active_strategy?.id);
  state.strategyId = meta.active_strategy?.id || '';

  $('#strategy-pill').textContent = meta.active_strategy
    ? `当前策略：${meta.active_strategy.name} · v${meta.active_strategy.version}`
    : '无激活策略';

  wireEvents();
  await Promise.all([loadAnalysis(), loadStrategyPanel(), loadTasks(), loadLedger()]);
}

function renderStrategySelect(activeId) {
  const sel = $('#f-strategy');
  sel.textContent = '';
  for (const s of state.strategies) {
    sel.append(
      el('option', {
        value: s.id,
        text: `${s.name} · ${s.status === 'active' ? '生效中' : s.status === 'draft' ? '草稿' : '已停用'}`,
      }),
    );
  }
  sel.value = activeId || state.strategies[0]?.id || '';
}

function wireEvents() {
  $('#f-asof').addEventListener('change', () => {
    state.asOf = $('#f-asof').value;
    refreshAll();
  });
  $('#f-warehouse').addEventListener('change', () => {
    state.warehouseId = $('#f-warehouse').value;
    state.batchId = '';
    refreshAll();
  });
  $('#f-category').addEventListener('change', () => {
    state.category = $('#f-category').value;
    refreshAll();
  });
  $('#f-caliber').addEventListener('change', () => {
    state.caliber = $('#f-caliber').value;
    refreshAll();
  });
  $('#f-strategy').addEventListener('change', () => {
    state.strategyId = $('#f-strategy').value;
    refreshAll();
  });
  $('#f-batch').addEventListener('change', () => {
    state.batchId = $('#f-batch').value;
    loadTimeline();
  });
  $('#f-plan-status').addEventListener('change', loadTasks);

  $$('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      state.view = b.dataset.view;
      $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
      if (state.view === 'strategy') loadCompare();
      if (state.view === 'tasks') loadTasks();
      if (state.view === 'ledger') loadLedger();
    }),
  );

  $('#btn-close-detail').addEventListener('click', () => {
    $('#detail-card').setAttribute('hidden', '');
    state.batchId = '';
    $('#f-batch').value = '';
    loadTimeline();
  });
  $('#btn-bulk-plan').addEventListener('click', bulkPlan);
  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('重置为演示数据？现有计划与任务将被清空。')) return;
    await api('/api/admin/reset', { method: 'POST', body: { confirm: 'RESET' } });
    toast('演示数据已重置');
    await boot();
  });
}

async function refreshAll() {
  await Promise.all([loadAnalysis(), loadTasks(), loadLedger()]);
}

/* ------------------------------- analysis ------------------------------ */

function analysisQuery() {
  const p = new URLSearchParams({ as_of: state.asOf, caliber: state.caliber });
  if (state.warehouseId) p.set('warehouse_id', state.warehouseId);
  if (state.category) p.set('category', state.category);
  if (state.strategyId) p.set('strategy_id', state.strategyId);
  return p;
}

async function loadAnalysis() {
  const [analysis, timeline] = await Promise.all([
    api(`/api/analysis?${analysisQuery()}`),
    api(`/api/stock/timeline?${timelineQuery()}`),
  ]);
  state.analysis = analysis;
  state.timeline = timeline;
  renderStats();
  renderCandidates();
  renderTimeline();
  renderBatchOptions();
  if ($('#detail-card').hasAttribute('hidden') === false) {
    const cur = analysis.candidates.find((c) => c.batch_id === state.batchId);
    if (cur) openDetail(cur.batch_id);
    else $('#detail-card').setAttribute('hidden', '');
  }
}

function timelineQuery() {
  const p = new URLSearchParams({ as_of: state.asOf });
  if (state.warehouseId) p.set('warehouse_id', state.warehouseId);
  if (state.batchId) p.set('batch_id', state.batchId);
  return p;
}

async function loadTimeline() {
  state.timeline = await api(`/api/stock/timeline?${timelineQuery()}`);
  renderTimeline();
}

function renderStats() {
  const s = state.analysis.summary;
  const grid = $('#stat-grid');
  grid.textContent = '';
  const criticalShare = s.candidates ? s.critical / s.candidates : 0;
  const tiles = [
    {
      label: '呆滞候选批次',
      value: fmt(s.candidates),
      foot: `其中高风险 ${fmt(s.critical)} 个`,
      meter: criticalShare,
      meterColor: 'var(--critical)',
    },
    {
      label: `呆滞数量（${caliberShort(state.caliber)}）`,
      value: fmt(s.qty),
      foot: `口径：${state.analysis.caliber}`,
      meter: null,
    },
    {
      label: '占用资金',
      value: money(s.value),
      foot: '按批次单位成本计价',
      meter: null,
    },
    {
      label: '处置建议分布',
      value: s.by_action.length ? s.by_action[0].label : '—',
      foot: s.by_action.map((a) => `${a.label} ${a.count}`).join(' · '),
      meter: null,
    },
  ];
  for (const t of tiles) {
    const node = el('div', { class: 'stat' }, [
      el('div', { class: 'label', text: t.label }),
      el('div', { class: 'value', text: t.value }),
      el('div', { class: 'foot', text: t.foot }),
    ]);
    if (t.meter != null) {
      const fill = el('span');
      fill.style.width = `${Math.min(100, Math.round(t.meter * 100))}%`;
      fill.style.background = t.meterColor || 'var(--series-1)';
      node.append(el('div', { class: 'meter' }, [fill]));
    }
    grid.append(node);
  }
}

function caliberShort(c) {
  return { available: '可用量', sellable: '可售量', good: '良品量', physical: '在手量' }[c] || c;
}

function riskColor(level) {
  return level === 'critical' ? 'var(--critical)' : level === 'warning' ? 'var(--warning)' : 'var(--good)';
}

function renderCandidates() {
  const body = $('#cand-table tbody');
  body.textContent = '';
  const cands = state.analysis.candidates;
  $('#cand-count').textContent = `${cands.length} 条 · ${state.analysis.strategy?.name || '临时口径'}`;
  if (!cands.length) {
    body.append(el('tr', {}, [el('td', { colspan: 9 }, [el('div', { class: 'empty', text: '当前筛选下没有呆滞候选' })])]));
    return;
  }
  for (const c of cands) {
    const tr = el('tr', {
      dataset: { batch: c.batch_id },
      class: c.batch_id === state.batchId ? 'selected' : '',
    });
    tr.append(
      el('td', { class: 'batch-cell' }, [
        el('div', { class: 'code', text: c.batch_no }),
        el('div', { class: 'meta', text: `${c.sku_code} · ${c.sku_name}` }),
      ]),
      el('td', {}, [
        el('div', { text: c.warehouse_name }),
        el('div', { class: 'muted', text: c.warehouse_id }),
      ]),
      el('td', { class: 'num' }, [
        el('div', { text: fmt(c.qty) }),
        el('div', { class: 'muted', text: c.expired ? '已过期' : c.quality_hold ? '冻结' : `可用 ${fmt(c.available_qty)}` }),
      ]),
      el('td', { class: 'num', text: `${c.age_days}天` }),
      el('td', { class: 'num' }, [
        el('div', { text: `${c.residual_days}天` }),
        el('div', { class: 'muted', text: `到期 ${c.expiry_date}` }),
      ]),
      el(
        'td',
        {},
        c.causes.map((ca) =>
          el('span', { class: `tag sev-${causeSeverity(ca)}`, title: ca.evidence }, [
            el('span', { class: 'dot' }),
            ca.label,
          ]),
        ),
      ),
      el('td', {}, [actionTag(c.suggested_action)]),
      el('td', { class: 'num' }, [
        el('div', { class: 'risk' }, [
          el('span', { text: String(c.risk_score), class: 'muted' }),
          el('span', { class: 'bar' }, [
            (() => {
              const f = el('span');
              f.style.width = `${c.risk_score}%`;
              f.style.background = riskColor(c.risk_level);
              return f;
            })(),
          ]),
        ]),
      ]),
      el('td', {}, [
        el('button', {
          class: 'btn soft small',
          text: '详情',
          onclick: (e) => {
            e.stopPropagation();
            openDetail(c.batch_id);
          },
        }),
      ]),
    );
    tr.addEventListener('click', () => openDetail(c.batch_id));
    body.append(tr);
  }
}

function causeSeverity(ca) {
  if (['expired', 'quality_hold', 'dead_stock'].includes(ca.code)) return 'critical';
  if (['near_expiry', 'low_residual_ratio', 'overstock', 'slow_moving'].includes(ca.code)) return 'warning';
  if (ca.code === 'transfer_opportunity') return 'good';
  return 'serious';
}

function actionTag(action) {
  const map = {
    dispose: ['报废处置', 'critical'],
    discount: ['折价促销', 'warning'],
    transfer: ['跨仓调拨', 'serious'],
    substitute: ['替代品', 'good'],
    keep: ['维持观察', 'good'],
    return_to_supplier: ['退供应商', 'warning'],
  };
  const [label, sev] = map[action] || [action, 'good'];
  return el('span', { class: `tag solid-${sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'good'}` }, [label]);
}

function renderBatchOptions() {
  const sel = $('#f-batch');
  const all = state.batchId;
  sel.textContent = '';
  sel.append(el('option', { value: '', text: '全部批次' }));
  const seen = new Set();
  for (const c of state.analysis.candidates) {
    if (seen.has(c.batch_id)) continue;
    seen.add(c.batch_id);
    sel.append(el('option', { value: c.batch_id, text: `${c.batch_no} · ${c.warehouse_id}` }));
  }
  sel.value = state.batchId;
  if (all && !seen.has(all)) {
    // keep a stale selection from silently showing nothing
    sel.value = '';
    state.batchId = '';
  }
}

/* ------------------------------- timeline ------------------------------ */

const SERIES = [
  { key: 'available', label: '可用量', varName: '--series-1' },
  { key: 'physical', label: '在手量', varName: '--series-3' },
  { key: 'at_risk', label: '过期/冻结', varName: '--series-2' },
];

function renderTimeline() {
  const svg = $('#timeline');
  svg.textContent = '';
  const legend = $('#timeline-legend');
  legend.textContent = '';
  for (const s of SERIES) {
    legend.append(
      el('span', { class: 'item' }, [
        (() => {
          const k = el('span', { class: 'key' });
          k.style.background = `var(${s.varName})`;
          return k;
        })(),
        s.label,
      ]),
    );
  }
  const pts = state.timeline.points;
  $('#timeline-note').textContent = `${state.timeline.from} → ${state.timeline.to} · ${pts.length} 个采样点`;
  if (!pts.length) {
    svg.append(el('text', { x: 20, y: 40, fill: 'var(--text-muted)', text: '所选范围内没有库存变动' }));
    return;
  }
  const W = svg.clientWidth || 900;
  const H = 300;
  const pad = { l: 52, r: 18, t: 16, b: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const maxY = Math.max(1, ...pts.map((p) => Math.max(p.physical, p.available, p.at_risk)));
  const niceMax = niceCeil(maxY);
  const x = (i) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / niceMax) * ih;

  // grid + y ticks
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = (niceMax / ticks) * i;
    const yy = y(v);
    svg.append(
      el('line', {
        x1: pad.l,
        x2: pad.l + iw,
        y1: yy,
        y2: yy,
        stroke: 'var(--grid)',
        'stroke-width': 1,
      }),
    );
    svg.append(
      el('text', {
        x: pad.l - 10,
        y: yy + 4,
        'text-anchor': 'end',
        'font-size': 11,
        fill: 'var(--text-muted)',
        text: compact(v),
      }),
    );
  }
  // baseline
  svg.append(
    el('line', {
      x1: pad.l,
      x2: pad.l + iw,
      y1: pad.t + ih,
      y2: pad.t + ih,
      stroke: 'var(--axis)',
      'stroke-width': 1,
    }),
  );

  // x labels: first, middle, last
  const xIdx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  for (const i of xIdx) {
    svg.append(
      el('text', {
        x: x(i),
        y: H - 12,
        'text-anchor': i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle',
        'font-size': 11,
        fill: 'var(--text-muted)',
        text: pts[i].date.slice(5),
      }),
    );
  }

  // area + line for available, line for others
  const pathFor = (key) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p[key])}`).join(' ');
  const areaFor = (key) =>
    `${pathFor(key)} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="availFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--series-1)" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="var(--series-1)" stop-opacity="0.01"/>
    </linearGradient>`;
  svg.append(defs);

  svg.append(
    el('path', { d: areaFor('available'), fill: 'url(#availFill)', stroke: 'none' }),
  );
  for (const s of SERIES) {
    svg.append(
      el('path', {
        d: pathFor(s.key),
        fill: 'none',
        stroke: `var(${s.varName})`,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }

  // end markers with surface ring
  for (const s of SERIES) {
    const last = pts[pts.length - 1];
    svg.append(
      el('circle', {
        cx: x(pts.length - 1),
        cy: y(last[s.key]),
        r: 4,
        fill: `var(${s.varName})`,
        stroke: 'var(--surface-1)',
        'stroke-width': 2,
      }),
    );
  }

  // crosshair + hover layer
  const cross = el('line', {
    x1: 0,
    x2: 0,
    y1: pad.t,
    y2: pad.t + ih,
    stroke: 'var(--axis)',
    'stroke-width': 1,
    opacity: 0,
  });
  svg.append(cross);
  const hit = el('rect', {
    x: pad.l,
    y: pad.t,
    width: iw,
    height: ih,
    fill: 'transparent',
    style: 'cursor: crosshair',
  });
  svg.append(hit);
  const tip = $('#timeline-tip');

  const onMove = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const t = Math.min(1, Math.max(0, (px - pad.l) / iw));
    const idx = Math.round(t * (pts.length - 1));
    const p = pts[idx];
    cross.setAttribute('x1', x(idx));
    cross.setAttribute('x2', x(idx));
    cross.setAttribute('opacity', 1);
    tip.textContent = '';
    tip.append(el('div', { class: 't-date', text: p.date }));
    for (const s of SERIES) {
      const row = el('div', { class: 't-row' }, [
        el('span', {}, [
          (() => {
            const k = el('span', { class: 't-key' });
            k.style.background = `var(${s.varName})`;
            return k;
          })(),
          s.label,
        ]),
        el('b', { text: fmt(p[s.key]) }),
      ]);
      tip.append(row);
    }
    tip.classList.add('show');
    const left = (x(idx) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 80, Math.max(80, left))}px`;
    tip.style.top = `${Math.max(40, (y(p.available) / H) * rect.height - 14)}px`;
  };
  hit.addEventListener('pointermove', onMove);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', 0);
    tip.classList.remove('show');
  });
}

function niceCeil(v) {
  if (v <= 10) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}
function compact(v) {
  if (v >= 10000) return `${Math.round(v / 1000)}K`;
  return fmt(v);
}

/* -------------------------------- detail ------------------------------- */

function openDetail(batchId) {
  state.batchId = batchId;
  $('#f-batch').value = batchId;
  const c = state.analysis.candidates.find((x) => x.batch_id === batchId);
  if (!c) return;
  $$('#cand-table tbody tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.batch === batchId),
  );
  const card = $('#detail-card');
  card.removeAttribute('hidden');
  $('#detail-title').textContent = `${c.batch_no} · ${c.warehouse_name}`;
  const body = $('#detail-body');
  body.textContent = '';

  body.append(
    el('div', { class: 'row-card' }, [
      el('div', { class: 'top' }, [
        el('h3', { text: `${c.sku_code} · ${c.sku_name}` }),
        actionTag(c.suggested_action),
      ]),
      el('div', { class: 'kv' }, [
        kv('数量', `${fmt(c.qty)} (${c.caliber})`),
        kv('在手/良品', `${fmt(c.physical_qty)} / ${fmt(c.good_qty)}`),
        kv('可用/可售', `${fmt(c.available_qty)} / ${fmt(c.sellable_qty)}`),
        kv('预留', fmt(c.reserved_qty)),
        kv('库龄', `${c.age_days} 天`),
        kv('剩余保质', `${c.residual_days} 天 (${pct(c.residual_ratio)}）`),
        kv('日均销量', fmt(c.daily_velocity, 2)),
        kv('可售天数', c.days_cover == null ? '无动销' : `${fmt(c.days_cover, 1)} 天`),
        kv('占用资金', money(c.stock_value)),
        kv('批次入库', c.inbound_date),
      ]),
    ]),
  );

  const causeCard = el('div', { class: 'row-card' }, [el('h3', { text: '候选原因（可解释）' })]);
  const causeList = el('div', { class: 'stack' });
  for (const ca of c.causes.slice().sort((a, b) => b.weight - a.weight)) {
    causeList.append(
      el('div', { class: 'callout ' + (causeSeverity(ca) === 'critical' ? 'critical' : causeSeverity(ca) === 'good' ? 'info' : '') }, [
        el('strong', { text: `${ca.label} ` }),
        el('span', { class: 'muted', text: `权重 ${ca.weight}` }),
        el('div', { text: ca.evidence }),
      ]),
    );
  }
  causeCard.append(causeList);
  body.append(causeCard);

  const altCard = el('div', { class: 'row-card' }, [
    el('h3', { text: '替代方案' }),
    el('div', { class: 'muted', text: '按可达性打分：调拨 > 替代品 > 折价 > 报废。选择后进入审批流。' }),
  ]);
  const altList = el('div', { class: 'stack' });
  for (const alt of c.alternatives) {
    const planBtn = el('button', {
      class: 'btn soft small',
      text: '创建计划',
      onclick: () => createPlanFor(c, alt),
    });
    altList.append(
      el('div', { class: 'row-card' }, [
        el('div', { class: 'top' }, [
          el('div', {}, [
            el('strong', { text: alt.label }),
            el('div', { class: 'muted', text: alt.rationale }),
          ]),
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
            el('span', { class: 'tag', text: `建议量 ${fmt(alt.qty)}` }),
            planBtn,
          ]),
        ]),
      ]),
    );
  }
  altCard.append(altList);
  body.append(altCard);

  const actions = el('div', { class: 'form-actions' }, [
    el('button', {
      class: 'btn',
      text: `按建议创建「${actionLabel(c.suggested_action)}」计划`,
      onclick: () => createPlanFor(c, { action: c.suggested_action, qty: c.qty, warehouse_id: c.transfer_target?.warehouse_id }),
    }),
    el('button', {
      class: 'btn ghost',
      text: '查看该批次时间线',
      onclick: () => {
        state.batchId = c.batch_id;
        $('#f-batch').value = c.batch_id;
        loadTimeline();
        $('#view-analysis .card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
    }),
  ]);
  body.append(actions);
}

function kv(label, value) {
  return el('div', {}, [el('span', { text: label }), el('b', { text: value })]);
}
function actionLabel(a) {
  return (
    { dispose: '报废处置', discount: '折价促销', transfer: '跨仓调拨', substitute: '替代品合并', keep: '维持观察', return_to_supplier: '退供应商' }[a] || a
  );
}

async function createPlanFor(c, alt) {
  const action = alt.action;
  if (action === 'keep') {
    toast('维持观察无需创建任务');
    return;
  }
  const body = {
    batch_id: c.batch_id,
    action,
    qty: Math.min(alt.qty || c.qty, c.qty || c.physical_qty),
    causes: c.causes.map((x) => x.code),
    rationale: alt.rationale || c.primary_cause,
    strategy_id: state.analysis.strategy?.id || undefined,
    to_warehouse: action === 'transfer' ? alt.warehouse_id || c.transfer_target?.warehouse_id : undefined,
    actor: 'planner',
  };
  try {
    const plan = await api('/api/plans', { method: 'POST', body });
    toast(`已创建计划 ${plan.id}，等待审批`);
    await loadTasks();
    $$('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === 'tasks'));
    state.view = 'tasks';
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-tasks'));
    loadTasks();
  } catch (e) {
    toast(`创建失败：${e.message}`);
  }
}

async function bulkPlan() {
  const cands = state.analysis.candidates.filter((c) => c.suggested_action !== 'keep');
  if (!cands.length) return toast('没有可计划的候选');
  if (!confirm(`将 ${cands.length} 个候选按建议生成计划并提交审批？`)) return;
  const items = cands.map((c) => ({
    batch_id: c.batch_id,
    action: c.suggested_action,
    qty: c.qty,
    rationale: c.primary_cause,
    to_warehouse: c.suggested_action === 'transfer' ? c.transfer_target?.warehouse_id : undefined,
  }));
  const res = await api('/api/plans/bulk', {
    method: 'POST',
    body: { items, strategy_id: state.analysis.strategy?.id, actor: 'planner' },
  });
  toast(`已创建 ${res.created.length} 个计划${res.errors.length ? `，${res.errors.length} 个失败` : ''}`);
  await loadTasks();
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === 'tasks'));
  state.view = 'tasks';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-tasks'));
}

/* ------------------------------- strategy ------------------------------ */

const PARAM_FIELDS = [
  ['caliber', '可用量口径'],
  ['staleDays', '滞销天数'],
  ['deadStockDays', '呆滞天数'],
  ['nearExpiryDays', '临期天数'],
  ['nearExpiryRatio', '剩余货架期占比'],
  ['slowMovingCoverDays', '周转覆盖天数'],
  ['concentrationRatio', '集中度阈值'],
  ['minBatchQty', '最小批次量'],
  ['forecastHorizonDays', '预测窗口'],
];

async function loadStrategyPanel() {
  const data = await api('/api/strategies');
  state.strategies = data.strategies;
  renderStrategySelect($('#f-strategy').value || data.strategies.find((s) => s.status === 'active')?.id);
  renderStrategyList(data);
  renderStrategyForm(data.defaults);
  await loadCompare();
}

function renderStrategyList(data) {
  const wrap = $('#strategy-list');
  wrap.textContent = '';
  for (const s of data.strategies) {
    const isActive = s.status === 'active';
    wrap.append(
      el('div', { class: 'row-card' }, [
        el('div', { class: 'top' }, [
          el('div', {}, [
            el('strong', { text: s.name }),
            el('div', { class: 'muted', text: `v${s.version} · ${s.id}` }),
          ]),
          el('div', { style: 'display:flex;gap:8px;align-items:center' }, [
            el('span', {
              class: `tag solid-${isActive ? 'good' : s.status === 'draft' ? 'warning' : 'critical'}`,
              text: isActive ? '生效中' : s.status === 'draft' ? '草稿' : '已停用',
            }),
            el('button', {
              class: 'btn soft small',
              text: '预览影响',
              onclick: () => previewStrategy(s.id),
            }),
            el('button', {
              class: 'btn small',
              text: isActive ? '已生效' : '激活',
              disabled: isActive ? 'disabled' : null,
              onclick: () => activateStrategy(s.id),
            }),
          ]),
        ]),
        el(
          'div',
          { class: 'statline' },
          Object.entries(s.params)
            .filter(([k]) => PARAM_FIELDS.some((f) => f[0] === k))
            .map(([k, v]) => el('span', {}, [el('span', { text: `${paramLabel(k)} ` }), el('b', { text: String(v) })])),
        ),
      ]),
    );
  }
  if (data.migrations.length) {
    const m = data.migrations[0];
    wrap.append(
      el('div', { class: 'callout info' }, [
        el('strong', { text: '最近一次策略迁移 ' }),
        el('span', { text: `${m.summary.from?.name || '—'} → ${m.summary.to?.name} · ${m.as_of}` }),
      ]),
    );
  }
}

function paramLabel(k) {
  return (PARAM_FIELDS.find((f) => f[0] === k) || [, k])[1];
}

function renderStrategyForm(defaults) {
  const form = $('#strategy-form');
  form.textContent = '';
  for (const [key, label] of PARAM_FIELDS) {
    const input =
      key === 'caliber'
        ? el(
            'select',
            { name: key },
            ['available', 'sellable', 'good', 'physical'].map((c) =>
              el('option', { value: c, text: c, selected: defaults[key] === c ? 'selected' : null }),
            ),
          )
        : el('input', {
            type: 'number',
            name: key,
            step: key === 'nearExpiryRatio' || key === 'concentrationRatio' ? '0.05' : '1',
            value: defaults[key],
          });
    form.append(el('label', { class: 'field' }, [el('span', { text: label }), input]));
  }
  form.append(
    el('div', { class: 'form-actions' }, [
      el('button', { class: 'btn', type: 'button', text: '保存为草稿版本', onclick: createStrategyFromForm }),
    ]),
  );
}

async function createStrategyFromForm() {
  const form = $('#strategy-form');
  const params = {};
  for (const [key] of PARAM_FIELDS) {
    const node = form.elements[key];
    params[key] = key === 'caliber' ? node.value : Number(node.value);
  }
  try {
    const s = await api('/api/strategies', {
      method: 'POST',
      body: { name: `自定义策略 v${state.strategies.length + 1}`, params, actor: 'planner' },
    });
    toast(`已创建草稿 ${s.name}`);
    await loadStrategyPanel();
  } catch (e) {
    toast(`创建失败：${e.message}`);
  }
}

async function previewStrategy(id) {
  const data = await api(`/api/analysis/compare?to=${id}&as_of=${state.asOf}`);
  renderCompare(data);
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === 'strategy'));
  state.view = 'strategy';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-strategy'));
}

async function loadCompare() {
  // Default to the most recent non-active strategy, so the panel always shows a
  // real switch candidate rather than re-previewing the active one.
  const candidates = state.strategies.filter((s) => s.id !== activeStrategyId());
  const target =
    candidates.find((s) => s.status === 'draft') || candidates[0] || state.strategies[0];
  if (!target) return;
  try {
    const data = await api(`/api/analysis/compare?to=${target.id}&as_of=${state.asOf}`);
    renderCompare(data, true);
  } catch (e) {
    $('#compare-body').textContent = e.message;
  }
}

function activeStrategyId() {
  return state.strategies.find((s) => s.status === 'active')?.id;
}

function renderCompare(d, passive = false) {
  const body = $('#compare-body');
  body.textContent = '';
  $('#compare-hint').textContent = `${passive ? '自动预览' : '预览'}：${d.from?.name || '—'} → ${d.to.name}`;

  const risk = d.stockout_impact;
  if (risk.at_risk.length) {
    const list = el('div', { class: 'stack' });
    for (const r of risk.at_risk.slice(0, 6)) {
      list.append(
        el('div', { class: 'callout ' + (r.severity === 'critical' ? 'critical' : '') }, [
          el('strong', { text: `${r.sku_code} @ ${r.warehouse_id} 缺口 ${fmt(r.projected_shortfall)}` }),
          el('div', { text: `${r.note}：预测需求 ${fmt(r.projected_demand)}，处理后供给 ${fmt(r.supply_after)}（其它批次 ${fmt(r.other_supply)}）` }),
        ]),
      );
    }
    body.append(
      el('div', { class: 'row-card' }, [
        el('div', { class: 'top' }, [
          el('h3', { text: '潜在缺货影响' }),
          el('span', { class: 'tag solid-critical', text: `合计缺口 ${fmt(risk.total_projected_shortfall)}` }),
        ]),
        el('div', { class: 'muted', text: `预测窗口 ${risk.horizon_days} 天，处置量 ${fmt(risk.disposal_qty)}` }),
        list,
      ]),
    );
  } else {
    body.append(el('div', { class: 'callout info', text: '该策略切换在预测窗口内不会造成缺货。' }));
  }

  body.append(
    el('div', { class: 'row-card' }, [
      el('h3', { text: '呆滞名单迁移' }),
      el('div', { class: 'statline' }, [
        el('span', {}, [el('span', { class: 'diff-add', text: '新增 ' }), el('b', { text: fmt(d.migration.summary.added) })]),
        el('span', {}, [el('span', { class: 'diff-remove', text: '移出 ' }), el('b', { text: fmt(d.migration.summary.removed) })]),
        el('span', {}, [el('span', { text: '动作变化 ' }), el('b', { text: fmt(d.migration.summary.changed) })]),
        el('span', {}, [el('span', { text: '金额变化 ' }), el('b', { text: money(d.migration.summary.value_delta) })]),
      ]),
      el('div', { class: 'statline' }, [
        el('span', {}, [el('span', { text: '切换前 ' }), el('b', { text: `${fmt(d.before.candidates)} 批次 / ${money(d.before.value)}` })]),
        el('span', {}, [el('span', { text: '切换后 ' }), el('b', { text: `${fmt(d.after.candidates)} 批次 / ${money(d.after.value)}` })]),
      ]),
    ]),
  );

  const list = el('div', { class: 'stack' });
  const rows = [
    ...d.migration.added.map((c) => ['新增', c, false]),
    ...d.migration.removed.map((c) => ['移出', c, true]),
    ...d.migration.changed.map((c) => ['动作变化', c, false]),
  ];
  if (!rows.length) {
    list.append(el('div', { class: 'muted', text: '名单与动作无变化。' }));
  }
  for (const [kind, c, removed] of rows.slice(0, 14)) {
    list.append(
      el('div', { class: 'row-card' }, [
        el('div', { class: 'top' }, [
          el('div', {}, [
            el('strong', { text: `${c.batch_no} · ${c.warehouse_id}` }),
            el('div', { class: 'muted', text: `${c.sku_code} · ${fmt(c.qty)} · ${c.causes.map((x) => x.label).join('、')}` }),
          ]),
          el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
            el('span', { class: `tag ${removed ? 'solid-critical' : kind === '新增' ? 'solid-warning' : 'solid-good'}`, text: kind }),
            actionTag(c.suggested_action),
          ]),
        ]),
      ]),
    );
  }
  const migCard = el('div', { class: 'row-card' }, [el('h3', { text: '迁移明细' })]);
  migCard.append(list);
  body.append(migCard);

  body.append(
    el('div', { class: 'form-actions' }, [
      el('button', {
        class: 'btn',
        text: `确认并激活 ${d.to.name}`,
        onclick: () => confirmActivate(d),
      }),
    ]),
  );
}

async function confirmActivate(d) {
  const needsAck = d.migration.requires_acknowledgement;
  if (
    needsAck &&
    !confirm(
      `此切换会迁移 ${d.migration.summary.added} 个新增 / ${d.migration.summary.removed} 个移出候选，并可能造成 ${fmt(d.stockout_impact.total_projected_shortfall)} 的缺货缺口。确认继续？`,
    )
  )
    return;
  try {
    const res = await api(`/api/strategies/${d.to.id}/activate`, {
      method: 'POST',
      body: { as_of: state.asOf, confirm: true, migration_acknowledged: true, actor: 'planner' },
    });
    toast(`策略 ${res.strategy.name} 已激活并记录迁移`);
    state.strategyId = res.strategy.id;
    $('#strategy-pill').textContent = `当前策略：${res.strategy.name} · v${res.strategy.version}`;
    await loadStrategyPanel();
    await loadAnalysis();
  } catch (e) {
    toast(`激活失败：${e.message}`);
  }
}

async function activateStrategy(id) {
  const d = await api(`/api/analysis/compare?to=${id}&as_of=${state.asOf}`);
  renderCompare(d);
  $$('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === 'strategy'));
  state.view = 'strategy';
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-strategy'));
}

/* --------------------------------- tasks ------------------------------- */

async function loadTasks() {
  const status = $('#f-plan-status')?.value || '';
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  const [{ plans: planList }, { tasks }] = await Promise.all([
    api(`/api/plans?${q}`),
    api('/api/tasks'),
  ]);
  renderPlans(planList, tasks);
}

function renderPlans(planList, tasks) {
  const wrap = $('#plan-list');
  wrap.textContent = '';
  if (!planList.length) {
    wrap.append(el('div', { class: 'empty', text: '暂无处置计划。可在“呆滞分析”中创建。' }));
    return;
  }
  const byPlan = new Map();
  for (const t of tasks) {
    if (!byPlan.has(t.plan_id)) byPlan.set(t.plan_id, []);
    byPlan.get(t.plan_id).push(t);
  }
  for (const p of planList) {
    const planTasks = byPlan.get(p.id) || [];
    const statusTag = {
      pending_approval: ['待审批', 'warning'],
      approved: ['已审批', 'good'],
      executed: ['已执行', 'good'],
      rejected: ['已驳回', 'critical'],
      rolled_back: ['已回滚', 'serious'],
      cancelled: ['已取消', 'critical'],
    }[p.status] || [p.status, 'good'];
    const card = el('div', { class: 'row-card' });
    card.append(
      el('div', { class: 'top' }, [
        el('div', {}, [
          el('strong', { text: `${p.batch_no} · ${actionLabel(p.action)}` }),
          el('div', { class: 'muted', text: `${p.sku_code} ${p.sku_name} · ${p.warehouse_name}${p.to_warehouse ? ` → ${p.to_warehouse}` : ''} · 计划量 ${fmt(p.qty)}` }),
        ]),
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
          el('span', { class: `tag solid-${statusTag[1]}`, text: statusTag[0] }),
          p.status === 'pending_approval'
            ? el('button', { class: 'btn small', text: '批准', onclick: () => approve(p.id) })
            : null,
          p.status === 'pending_approval'
            ? el('button', { class: 'btn ghost small', text: '驳回', onclick: () => rejectPlan(p.id) })
            : null,
          ['pending_approval', 'approved'].includes(p.status)
            ? el('button', { class: 'btn ghost small', text: '取消', onclick: () => cancelPlan(p.id) })
            : null,
        ]),
      ]),
    );
    if (p.causes.length) {
      card.append(el('div', { class: 'statline' }, [el('span', { text: '原因：' + p.causes.join('、') })]));
    }
    if (p.rationale) card.append(el('div', { class: 'muted', text: `依据：${p.rationale}` }));

    if (planTasks.length) {
      const tl = el('div', { class: 'stack' });
      for (const t of planTasks) {
        tl.append(renderTask(t));
      }
      card.append(tl);
    }
    wrap.append(card);
  }
}

function renderTask(t) {
  const box = el('div', { class: 'row-card', style: 'background:var(--surface-1)' });
  box.append(
    el('div', { class: 'top' }, [
      el('div', {}, [
        el('strong', { text: `${t.kind} · 当前 v${t.current_version}` }),
        el('span', { class: 'muted mono', text: ` ${t.id}` }),
      ]),
      el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
        el('span', { class: `tag solid-${t.status === 'executed' ? 'good' : t.status === 'rolled_back' ? 'critical' : 'warning'}`, text: taskStatusLabel(t.status) }),
        t.status === 'ready'
          ? el('button', { class: 'btn soft small', text: '修订', onclick: () => reviseTask(t) })
          : null,
        t.status === 'ready'
          ? el('button', { class: 'btn small', text: '执行', onclick: () => executeTaskFlow(t) })
          : null,
        t.status === 'executed'
          ? el('button', { class: 'btn ghost small', text: '回滚', onclick: () => rollbackFlow(t) })
          : null,
      ]),
    ]),
  );
  const versions = el('div', { class: 'version-line' });
  for (const v of t.versions) {
    versions.append(
      el('span', {
        class: `version-goto ${v.version === t.current_version ? 'current' : ''}`,
        title: `${v.status}${v.superseded_at ? ' · 已被替代' : ''}`,
        text: `v${v.version} ${versionStatusLabel(v.status)} · ${fmt(v.payload.qty)}`,
      }),
    );
  }
  box.append(versions);
  const latest = t.versions[t.versions.length - 1];
  if (latest?.result?.movements?.length) {
    box.append(
      el('div', { class: 'muted mono', text: `分录：${latest.result.movements.join(', ')}` }),
    );
  }
  if (latest?.result?.rolled_back) {
    box.append(el('div', { class: 'callout critical', text: `已回滚：${latest.result.rollback_reason || '无原因'} · ${latest.result.rollback_movements?.join(', ') || ''}` }));
  }
  return box;
}

function taskStatusLabel(s) {
  return { ready: '待执行', executed: '已执行', rolled_back: '已回滚', cancelled: '已取消' }[s] || s;
}
function versionStatusLabel(s) {
  return { ready: '待执行', executed: '已执行', superseded: '被替代', rolled_back: '已回滚', cancelled: '已取消' }[s] || s;
}

async function approve(id) {
  try {
    await api(`/api/plans/${id}/approve`, { method: 'POST', body: { actor: 'approver', decision: 'approve' } });
    toast('已批准，生成版本化任务');
    await loadTasks();
  } catch (e) {
    toast(`审批失败：${e.message}`);
  }
}
async function rejectPlan(id) {
  const note = prompt('驳回原因（可选）') || '';
  await api(`/api/plans/${id}/approve`, { method: 'POST', body: { actor: 'approver', decision: 'reject', note } });
  toast('已驳回');
  await loadTasks();
}
async function cancelPlan(id) {
  await api(`/api/plans/${id}/cancel`, { method: 'POST', body: { actor: 'planner' } });
  toast('已取消');
  await loadTasks();
}

async function reviseTask(t) {
  const qty = prompt(`修订数量（当前 ${t.qty}）`, String(t.qty));
  if (qty == null) return;
  const reason = prompt('修订原因', '盘点调整') || '';
  try {
    await api(`/api/tasks/${t.id}/revise`, {
      method: 'POST',
      body: { qty: Number(qty), reason, actor: 'planner' },
    });
    toast('已生成新版本，旧版本标记为被替代');
    await loadTasks();
  } catch (e) {
    toast(`修订失败：${e.message}`);
  }
}

async function executeTaskFlow(t) {
  const preview = await api(`/api/tasks/${t.id}/execute`, {
    method: 'POST',
    body: { actor: 'operator', as_of: state.asOf },
  });
  const pv = preview.preview;
  if (pv.blockers.length) {
    toast(`无法执行：${pv.blockers.join('；')}`);
    return;
  }
  const eff = pv.effects.map((e) => `${e.warehouse_id} ${e.delta > 0 ? '+' : ''}${e.delta}`).join('，');
  if (!confirm(`执行 v${pv.version}（${actionLabel(pv.action)} ${fmt(pv.qty)}）？\n影响：${eff}`)) return;
  try {
    const r = await api(`/api/tasks/${t.id}/execute`, {
      method: 'POST',
      body: { actor: 'operator', as_of: state.asOf, confirm: true },
    });
    toast(`已执行 v${r.task.current_version}`);
    await Promise.all([loadTasks(), loadAnalysis()]);
  } catch (e) {
    toast(`执行失败：${e.message}`);
  }
}

async function rollbackFlow(t) {
  const preview = await api(`/api/tasks/${t.id}/rollback`, {
    method: 'POST',
    body: { actor: 'operator', as_of: state.asOf },
  });
  const pv = preview.preview;
  let force = false;
  let reason = '';
  if (pv.blockers.length) {
    reason = prompt(`回滚存在阻断：\n- ${pv.blockers.join('\n- ')}\n\n输入原因以强制回滚（仅策略性阻断可豁免）：`) || '';
    if (!reason) return;
    force = true;
  } else if (!confirm(`回滚 v${pv.version}？`)) {
    return;
  }
  try {
    const r = await api(`/api/tasks/${t.id}/rollback`, {
      method: 'POST',
      body: { actor: 'operator', as_of: state.asOf, confirm: true, force, reason },
    });
    toast(`已回滚 v${r.preview.version}`);
    await Promise.all([loadTasks(), loadAnalysis()]);
  } catch (e) {
    toast(`回滚失败：${e.message}`);
  }
}

/* -------------------------------- ledger ------------------------------- */

async function loadLedger() {
  const [late, logs, audit] = await Promise.all([
    api(`/api/stock/late-sales?as_of=${state.asOf}`),
    api('/api/ingestion-log?limit=40'),
    api('/api/audit?limit=40'),
  ]);
  renderLateSales(late.sales);
  renderLog(logs.entries, $('#ingest-log'), (e) => [
    `${e.received_at.slice(11, 19)} · ${e.kind}`,
    e.external_ref,
    e.decision,
    e.detail ? e.detail.slice(0, 90) : '',
  ]);
  renderLog(audit.entries, $('#audit-log'), (e) => [
    `${e.ts.slice(5, 19).replace('T', ' ')} · ${e.actor}`,
    e.action,
    `${e.entity}:${e.entity_id}`,
    e.detail ? e.detail.slice(0, 110) : '',
  ]);
}

function renderLateSales(sales) {
  const wrap = $('#late-sales');
  wrap.textContent = '';
  if (!sales.length) {
    wrap.append(el('div', { class: 'empty', text: '没有迟到销售。' }));
    return;
  }
  for (const s of sales) {
    const card = el('div', { class: 'row-card' });
    card.append(
      el('div', { class: 'top' }, [
        el('div', {}, [
          el('strong', { text: `${s.sale_id} · ${s.sku_id}` }),
          el('div', { class: 'muted', text: `${s.warehouse_id} · 业务日 ${s.business_date} · 回传滞后 ${s.lag_days} 天` }),
        ]),
        el('div', { style: 'display:flex;gap:6px;align-items:center' }, [
          el('span', { class: 'tag solid-warning', text: '迟到' }),
          el('span', { class: 'tag', text: `扣减 ${fmt(s.qty)}` }),
          s.short_qty > 0 ? el('span', { class: 'tag solid-critical', text: `缺口 ${fmt(s.short_qty)}` }) : null,
        ]),
      ]),
    );
    const rows = el('div', { class: 'stack small' });
    for (const m of s.movements) {
      rows.append(
        el('div', { class: 'version-line' }, [
          el('span', { class: 'mono', text: m.external_ref }),
          el('span', { class: 'muted', text: `${m.batch_no} · 入账 ${m.business_date}` }),
          el('b', { text: fmt(m.qty) }),
        ]),
      );
    }
    card.append(rows);
    const ok = s.deducted_qty === s.allocated_qty;
    card.append(
      el('div', { class: `callout ${ok ? 'info' : 'critical'}` }, [
        ok
          ? `已入账 ${s.movements.length} 条分录，合计扣减 ${fmt(s.deducted_qty)}，与其分配量一致（幂等，重复回传不再扣减）。`
          : `分录扣减 ${fmt(s.deducted_qty)} 与分配量 ${fmt(s.allocated_qty)} 不一致，请核查。`,
      ]),
    );
    wrap.append(card);
  }
}

function renderLog(entries, wrap, mapper) {
  wrap.textContent = '';
  if (!entries.length) {
    wrap.append(el('div', { class: 'empty', text: '暂无记录' }));
    return;
  }
  for (const e of entries) {
    const [a, b, c, d] = mapper(e);
    wrap.append(
      el('div', { class: 'version-line' }, [
        el('span', { class: 'muted', text: a }),
        el('span', { text: b }),
        el('span', { class: 'tag', text: c }),
        el('span', { class: 'muted mono', text: d || '' }),
      ]),
    );
  }
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    console.error(e);
    toast(`初始化失败：${e.message}`);
  });
});
