let STATE = null;
let currentApplyAnimal = null;
let currentCancelId = null;
let currentRecheckId = null;

const STATUS_LABEL = {
  active: "有效预约",
  waiting: "候补中",
  pending_recheck: "待复诊",
  cancelled: "已取消",
  completed: "已完成（已领走）",
};

const EVENT_LABEL = {
  apply: "申请",
  promote: "候补补位",
  cancel: "取消",
  confirm: "确认领走",
  to_recheck: "转待复诊",
  recheck_pass: "复诊通过",
  recheck_fail: "复诊未过",
  vaccine: "补做疫苗",
  import: "旧表导入",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function toast(msg, type = "info", tag = "") {
  const box = document.getElementById("toasts");
  const d = document.createElement("div");
  d.className = "toast " + type;
  d.textContent = (tag ? tag + " " : "") + msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 6500);
}

async function api(path, payload) {
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json();
  if (!data.ok) {
    const err = new Error(data.error || "操作失败");
    err.status = resp.status;
    throw err;
  }
  if (data.state) STATE = data.state;
  return data;
}

async function loadState() {
  const resp = await fetch("/api/state");
  STATE = await resp.json();
  render();
}

function findAnimal(id) { return STATE.animals.find(a => a.id === id); }
function findAdopter(id) { return STATE.adopters.find(p => p.id === id); }

function render() {
  document.getElementById("today").textContent = "今天：" + STATE.today;
  document.getElementById("animal-count").textContent =
    "（开放 " + STATE.animals.filter(a => a.open).length + " / 共 " + STATE.animals.length + "）";
  renderAnimals();
  renderReservations();
  renderEvents();
}

function renderAnimals() {
  const el = document.getElementById("animal-list");
  el.innerHTML = STATE.animals.map(a => {
    const live = STATE.reservations.filter(
      r => r.animal_id === a.id && ["active", "waiting", "pending_recheck"].includes(r.status)
    );
    const activeOne = live.find(r => r.status === "active");
    const waits = live.filter(r => r.status === "waiting").sort((x, y) => x.wait_position - y.wait_position);
    const pending = live.find(r => r.status === "pending_recheck");

    let queueLine = "";
    if (activeOne) {
      const who = findAdopter(activeOne.adopter_id);
      queueLine = `<div class="subdetail"><span class="lab">有效预约：</span>${esc(who.name)}（${esc(who.phone)}）</div>`;
    } else if (pending) {
      const who = findAdopter(pending.adopter_id);
      queueLine = `<div class="subdetail"><span class="lab">待复诊占用：</span>${esc(who.name)}（${esc(who.phone)}），复诊通过前不可领走</div>`;
    }
    if (waits.length) {
      queueLine += `<div class="subdetail"><span class="lab">候补队列：</span>` +
        waits.map(w => `${esc(w.wait_position)}. ${esc(findAdopter(w.adopter_id).name)}`).join(" ｜ ") +
        `</div>`;
    }
    if (!live.length) queueLine = `<div class="subdetail">暂无预约</div>`;

    const reasons = a.blocked_reasons.length
      ? `<ul class="reasons">${a.blocked_reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>`
      : "";

    const exams = a.exams.slice(0, 4).map(e => {
      const cls = e.result === "abnormal" ? "exam-abnormal" : "exam-normal";
      const label = e.exam_type === "in_store" ? "到店" : "常规";
      const src = e.source === "legacy" ? `<span class="badge legacy">旧表</span>` : "";
      const res = e.result === "abnormal" ? "异常" : "正常";
      return `<li>${esc(e.exam_date)} ${label}体检 <span class="${cls}">${res}</span> ${src} ${esc(e.notes)}</li>`;
    }).join("");

    const vax = a.vaccines.map(v =>
      `<li>${esc(v.vaccinated_on)} ${esc(v.vaccine)}${v.source === "legacy" ? ' <span class="badge legacy">旧表</span>' : ""}</li>`
    ).join("");

    return `
    <div class="animal-card ${a.open ? "open" : "blocked"}">
      <div class="head">
        <span class="name">${esc(a.name)}</span>
        <span class="meta">${esc(a.species)} · 隔离至 ${esc(a.quarantine_until)}</span>
        ${a.open ? '<span class="badge open">可领养</span>' : '<span class="badge blocked">暂不开放</span>'}
        ${a.source === "legacy" ? '<span class="badge legacy">旧表</span>' : ""}
      </div>
      ${reasons}
      ${queueLine}
      <details class="subdetail"><summary>体检 / 疫苗记录（只追加）</summary>
        <div style="margin-top:4px">体检：${exams ? `<ul style="margin:4px 0;padding-left:18px">${exams}</ul>` : "无"}</div>
        <div>疫苗：${vax ? `<ul style="margin:4px 0;padding-left:18px">${vax}</ul>` : "无"}</div>
      </details>
      <div class="row-actions">
        <button class="btn primary small" onclick="openApply(${a.id})">申请领养</button>
        ${activeOne ? `<button class="btn small" onclick="confirmResv(${activeOne.id})">确认领走</button>
          <button class="btn small" onclick="concurrentConfirmDemo(${activeOne.id})">并发确认演示（两人同时）</button>` : ""}
        ${pending ? `<button class="btn warn small" onclick="openRecheck(${pending.id})">登记复诊</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

function renderReservations() {
  const el = document.getElementById("reservation-list");
  const order = { active: 0, pending_recheck: 1, waiting: 2, completed: 3, cancelled: 4 };
  const list = [...STATE.reservations].sort(
    (a, b) => (order[a.status] - order[b.status]) || a.id - b.id
  );
  if (!list.length) { el.innerHTML = '<div class="empty">还没有预约</div>'; return; }

  el.innerHTML = list.map(r => {
    const a = findAnimal(r.animal_id);
    const src = r.source === "legacy" ? '<span class="badge legacy">旧表</span>' : "";
    const wait = r.status === "waiting"
      ? `<span class="waitline">候补第 ${r.wait_position} 位</span>` : "";
    const blocks = r.blocked_reasons.length
      ? `<ul class="blocklist">${r.blocked_reasons.map(x => `<li>阻塞原因：${esc(x)}</li>`).join("")}</ul>`
      : "";
    const actions = ["active", "waiting", "pending_recheck"].includes(r.status)
      ? `<div class="row-actions">
          ${r.status === "active" ? `<button class="btn small primary" onclick="confirmResv(${r.id})">确认领走</button>` : ""}
          ${r.status === "pending_recheck" ? `<button class="btn small warn" onclick="openRecheck(${r.id})">登记复诊</button>` : ""}
          <button class="btn small danger" onclick="openCancel(${r.id})">取消</button>
        </div>` : "";
    return `
    <div class="resv-item">
      <div class="top">
        <span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span>
        <b>#${r.id}</b>
        <span>${esc(r.adopter_name)}（${esc(r.adopter_phone)}）</span>
        <span class="who">→ ${esc(a.name)}</span>
        ${wait}${src}
        <span style="flex:1"></span>
        <span class="when">登记于 ${esc(r.created_at)}</span>
      </div>
      ${blocks}
      ${actions}
    </div>`;
  }).join("");
}

function renderEvents() {
  const el = document.getElementById("event-list");
  el.innerHTML = STATE.events.map(e => `
    <tr>
      <td>${esc(e.created_at)}</td>
      <td>#${esc(e.reservation_id)}</td>
      <td><span class="tag">${esc(EVENT_LABEL[e.kind] || e.kind)}</span></td>
      <td>${esc(e.detail)}</td>
      <td>${e.source === "legacy" ? '<span class="badge legacy">旧表</span>' : "页面"}</td>
    </tr>`).join("");
}

// ------------------------------------------------------------ 弹窗操作

function openApply(animalId) {
  currentApplyAnimal = animalId;
  const a = findAnimal(animalId);
  document.getElementById("apply-animal-name").textContent = a.name;
  const sel = document.getElementById("apply-adopter");
  sel.innerHTML = STATE.adopters.map(p =>
    `<option value="${p.id}">${esc(p.name)}（${esc(p.phone)}）</option>`).join("");
  document.getElementById("apply-hint").textContent = a.open
    ? "当前可领养。若已有有效预约，提交后将进入候补并按登记顺序补位。"
    : "注意：该动物当前不开放，提交会被拒绝，阻塞原因见动物卡片。";
  showModal("apply-modal");
}

async function submitApply() {
  const adopterId = Number(document.getElementById("apply-adopter").value);
  try {
    await api("/api/apply", { animal_id: currentApplyAnimal, adopter_id: adopterId });
    closeModal("apply-modal");
    render();
    toast("申请已提交", "ok");
  } catch (e) { toast(e.message, "err"); }
}

function openCancel(resvId) {
  currentCancelId = resvId;
  const r = STATE.reservations.find(x => x.id === resvId);
  document.getElementById("cancel-resv").textContent =
    `#${r.id} ${r.adopter_name} → ${findAnimal(r.animal_id).name}（${STATUS_LABEL[r.status]}）`;
  document.getElementById("cancel-reason").value = "";
  showModal("cancel-modal");
}

async function submitCancel() {
  const reason = document.getElementById("cancel-reason").value.trim();
  try {
    await api("/api/cancel", { reservation_id: currentCancelId, reason });
    closeModal("cancel-modal");
    render();
    toast("已取消；若存在候补，已按登记顺序补位", "ok");
  } catch (e) { toast(e.message, "err"); }
}

async function confirmResv(resvId) {
  try {
    const data = await api("/api/confirm", { reservation_id: resvId });
    render();
    // 后端未直接返回结果体，根据最新状态判断
    const r = STATE.reservations.find(x => x.id === resvId);
    if (r.status === "completed") toast("确认成功，动物已领走", "ok");
    else toast("复核未通过，预约已转「待复诊」：" + r.blocked_reasons.join("；"), "err");
  } catch (e) { toast(e.message, "err"); }
}

function openRecheck(resvId) {
  currentRecheckId = resvId;
  const r = STATE.reservations.find(x => x.id === resvId);
  const a = findAnimal(r.animal_id);
  document.getElementById("recheck-animal-name").textContent = a.name;
  document.getElementById("recheck-blocked").innerHTML =
    "当前阻塞原因：" + (r.blocked_reasons.length
      ? r.blocked_reasons.map(esc).join("；")
      : "（无）");
  document.getElementById("recheck-result").value = "normal";
  document.getElementById("recheck-notes").value = "";
  const need = (STATE.required_vaccines[a.species] || []);
  const had = new Set(a.vaccines.map(v => v.vaccine));
  document.getElementById("recheck-vax").innerHTML = need.map(v => `
    <label><input type="checkbox" value="${esc(v)}" ${had.has(v) ? "disabled checked" : ""}>
      ${esc(v)}${had.has(v) ? "（已有记录，旧记录保留）" : ""}</label>`).join("");
  showModal("recheck-modal");
}

async function submitRecheck() {
  const vaccines = Array.from(
    document.querySelectorAll("#recheck-vax input[type=checkbox]:checked:not(:disabled)")
  ).map(x => x.value);
  try {
    await api("/api/recheck", {
      reservation_id: currentRecheckId,
      exam_result: document.getElementById("recheck-result").value,
      notes: document.getElementById("recheck-notes").value.trim(),
      vaccines,
    });
    closeModal("recheck-modal");
    render();
    const r = STATE.reservations.find(x => x.id === currentRecheckId);
    if (r.status === "active") toast("复诊复核通过，已恢复为有效预约，可再次确认", "ok");
    else toast("复核仍未通过，保持「待复诊」：" + r.blocked_reasons.join("；"), "err");
  } catch (e) { toast(e.message, "err"); }
}

async function importLegacy() {
  try {
    await api("/api/import-legacy", { batch_code: "2026-09-old" });
    render();
    toast("旧表已导入：预约与异常体检照常进入队列（再次导入会被拒绝）", "ok");
  } catch (e) { toast(e.message, "err"); }
}

// 两人同时点确认：两个请求并发发出，唯一索引 + 事务保证只成功一笔
async function concurrentConfirmDemo(resvId) {
  const r = STATE.reservations.find(x => x.id === resvId);
  if (!r) return;
  toast("模拟两人同时确认预约 #" + resvId + " …", "info", "[并发]");
  const results = await Promise.allSettled([
    api("/api/confirm", { reservation_id: resvId }).then(() => "提交A：成功"),
    api("/api/confirm", { reservation_id: resvId }).then(() => "提交B：成功"),
  ]);
  results.forEach((res, i) => {
    const who = i === 0 ? "提交A" : "提交B";
    if (res.status === "fulfilled") toast(who + " 成功", "ok", "[并发]");
    else toast(who + " 被拒绝：" + res.reason.message, "err", "[并发]");
  });
  await loadState();
}

function showModal(id) { document.getElementById(id).classList.add("show"); }
function closeModal(id) { document.getElementById(id).classList.remove("show"); }

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-mask")) e.target.classList.remove("show");
});

loadState();
