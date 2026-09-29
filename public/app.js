'use strict';

let state = null;
let filter = 'all';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SPECIES = { dog: '犬', cat: '猫', other: '其他' };
const SOURCE_LABEL = { seed: '内置', manual: '新登记', import: '旧表导入' };
const EVENT_LABEL = {
  applied: '申请预约',
  waitlisted: '进入候补',
  promoted: '候补递补为有效预约',
  promoted_blocked: '候补递补但动物未达标 → 待复诊',
  blocked: '体检/疫苗不达标 → 转待复诊',
  cancelled: '取消预约',
  confirmed: '确认领养',
  waitlist_closed: '名额已确认，候补关闭',
  check_added: '登记体检',
  vaccine_added: '补打疫苗',
  review_passed: '复核通过，恢复预约',
  review_failed: '复核未通过',
  imported: '导入旧表',
  adopter_created: '新增领养人',
  animal_created: '新增动物',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function tagClass(status) {
  return { open: 'tag-open', pending_review: 'tag-block', waiting: 'tag-wait', confirmed: 'tag-done', cancelled: 'tag-dead' }[status] || 'tag-wait';
}
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `请求失败（${r.status}）`);
      err.payload = data;
      throw err;
    }
    return data;
  });
}

// ---------------------------------------------------------------- 数据加载

async function refresh() {
  const r = await fetch('/api/state');
  state = await r.json();
  render();
}
async function refreshSilent() {
  try { await refresh(); } catch { /* 忽略轮询错误 */ }
}

// ---------------------------------------------------------------- 渲染

function render() {
  $('#topSub').textContent = `今天 ${state.today} ｜ 数据保存在服务器文件中，重启后继续使用 ｜ ${state.animals.length} 只动物 · ${state.adopters.length} 位领养人`;
  renderAnimals();
  renderAppointments();
  renderRecords();
  renderEvents();
}

function animalMatches(a) {
  switch (filter) {
    case 'open-ok': return a.eligibility.ok && !a.active && a.status !== 'adopted';
    case 'booked': return a.active?.status === 'open';
    case 'review': return a.active?.status === 'pending_review';
    case 'blocked': {
      // 未达标且当前不是待复诊（待复诊有专属页签）：隔离中、缺体检/疫苗
      if (a.eligibility.reasons.includes('已被领养')) return false;
      if (a.active?.status === 'pending_review') return false;
      return !a.eligibility.ok;
    }
    case 'waiting': return a.waiting.length > 0;
    case 'adopted': return !a.eligibility.ok && a.eligibility.reasons.includes('已被领养');
    default: return true;
  }
}

function renderAnimals() {
  const grid = $('#animalGrid');
  const list = state.animals.filter(animalMatches);
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">没有符合该筛选的动物</div>`;
    return;
  }
  grid.innerHTML = list.map(cardHTML).join('');
}

function cardHTML(a) {
  const adopted = a.active?.status === 'confirmed' || a.eligibility.reasons.includes('已被领养');
  const review = a.active?.status === 'pending_review';
  const booked = a.active?.status === 'open';
  const cls = adopted ? 'is-adopted' : review ? 'is-review' : (!a.eligibility.ok ? 'is-blocked' : booked ? 'is-open' : '');

  const importTag = a.source === 'import' ? `<span class="tag tag-import">旧表导入</span>` : '';
  const stateTag = adopted
    ? `<span class="tag tag-done">已领养</span>`
    : review
      ? `<span class="tag tag-block">待复诊</span>`
      : booked
        ? `<span class="tag tag-open">已排预约</span>`
        : a.waiting.length
          ? `<span class="tag tag-wait">候补中 ×${a.waiting.length}</span>`
          : a.eligibility.ok
            ? `<span class="tag tag-open">可申请</span>`
            : `<span class="tag tag-block">未开放</span>`;

  const arrival = parseDay(a.arrivedAt);
  const elapsed = arrival ? Math.floor((new Date(state.now) - arrival) / 86400000) : '?';

  const reasons = a.eligibility.ok
    ? `<div class="reasons ok">✓ 隔离期满 · 近 7 天体检正常 · 疫苗齐全，满足开放条件</div>`
    : `<div class="reasons"><b>阻塞原因：</b><ul>${a.eligibility.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;

  return `
  <article class="card ${cls}" data-id="${a.id}">
    <div class="card-head">
      <div class="card-title">
        <h3>${esc(a.name)}</h3>
        <span class="species">${SPECIES[a.species] || a.species} · ${esc(a.id)}</span>
      </div>
      <div class="tags">${importTag}${stateTag}</div>
    </div>
    <div class="card-meta">到店 ${esc(a.arrivedAt)}（第 ${elapsed} 天，隔离要求 ${a.isolationDays} 天）</div>
    ${reasons}
    ${activeBoxHTML(a)}
    ${waitlistHTML(a)}
    ${miniRecordsHTML(a)}
    <div class="card-actions">${cardActionsHTML(a)}</div>
  </article>`;
}

function parseDay(s) {
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d) ? null : d;
}

function activeBoxHTML(a) {
  if (!a.active) return '';
  const p = a.active;
  const tone = p.status === 'pending_review' ? '待复诊 · 动物不能领走' : '当前有效预约';
  const src = p.source === 'import' ? '<span class="tag tag-import">旧表</span>' : '';
  return `
  <div class="appt-box">
    <div class="appt-row">
      <div><span class="appt-who">${esc(p.adopterName)}</span>
        <span class="appt-seq">#${p.seq} · ${esc(p.adopterPhone) || '无电话'}</span> ${src}
      </div>
      <span class="tag ${tagClass(p.status)}">${p.statusLabel}</span>
    </div>
    <div class="appt-row hint">${tone} · 登记于 ${fmtTime(p.registeredAt)}</div>
  </div>`;
}

function waitlistHTML(a) {
  if (!a.waiting.length) return '';
  return `
  <div class="waitlist">
    <b>候补队列（按登记顺序，取消/确认后自动递补）：</b>
    <ol>
      ${a.waiting.map((p) => `
        <li>
          <span>${esc(p.adopterName)} <span class="appt-seq">#${p.seq}${p.source === 'import' ? ' · 旧表' : ''}</span></span>
          <button class="btn btn-sm btn-danger" data-act="cancel-id" data-id="${p.id}">取消</button>
        </li>`).join('')}
    </ol>
  </div>`;
}

function latestOf(list, animalId, cmp = (x) => x.date) {
  let best = null;
  for (const x of list) {
    if (x.animalId !== animalId) continue;
    if (!best || cmp(x) > cmp(best)) best = x;
  }
  return best;
}

function miniRecordsHTML(a) {
  const check = latestOf(state.checks, a.id);
  const vacs = state.vaccines.filter((v) => v.animalId === a.id);
  const required = state.vaccineCatalog[a.species] || state.vaccineCatalog.other;
  const vacList = required.map((req) => {
    const have = vacs.filter((v) => v.code === req.code).sort((x, y) => y.date.localeCompare(x.date))[0];
    return have
      ? `<span>${req.name} ${have.date}</span>`
      : `<span class="mini-bad">缺 ${req.name}</span>`;
  });
  const checkTxt = check
    ? `${check.date} ${check.result === 'normal' ? '正常' : '异常'}`
    : '<span class="mini-bad">无记录</span>';
  const checkCls = check && check.result === 'abnormal' ? 'mini-bad' : '';
  return `
  <div class="mini-records">
    <div>最近体检：<b class="${checkCls}">${checkTxt}</b></div>
    <div>${vacList.join(' · ')}</div>
  </div>`;
}

function cardActionsHTML(a) {
  if (a.eligibility.reasons.includes('已被领养')) return '<span class="hint">该动物已完成领养</span>';
  const btns = [];
  if (a.eligibility.ok) btns.push(`<button class="btn btn-sm btn-primary" data-act="apply" data-id="${a.id}">申请领养</button>`);
  if (a.active?.status === 'open') btns.push(`<button class="btn btn-sm btn-primary" data-act="confirm" data-id="${a.active.id}">确认领养</button>`);
  if (a.active?.status === 'pending_review') btns.push(`<button class="btn btn-sm btn-warn" data-act="review" data-id="${a.active.id}">登记复诊/复核</button>`);
  if (a.active) btns.push(`<button class="btn btn-sm btn-danger" data-act="cancel-id" data-id="${a.active.id}">取消预约</button>`);
  btns.push(`<button class="btn btn-sm" data-act="check" data-id="${a.id}">登记体检</button>`);
  btns.push(`<button class="btn btn-sm" data-act="vaccine" data-id="${a.id}">补打疫苗</button>`);
  if (!a.eligibility.ok && !a.active && a.liveCount === 0) {
    // 未开放动物不显示申请按钮，阻塞原因已在卡片上
  }
  return btns.join('');
}

function renderAppointments() {
  const tb = $('#apptTable tbody');
  if (!state.appointments.length) {
    tb.innerHTML = `<tr><td colspan="7" class="empty">还没有预约</td></tr>`;
    return;
  }
  tb.innerHTML = state.appointments.map((p) => {
    const acts = [];
    if (p.status === 'open') {
      acts.push(`<button class="btn btn-sm btn-primary" data-act="confirm" data-id="${p.id}">确认</button>`);
    }
    if (p.status === 'pending_review') {
      acts.push(`<button class="btn btn-sm btn-warn" data-act="review" data-id="${p.id}">复核</button>`);
    }
    if (['open', 'pending_review', 'waiting'].includes(p.status)) {
      acts.push(`<button class="btn btn-sm btn-danger" data-act="cancel-id" data-id="${p.id}">取消</button>`);
    }
    return `<tr>
      <td>#${p.seq}</td>
      <td>${esc(p.animalName)}</td>
      <td>${esc(p.adopterName)}<div class="hint">${esc(p.adopterPhone)}</div></td>
      <td><span class="tag ${tagClass(p.status)}">${p.statusLabel}</span></td>
      <td>${SOURCE_LABEL[p.source] || p.source}</td>
      <td class="hint">${fmtTime(p.registeredAt)}</td>
      <td>${acts.join(' ') || '<span class="hint">—</span>'}</td>
    </tr>`;
  }).join('');
}

function renderRecords() {
  const cb = $('#checkTable tbody');
  cb.innerHTML = state.checks.length
    ? state.checks.map((c) => {
        const animal = state.animals.find((a) => a.id === c.animalId);
        return `<tr>
          <td>${esc(c.date)}</td>
          <td>${esc(animal?.name || c.animalId)}</td>
          <td class="${c.result === 'abnormal' ? 'res-bad' : 'res-ok'}">${c.result === 'abnormal' ? '⚠ 异常' : '正常'}</td>
          <td>${esc(c.note) || '<span class="hint">—</span>'}</td>
          <td>${SOURCE_LABEL[c.source] || c.source}${c.ref ? ` <span class="hint">(${esc(c.ref)})</span>` : ''}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="empty">无记录</td></tr>`;

  const vb = $('#vacTable tbody');
  vb.innerHTML = state.vaccines.length
    ? state.vaccines.map((v) => {
        const animal = state.animals.find((a) => a.id === v.animalId);
        return `<tr>
          <td>${esc(v.date)}</td>
          <td>${esc(animal?.name || v.animalId)}</td>
          <td>${esc(v.name)}</td>
          <td>${SOURCE_LABEL[v.source] || v.source}${v.ref ? ` <span class="hint">(${esc(v.ref)})</span>` : ''}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="empty">无记录</td></tr>`;
}

function renderEvents() {
  const ul = $('#eventLog');
  ul.innerHTML = state.events.map((e) => {
    let txt = EVENT_LABEL[e.type] || e.type;
    const d = e.detail || {};
    const aname = state.animals.find((a) => a.id === d.animalId)?.name;
    if (aname) txt += ` · ${aname}`;
    if (d.adopterId) {
      const ad = state.adopters.find((x) => x.id === d.adopterId);
      if (ad) txt += ` · ${ad.name}`;
    }
    if (d.reasons?.length) txt += `（${d.reasons.join('；')}）`;
    if (e.type === 'imported') {
      const i = d.summary.imported;
      txt += `：新增 领养人${i.adopters}/动物${i.animals}/体检${i.checks}/疫苗${i.vaccines}/预约${i.appointments}，重复项跳过未覆盖`;
    }
    return `<li><time>${fmtTime(e.at)}</time><span class="ev-type">[${txt}]</span></li>`;
  }).join('') || '<li class="empty">暂无流水</li>';
}

// ---------------------------------------------------------------- 弹窗表单

const modal = {
  mask: $('#modalMask'), title: $('#modalTitle'), body: $('#modalBody'),
  ok: $('#modalOk'), cancel: $('#modalCancel'), close: $('#modalClose'),
  onSubmit: null,
};
function openModal(title, fieldsHtml, onSubmit, okText = '确定') {
  modal.title.textContent = title;
  modal.body.innerHTML = fieldsHtml;
  modal.ok.textContent = okText;
  modal.onSubmit = onSubmit;
  modal.mask.hidden = false;
  const first = $('input,select,textarea', modal.body);
  if (first) first.focus();
}
function closeModal() { modal.mask.hidden = true; modal.onSubmit = null; }
modal.cancel.addEventListener('click', closeModal);
modal.close.addEventListener('click', closeModal);
modal.mask.addEventListener('click', (e) => { if (e.target === modal.mask) closeModal(); });
modal.ok.addEventListener('click', async () => {
  if (!modal.onSubmit) return;
  try {
    await modal.onSubmit();
  } catch (err) {
    modalAlert(err.message);
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.mask.hidden) closeModal(); });

function field(name, label, inner, help = '') {
  return `<div class="field"><label>${label}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;
}
function val(name) { return $(`[name="${name}"]`, modal.body)?.value.trim() ?? ''; }
function modalAlert(msg) {
  let el = $('#modalAlert', modal.body);
  if (!el) {
    el = document.createElement('div');
    el.id = 'modalAlert';
    el.className = 'modal-alert err';
    modal.body.prepend(el);
  }
  el.textContent = msg;
}
function adopterOptions(selectedId) {
  return ['<option value="">— 请选择已登记领养人 —</option>']
    .concat(state.adopters.map((a) =>
      `<option value="${a.id}"${a.id === selectedId ? ' selected' : ''}>${esc(a.name)} ${esc(a.phone || '')}</option>`))
    .join('');
}

// ---------------------------------------------------------------- 各操作表单

function formApply(animalId) {
  const a = state.animals.find((x) => x.id === animalId);
  openModal(`申请领养：${a.name}`,
    field('adopterId', '选择领养人', `<select name="adopterId">${adopterOptions()}</select>`) +
    field('name', '……或登记新领养人（姓名）', `<input name="name" placeholder="新领养人姓名" />`) +
    field('phone', '联系电话（新领养人）', `<input name="phone" placeholder="选填" />`) +
    `<div class="modal-alert warn">若该动物已有有效预约，申请将自动进入候补，按登记顺序排队。</div>`,
    async () => {
      const r = await post('/api/appointments/apply', {
        animalId, adopterId: val('adopterId'), name: val('name'), phone: val('phone'),
      });
      closeModal();
      toast(r.result.status === 'waiting' ? '已进入候补队列' : '预约已登记');
      await refresh();
    }, '提交申请');
}

function formNewAdopter() {
  openModal('新增领养人',
    field('name', '姓名 *', `<input name="name" />`) +
    field('phone', '联系电话', `<input name="phone" />`),
    async () => {
      await post('/api/adopters', { name: val('name'), phone: val('phone') });
      closeModal(); toast('领养人已登记'); await refresh();
    }, '保存');
}

function formNewAnimal() {
  openModal('新增动物',
    field('name', '名字 *', `<input name="name" />`) +
    field('species', '物种 *', `<select name="species">
      <option value="dog">犬</option><option value="cat">猫</option><option value="other">其他</option></select>`) +
    field('arrivedAt', '到店日期', `<input type="date" name="arrivedAt" value="${state.today}" />`) +
    field('isolationDays', '隔离观察天数', `<input type="number" name="isolationDays" value="14" min="0" />`,
      '隔离期未满不会开放领养'),
    async () => {
      await post('/api/animals', {
        name: val('name'), species: val('species'),
        arrivedAt: val('arrivedAt'), isolationDays: val('isolationDays'),
      });
      closeModal(); toast('动物已入册（请补录体检与疫苗后开放）'); await refresh();
    }, '保存');
}

function formConfirm(apptId) {
  const p = state.appointments.find((x) => x.id === apptId);
  const a = state.animals.find((x) => x.id === p.animalId);
  openModal(`确认领养：${a.name} → ${p.adopterName}`,
    `<div class="modal-alert warn">确认前再次核对：隔离期满、近 7 天体检正常、疫苗齐全。<br>
     若两人同时确认，系统只允许一笔成功，另一笔会被拒绝。</div>` +
    `<div class="field"><label>确认结果</label><div class="radio-row">
      <label><input type="radio" name="res" value="confirm" checked>体检/疫苗均合格，允许领走</label>
      <label><input type="radio" name="res" value="abnormal">到店体检异常或缺疫苗，转待复诊</label>
    </div></div>`,
    async () => {
      const res = $('input[name="res"]:checked', modal.body).value;
      if (res === 'abnormal') {
        await post('/api/checks', { animalId: a.id, result: 'abnormal', date: state.today, note: '确认环节到店体检异常' });
        closeModal(); toast('已登记异常，预约转待复诊', 'err'); await refresh();
        return;
      }
      try {
        await post('/api/appointments/confirm', { appointmentId: apptId });
        closeModal(); toast('确认成功，领养完成'); await refresh();
      } catch (err) {
        modalAlert(err.message);
      }
    }, '确认');
}

function formCancel(apptId) {
  const p = state.appointments.find((x) => x.id === apptId);
  openModal(`取消预约 #${p.seq}（${p.adopterName} · ${p.animalName}）`,
    `<div class="modal-alert warn">取消后如存在候补，将<strong>按登记顺序</strong>自动递补第一位。</div>`,
    async () => {
      const r = await post('/api/appointments/cancel', { appointmentId: apptId });
      closeModal();
      toast(r.result.promoted ? '已取消，候补第一位已递补' : '已取消');
      await refresh();
    }, '确认取消');
}

function formReview(apptId) {
  const p = state.appointments.find((x) => x.id === apptId);
  const a = state.animals.find((x) => x.id === p.animalId);
  const eg = animalEligibilityLive(a);
  const blocked = eg.ok ? '' : `<div class="modal-alert err">当前仍未达标：${eg.reasons.map(esc).join('；')}<br>请先补做体检/疫苗，再点复核通过。</div>`;
  openModal(`登记复诊 / 复核：${a.name}（预约 #${p.seq}）`,
    blocked +
    field('note', '复诊说明', `<textarea name="note" placeholder="例：癣斑已愈，复测正常；猫三联已补打"></textarea>`) +
    `<div class="modal-alert warn">只有隔离期满、近 7 天体检正常、疫苗齐全，复核才能通过并恢复为有效预约。</div>`,
    async () => {
      try {
        await post('/api/appointments/review', { appointmentId: apptId, note: val('note') });
        closeModal(); toast('复核通过，预约已恢复'); await refresh();
      } catch (err) {
        modalAlert(err.message);
      }
    }, '复核通过');
}

function animalEligibilityLive(a) {
  // 直接用 state 中动物卡片预算好的结果
  return a.eligibility;
}

function formCheck(animalId) {
  const a = state.animals.find((x) => x.id === animalId);
  openModal(`登记体检：${a.name}`,
    `<div class="field"><label>结果 *</label><div class="radio-row">
       <label class="sel"><input type="radio" name="result" value="normal" checked>正常</label>
       <label><input type="radio" name="result" value="abnormal">异常</label>
     </div></div>` +
    field('date', '体检日期', `<input type="date" name="date" value="${state.today}" />`) +
    field('note', '备注', `<textarea name="note" placeholder="例：皮肤癣斑，需治疗后复诊"></textarea>`) +
    `<div class="modal-alert warn">体检记录只追加、不会覆盖旧记录；若当前有效预约的动物被记为异常（或近 7 天无正常体检/缺疫苗），预约立即转待复诊。</div>`,
    async () => {
      const result = $('input[name="result"]:checked', modal.body).value;
      await post('/api/checks', { animalId, result, date: val('date'), note: val('note') });
      closeModal();
      toast(result === 'abnormal' ? '已登记异常，相关预约转待复诊' : '体检已登记', result === 'abnormal' ? 'err' : 'ok');
      await refresh();
    }, '保存体检');
}

function formVaccine(animalId) {
  const a = state.animals.find((x) => x.id === animalId);
  const required = state.vaccineCatalog[a.species] || state.vaccineCatalog.other;
  const opts = required.map((v) => {
    const have = state.vaccines.filter((x) => x.animalId === animalId && x.code === v.code)
      .sort((x, y) => y.date.localeCompare(x.date))[0];
    return `<option value="${v.code}">${v.name}${have ? `（上次 ${have.date}）` : '（从未接种）'}</option>`;
  }).join('');
  openModal(`补打疫苗：${a.name}`,
    field('code', '疫苗 *', `<select name="code">${opts}</select>`) +
    field('date', '接种日期', `<input type="date" name="date" value="${state.today}" />`) +
    `<div class="modal-alert warn">补打会新增一条记录，旧疫苗记录保留；“齐全”按每类疫苗的最新接种日期计算。</div>`,
    async () => {
      await post('/api/vaccines', { animalId, code: val('code'), date: val('date') });
      closeModal(); toast('疫苗记录已追加'); await refresh();
    }, '保存疫苗');
}

function formImport() {
  const sample = {
    adopters: [{ ref: 'OLD-A-99', name: '周敏（旧表）', phone: '139-1111-2222' }],
    animals: [
      { ref: 'OLD-M-7', name: '团子（旧表）', species: 'cat', arrivedAt: shift(-30), isolationDays: 14 },
    ],
    checks: [
      { ref: 'OLD-C-101', animalRef: 'OLD-M-7', date: shift(-2), result: 'normal', note: '旧表：到店体检正常' },
    ],
    vaccines: [
      { ref: 'OLD-V-201', animalRef: 'OLD-M-7', date: shift(-20), code: 'rabies' },
      { ref: 'OLD-V-202', animalRef: 'OLD-M-7', date: shift(-20), code: 'fvrcp' },
    ],
    appointments: [
      { ref: 'OLD-P-301', animalRef: 'OLD-M-7', adopterRef: 'OLD-A-99', status: 'scheduled', registeredAt: shift(-1) },
    ],
  };
  openModal('导入旧表（JSON，按编号去重，重复提交不会覆盖）',
    field('payload', '旧表数据', `<textarea name="payload" style="min-height:230px">${esc(JSON.stringify(sample, null, 2))}</textarea>`,
      '再次点击导入同样的数据：全部跳过，已存在的预约/体检/疫苗一条都不会被改。') +
    `<div id="impResult"></div>`,
    async () => {
      let body;
      try { body = JSON.parse(val('payload')); }
      catch { throw new Error('JSON 格式不正确'); }
      const r = await post('/api/import', body);
      const i = r.result.imported, s = r.result.skipped;
      $('#impResult').innerHTML = `<div class="modal-alert ok">导入完成 —— 新增：领养人 ${i.adopters}、动物 ${i.animals}、体检 ${i.checks}、疫苗 ${i.vaccines}、预约 ${i.appointments}；跳过（已存在，未覆盖）：${s.adopters}/${s.animals}/${s.checks}/${s.vaccines}/${s.appointments}</div>`;
      toast('旧表导入完成');
      await refreshSilent();
    }, '执行导入');
}

function shift(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- Toast & 事件

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  try {
    switch (act) {
      case 'new-adopter': formNewAdopter(); break;
      case 'new-animal': formNewAnimal(); break;
      case 'import-legacy': formImport(); break;
      case 'apply': formApply(id); break;
      case 'confirm': formConfirm(id); break;
      case 'review': formReview(id); break;
      case 'check': formCheck(id); break;
      case 'vaccine': formVaccine(id); break;
      case 'cancel-id': formCancel(id); break;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  $$('.chip', $('#filters')).forEach((c) => c.classList.toggle('active', c === chip));
  renderAnimals();
});

// 轮询：模拟两人同时操作时另一页面也能即时看到；标签页隐藏时暂停
setInterval(() => { if (!document.hidden) refreshSilent(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSilent(); });

refresh().catch((err) => toast('加载失败：' + err.message, 'err'));
