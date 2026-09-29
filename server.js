'use strict';

/**
 * 救助站领养管理台 —— 零依赖 Node 服务
 *
 * 设计要点：
 * 1. 全部状态落在 data/db.json，每次写操作整体落盘（原子写），重启后原样继续。
 * 2. 所有写操作经过同一个串行事务队列（withTx），因此“两人同时确认”在服务端
 *    也只会有一笔成功；第二笔拿到的状态里预约已不是 open，直接 409 拒绝。
 * 3. 体检/疫苗记录只追加不覆盖（append-only）。旧表导入同样走追加通道，按
 *    ref/编号去重，重复导入或新登记都不会盖掉已有记录。
 * 4. 预约是状态机：waiting -> open -> (pending_review) -> confirmed / cancelled。
 *    取消/确认腾出名额后由候补按登记顺序（seq）递补；动物当前不合格则递补为
 *    pending_review，而不是直接开放。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DAY = 24 * 60 * 60 * 1000;

const VACCINE_CATALOG = {
  dog: [
    { code: 'rabies', name: '狂犬疫苗', intervalDays: 365 },
    { code: 'distemper', name: '犬四联', intervalDays: 365 },
  ],
  cat: [
    { code: 'rabies', name: '狂犬疫苗', intervalDays: 365 },
    { code: 'fvrcp', name: '猫三联', intervalDays: 365 },
  ],
  other: [{ code: 'rabies', name: '狂犬疫苗', intervalDays: 365 }],
};

const STATUS = {
  waiting: { label: '候补中', tone: 'wait' },
  open: { label: '已排预约', tone: 'open' },
  pending_review: { label: '待复诊', tone: 'block' },
  confirmed: { label: '已确认领养', tone: 'done' },
  cancelled: { label: '已取消', tone: 'dead' },
};

// ---------------------------------------------------------------- 日期工具

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  return todayStr(new Date(Date.now() - n * DAY));
}
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}
function dateInLastNDays(s, n, now = new Date()) {
  const d = parseDate(s);
  if (!d) return false;
  const diff = now.getTime() - d.getTime();
  return diff >= 0 && diff <= n * DAY;
}

// ---------------------------------------------------------------- 数据存取

let db = null;

function defaultDB() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    seq: 0,
    adopters: [],
    animals: [],
    appointments: [],
    checks: [], // 体检记录（追加表）
    vaccines: [], // 疫苗记录（追加表）
    events: [], // 全量流水（追加表）
  };
}

function seed() {
  const d = defaultDB();

  const adopter = (name, phone) => {
    const a = {
      id: 'a' + (d.adopters.length + 1),
      name,
      phone,
      createdAt: new Date().toISOString(),
      source: 'seed',
    };
    d.adopters.push(a);
    return a;
  };

  const animal = (a) => {
    const row = {
      id: 'm' + (d.animals.length + 1),
      name: a.name,
      species: a.species, // dog / cat / other
      arrivedAt: daysAgoStr(a.arrivedDays),
      isolationDays: a.isolationDays ?? 14,
      createdAt: new Date().toISOString(),
      source: 'seed',
    };
    d.animals.push(row);
    return row;
  };

  const check = (animalId, daysAgo, result, note, source = 'seed') => {
    d.checks.push({
      id: 'c' + (d.checks.length + 1),
      animalId,
      date: daysAgoStr(daysAgo),
      result, // normal / abnormal
      note: note || '',
      source,
      importedAt: source === 'import' ? new Date().toISOString() : undefined,
      createdAt: new Date().toISOString(),
    });
  };

  const vaccine = (animalId, daysAgo, code, source = 'seed') => {
    const sp = d.animals.find((x) => x.id === animalId).species;
    const meta = (VACCINE_CATALOG[sp] || []).find((v) => v.code === code);
    d.vaccines.push({
      id: 'v' + (d.vaccines.length + 1),
      animalId,
      date: daysAgoStr(daysAgo),
      code,
      name: meta ? meta.name : code,
      source,
      importedAt: source === 'import' ? new Date().toISOString() : undefined,
      createdAt: new Date().toISOString(),
    });
  };

  const adoption = (animalId, adopterId, status, daysAgo, source = 'seed') => {
    d.seq += 1;
    d.appointments.push({
      id: 'p' + (d.appointments.length + 1),
      animalId,
      adopterId,
      status,
      seq: d.seq,
      source,
      createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
      registeredAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
      importedAt: source === 'import' ? new Date().toISOString() : undefined,
    });
  };

  // --- 领养人
  const zhang = adopter('张晨', '138-0000-0001');
  const li = adopter('李妍', '138-0000-0002');
  const wang = adopter('王磊', '138-0000-0003');
  const zhao = adopter('赵琳', '138-0000-0004');
  const chen = adopter('陈航', '138-0000-0005');
  const sun = adopter('孙悦', '138-0000-0006');

  // --- 动物
  // 1 豆豆：完全合格，已有一份排好的预约 + 一名候补
  const doudou = animal({ name: '豆豆', species: 'dog', arrivedDays: 20 });
  // 2 花花：隔离期未满（到店 5 天），不可申请
  const huahua = animal({ name: '花花', species: 'cat', arrivedDays: 5 });
  // 3 阿黄：近七天体检异常 → open 转待复诊
  const ahuang = animal({ name: '阿黄', species: 'dog', arrivedDays: 30 });
  // 4 咪咪：缺疫苗，卡在待复诊，补打并复核后可恢复
  const mimi = animal({ name: '咪咪', species: 'cat', arrivedDays: 25 });
  // 5 煤球：完全合格、无人预约，可直接申请
  const meiqiu = animal({ name: '煤球', species: 'cat', arrivedDays: 40 });
  // 6 大福：旧表导来的动物 + 旧预约 + 旧体检
  const dafu = animal({ name: '大福', species: 'dog', arrivedDays: 60 });

  // 体检（近 7 天才算有效，异常会阻塞）
  check(doudou.id, 2, 'normal', '到店体检，精神良好');
  check(doudou.id, 16, 'normal', '入站体检');

  check(huahua.id, 5, 'normal', '入站体检');

  check(ahuang.id, 1, 'abnormal', '到店体检：皮肤癣斑，需复诊');
  check(ahuang.id, 12, 'normal', '入站体检');

  check(mimi.id, 3, 'normal', '到店体检正常');

  check(meiqiu.id, 4, 'normal', '到店体检正常');

  check(dafu.id, 6, 'normal', '旧表：到店体检正常', 'import');
  check(dafu.id, 20, 'normal', '旧表：入站体检', 'import');

  // 疫苗
  vaccine(doudou.id, 18, 'rabies');
  vaccine(doudou.id, 18, 'distemper');

  vaccine(huahua.id, 5, 'rabies');
  vaccine(huahua.id, 5, 'fvrcp');

  vaccine(ahuang.id, 25, 'rabies');
  vaccine(ahuang.id, 25, 'distemper');

  vaccine(mimi.id, 20, 'rabies'); // 故意缺猫三联

  vaccine(meiqiu.id, 10, 'rabies');
  vaccine(meiqiu.id, 10, 'fvrcp');

  vaccine(dafu.id, 30, 'rabies', 'import');
  vaccine(dafu.id, 30, 'distemper', 'import');

  // 预约
  adoption(doudou.id, zhang.id, 'open', 3); // 张晨已排预约
  adoption(doudou.id, li.id, 'waiting', 2); // 李妍候补
  adoption(doudou.id, wang.id, 'waiting', 1); // 王磊第二候补

  adoption(ahuang.id, zhao.id, 'open', 4); // 体检异常后应转待复诊（reconcile 处理）

  adoption(mimi.id, chen.id, 'open', 5); // 缺疫苗 → 待复诊

  adoption(dafu.id, sun.id, 'open', 8, 'import'); // 旧表导来的预约，照常继续处理

  return d;
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    db = seed();
    save();
  }
  return db;
}

let saving = false;
function save() {
  saving = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
  saving = false;
}

// ---------------------------------------------------------------- 领域规则

function addEvent(type, detail) {
  db.events.push({
    id: 'e' + ++db.seq + '-' + crypto.randomBytes(2).toString('hex'),
    at: new Date().toISOString(),
    type,
    detail,
  });
  if (db.events.length > 500) db.events = db.events.slice(-500);
}

function latestCheck(animalId) {
  let latest = null;
  for (const c of db.checks) {
    if (c.animalId !== animalId) continue;
    if (!latest || c.date > latest.date) latest = c;
  }
  return latest;
}

/**
 * 计算动物当前是否满足开放条件。三个条件全部满足才可领走：
 *  - 隔离期满
 *  - 近 7 天有体检且结果正常
 *  - 该物种要求的疫苗全部在有效期内
 * 返回 { ok, reasons[] }
 */
function eligibility(animal, now = new Date()) {
  const reasons = [];

  const arrival = parseDate(animal.arrivedAt);
  if (!arrival) {
    reasons.push('缺少入站日期');
  } else {
    const elapsed = Math.floor((now.getTime() - arrival.getTime()) / DAY);
    if (elapsed < (animal.isolationDays ?? 14)) {
      reasons.push(`隔离期未满（到店 ${elapsed} 天 / 需满 ${animal.isolationDays ?? 14} 天）`);
    }
  }

  const last = latestCheck(animal.id);
  if (!last) {
    reasons.push('没有任何体检记录');
  } else if (!dateInLastNDays(last.date, 7, now)) {
    reasons.push(`近 7 天无有效体检（最近一次 ${last.date}）`);
  } else if (last.result === 'abnormal') {
    reasons.push(`最近体检异常（${last.date}${last.note ? '：' + last.note : ''}）`);
  }

  const required = VACCINE_CATALOG[animal.species] || VACCINE_CATALOG.other;
  for (const req of required) {
    let latestV = null;
    for (const v of db.vaccines) {
      if (v.animalId === animal.id && v.code === req.code) {
        if (!latestV || v.date > latestV.date) latestV = v;
      }
    }
    if (!latestV) {
      reasons.push(`缺少疫苗：${req.name}`);
    } else if (!dateInLastNDays(latestV.date, req.intervalDays, now)) {
      reasons.push(`${req.name}已过有效期（接种于 ${latestV.date}）`);
    }
  }

  // 已有确认领养的动物不再开放
  const adopted = db.appointments.some(
    (p) => p.animalId === animal.id && p.status === 'confirmed'
  );
  if (adopted) reasons.push('已被领养');

  return { ok: reasons.length === 0, reasons };
}

function liveAppointments(animalId) {
  return db.appointments.filter(
    (p) =>
      p.animalId === animalId &&
      ['waiting', 'open', 'pending_review'].includes(p.status)
  );
}
function activeAppointment(animalId) {
  return db.appointments.find(
    (p) =>
      p.animalId === animalId &&
      (p.status === 'open' || p.status === 'pending_review')
  );
}
function waitingList(animalId) {
  return db.appointments
    .filter((p) => p.animalId === animalId && p.status === 'waiting')
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 体检异常 / 缺疫苗等事实发生后，把当前有效预约同步为待复诊。
 * 注意：合格后不自动回 open，必须人工“复核”——避免异常没确认就放行。
 */
function syncBlocked(animal) {
  const act = activeAppointment(animal.id);
  if (!act || act.status !== 'open') return;
  const { reasons } = eligibility(animal);
  if (reasons.length) {
    act.status = 'pending_review';
    addEvent('blocked', {
      appointmentId: act.id,
      animalId: animal.id,
      reasons,
    });
  }
}

/** 名额空出后：候补严格按登记顺序补一个；合格 open，不合格 pending_review。 */
function promoteFromWaitlist(animal) {
  const next = waitingList(animal.id)[0];
  if (!next || activeAppointment(animal.id)) return null;
  const { ok, reasons } = eligibility(animal);
  next.status = ok ? 'open' : 'pending_review';
  addEvent(ok ? 'promoted' : 'promoted_blocked', {
    appointmentId: next.id,
    animalId: animal.id,
    adopterId: next.adopterId,
    reasons,
  });
  return next;
}

function getAnimal(id) {
  return db.animals.find((a) => a.id === id);
}
function getAdopter(id) {
  return db.adopters.find((a) => a.id === id);
}
function getAppointment(id) {
  return db.appointments.find((p) => p.id === id);
}

// ---------------------------------------------------------------- 写操作

function validateAdopterInput(body) {
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name) throw httpError(400, '请填写领养人姓名');
  return { name, phone };
}

function createAdopter(body) {
  const { name, phone } = validateAdopterInput(body);
  const adopter = {
    id: 'a' + (db.adopters.length ? Math.max(...db.adopters.map((a) => parseInt(a.id.slice(1)) || 0)) + 1 : 1),
    name,
    phone,
    createdAt: new Date().toISOString(),
    source: 'manual',
  };
  db.adopters.push(adopter);
  addEvent('adopter_created', { adopterId: adopter.id, name });
  save();
  return adopter;
}

function createAnimal(body) {
  const name = String(body.name || '').trim();
  const species = ['dog', 'cat', 'other'].includes(body.species) ? body.species : null;
  if (!name) throw httpError(400, '请填写动物名字');
  if (!species) throw httpError(400, '物种必须是 dog/cat/other');
  const isolationDays = Number.isFinite(+body.isolationDays) ? Math.max(0, +body.isolationDays | 0) : 14;
  const arrivedAt = body.arrivedAt && parseDate(body.arrivedAt) ? body.arrivedAt : todayStr();
  const animal = {
    id: 'm' + (db.animals.length ? Math.max(...db.animals.map((a) => parseInt(a.id.slice(1)) || 0)) + 1 : 1),
    name,
    species,
    arrivedAt,
    isolationDays,
    createdAt: new Date().toISOString(),
    source: 'manual',
  };
  db.animals.push(animal);
  addEvent('animal_created', { animalId: animal.id, name });
  save();
  return animal;
}

function applyAppointment(body) {
  const animal = getAnimal(body.animalId);
  if (!animal) throw httpError(404, '动物不存在');
  let adopter = body.adopterId ? getAdopter(body.adopterId) : null;
  if (!adopter) {
    if (!body.name) throw httpError(400, '请选择领养人或填写新领养人姓名');
    adopter = createAdopter({ name: body.name, phone: body.phone || '' });
  }

  // 同一领养人对同一动物不能重复占有效名额
  const dup = liveAppointments(animal.id).find((p) => p.adopterId === adopter.id);
  if (dup) throw httpError(409, `该领养人对该动物已有一份「${STATUS[dup.status].label}」记录，不能重复申请`);

  const { ok, reasons } = eligibility(animal);

  // 动物当前不开放：新申请直接拒绝，并把阻塞原因讲清楚（不是“进候补等”，
  // 因为规则要求“隔离期满/体检正常/疫苗齐全才开放”）
  if (!ok) {
    throw httpError(409, '该动物当前未开放领养：' + reasons.join('；'), {
      blockedReasons: reasons,
    });
  }

  const act = activeAppointment(animal.id);
  const now = new Date().toISOString();
  const appt = {
    id: 'p' + (db.appointments.length ? Math.max(...db.appointments.map((p) => parseInt(p.id.slice(1)) || 0)) + 1 : 1),
    animalId: animal.id,
    adopterId: adopter.id,
    status: act ? 'waiting' : 'open',
    seq: ++db.seq,
    source: 'manual',
    createdAt: now,
    registeredAt: now,
  };
  db.appointments.push(appt);
  addEvent(act ? 'waitlisted' : 'applied', {
    appointmentId: appt.id,
    animalId: animal.id,
    adopterId: adopter.id,
  });
  save();
  return appt;
}

function cancelAppointment(body) {
  const appt = body.appointmentId ? getAppointment(body.appointmentId) : null;
  if (!appt) throw httpError(404, '预约不存在');
  if (!['open', 'pending_review', 'waiting'].includes(appt.status)) {
    throw httpError(409, `当前状态「${STATUS[appt.status].label}」不可取消`);
  }
  const animal = getAnimal(appt.animalId);
  const wasActive = appt.status !== 'waiting';
  appt.status = 'cancelled';
  appt.cancelledAt = new Date().toISOString();
  addEvent('cancelled', {
    appointmentId: appt.id,
    animalId: appt.animalId,
    adopterId: appt.adopterId,
  });

  let promoted = null;
  if (wasActive) promoted = promoteFromWaitlist(animal);
  save();
  return { cancelled: appt.id, promoted: promoted ? promoted.id : null };
}

function confirmAppointment(body) {
  const appt = body.appointmentId ? getAppointment(body.appointmentId) : null;
  if (!appt) throw httpError(404, '预约不存在');

  // 并发确认的关键闸门：串行事务下，第一笔把状态改成 confirmed，
  // 第二笔进来时这里已不是 open → 409。
  if (appt.status !== 'open') {
    throw httpError(409, `只有「${STATUS.open.label}」状态可以确认，当前为「${STATUS[appt.status].label}」`);
  }
  const animal = getAnimal(appt.animalId);
  const { ok, reasons } = eligibility(animal);
  if (!ok) {
    // 确认瞬间才发现不合格：转待复诊，动物不能领走
    appt.status = 'pending_review';
    addEvent('blocked', { appointmentId: appt.id, animalId: animal.id, reasons });
    save();
    throw httpError(409, '到店复核未通过，预约已转待复诊：' + reasons.join('；'), {
      blockedReasons: reasons,
      appointmentId: appt.id,
    });
  }

  appt.status = 'confirmed';
  appt.confirmedAt = new Date().toISOString();
  addEvent('confirmed', {
    appointmentId: appt.id,
    animalId: appt.animalId,
    adopterId: appt.adopterId,
  });

  // 名额已定：其余候补全部关闭，按登记顺序注明
  const waiters = waitingList(animal.id);
  for (const w of waiters) {
    w.status = 'cancelled';
    w.cancelledAt = new Date().toISOString();
    w.cancelReason = '名额已被前面的预约确认';
    addEvent('waitlist_closed', {
      appointmentId: w.id,
      animalId: animal.id,
      adopterId: w.adopterId,
    });
  }
  save();
  return appt;
}

/** 登记体检（追加，不改写旧记录）。异常则当前 open 预约立即转待复诊。 */
function addCheck(body) {
  const animal = getAnimal(body.animalId);
  if (!animal) throw httpError(404, '动物不存在');
  const result = body.result === 'normal' || body.result === 'abnormal' ? body.result : null;
  if (!result) throw httpError(400, '体检结果必须为 normal 或 abnormal');
  const date = body.date && parseDate(body.date) ? body.date : todayStr();
  const rec = {
    id: 'c' + (db.checks.length ? Math.max(...db.checks.map((c) => parseInt(c.id.slice(1)) || 0)) + 1 : 1),
    animalId: animal.id,
    date,
    result,
    note: String(body.note || '').trim(),
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  db.checks.push(rec);
  addEvent('check_added', {
    checkId: rec.id,
    animalId: animal.id,
    result,
    date,
  });
  // 异常会把 open 压成 pending_review；合格时若仍处于 open 则无变化
  syncBlocked(animal);
  save();
  return rec;
}

/** 补打疫苗（追加新记录；旧疫苗记录保留，“齐全”按每类最新一条计算）。 */
function addVaccine(body) {
  const animal = getAnimal(body.animalId);
  if (!animal) throw httpError(404, '动物不存在');
  const required = VACCINE_CATALOG[animal.species] || VACCINE_CATALOG.other;
  const meta = required.find((v) => v.code === body.code);
  if (!meta) {
    const allow = required.map((v) => v.code).join(', ');
    throw httpError(400, `${animal.name}需要的疫苗代码：${allow}`);
  }
  const date = body.date && parseDate(body.date) ? body.date : todayStr();
  const rec = {
    id: 'v' + (db.vaccines.length ? Math.max(...db.vaccines.map((v) => parseInt(v.id.slice(1)) || 0)) + 1 : 1),
    animalId: animal.id,
    date,
    code: meta.code,
    name: meta.name,
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
  db.vaccines.push(rec);
  addEvent('vaccine_added', {
    vaccineId: rec.id,
    animalId: animal.id,
    code: meta.code,
    date,
  });
  save();
  return rec;
}

/** 复核：待复诊预约经人工核对，补做项都合格才能恢复为 open。 */
function reviewAppointment(body) {
  const appt = body.appointmentId ? getAppointment(body.appointmentId) : null;
  if (!appt) throw httpError(404, '预约不存在');
  if (appt.status !== 'pending_review') {
    throw httpError(409, `只有「${STATUS.pending_review.label}」可以复核，当前为「${STATUS[appt.status].label}」`);
  }
  const animal = getAnimal(appt.animalId);
  const { ok, reasons } = eligibility(animal);
  const note = String(body.note || '').trim();
  if (!ok) {
    addEvent('review_failed', {
      appointmentId: appt.id,
      animalId: animal.id,
      reasons,
      note,
    });
    save();
    throw httpError(409, '复核未通过，仍是待复诊：' + reasons.join('；'), {
      blockedReasons: reasons,
    });
  }
  appt.status = 'open';
  appt.reviewedAt = new Date().toISOString();
  addEvent('review_passed', {
    appointmentId: appt.id,
    animalId: animal.id,
    adopterId: appt.adopterId,
    note,
  });
  save();
  return appt;
}

/**
 * 旧表导入：全程追加 + 按业务编号去重，幂等。
 * 已存在的预约/体检/疫苗一律保留不动，新记录绝不覆盖旧记录。
 * 导入的预约同样进入状态机（旧表的“已排/待复诊”映射到现有状态）。
 */
function importLegacy(body) {
  const summary = {
    imported: { adopters: 0, animals: 0, checks: 0, vaccines: 0, appointments: 0 },
    skipped: { adopters: 0, animals: 0, checks: 0, vaccines: 0, appointments: 0 },
  };

  const adopterCache = new Map();
  for (const a of body.adopters || []) {
    const ref = String(a.ref || a.id || '').trim();
    const name = String(a.name || '').trim();
    if (!ref || !name) { summary.skipped.adopters++; continue; }
    const existing = db.adopters.find((x) => x.ref === ref || (x.source === 'import' && x.name === name && x.phone === (a.phone || '')));
    if (existing) { adopterCache.set(ref, existing); summary.skipped.adopters++; continue; }
    const row = {
      id: 'a' + (db.adopters.length ? Math.max(...db.adopters.map((x) => parseInt(x.id.slice(1)) || 0)) + 1 : 1),
      ref,
      name,
      phone: String(a.phone || '').trim(),
      createdAt: new Date().toISOString(),
      source: 'import',
      importedAt: new Date().toISOString(),
    };
    db.adopters.push(row);
    adopterCache.set(ref, row);
    summary.imported.adopters++;
  }

  const animalCache = new Map();
  for (const a of body.animals || []) {
    const ref = String(a.ref || a.id || '').trim();
    const name = String(a.name || '').trim();
    if (!ref || !name) { summary.skipped.animals++; continue; }
    const existing = db.animals.find((x) => x.ref === ref);
    if (existing) { animalCache.set(ref, existing); summary.skipped.animals++; continue; }
    const species = ['dog', 'cat', 'other'].includes(a.species) ? a.species : 'other';
    const row = {
      id: 'm' + (db.animals.length ? Math.max(...db.animals.map((x) => parseInt(x.id.slice(1)) || 0)) + 1 : 1),
      ref,
      name,
      species,
      arrivedAt: a.arrivedAt && parseDate(a.arrivedAt) ? a.arrivedAt : todayStr(),
      isolationDays: Number.isFinite(+a.isolationDays) ? +a.isolationDays | 0 : 14,
      createdAt: new Date().toISOString(),
      source: 'import',
      importedAt: new Date().toISOString(),
    };
    db.animals.push(row);
    animalCache.set(ref, row);
    summary.imported.animals++;
  }

  for (const c of body.checks || []) {
    const ref = String(c.ref || '').trim();
    const animal = c.animalRef ? animalCache.get(String(c.animalRef)) : getAnimal(c.animalId);
    const date = c.date && parseDate(c.date) ? c.date : null;
    const result = c.result === 'normal' || c.result === 'abnormal' ? c.result : null;
    if (!ref || !animal || !date || !result) { summary.skipped.checks++; continue; }
    if (db.checks.some((x) => x.ref === ref)) { summary.skipped.checks++; continue; }
    db.checks.push({
      id: 'c' + (db.checks.length ? Math.max(...db.checks.map((x) => parseInt(x.id.slice(1)) || 0)) + 1 : 1),
      ref,
      animalId: animal.id,
      date,
      result,
      note: String(c.note || '').trim(),
      source: 'import',
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    summary.imported.checks++;
  }

  for (const v of body.vaccines || []) {
    const ref = String(v.ref || '').trim();
    const animal = v.animalRef ? animalCache.get(String(v.animalRef)) : getAnimal(v.animalId);
    const date = v.date && parseDate(v.date) ? v.date : null;
    if (!ref || !animal || !date || !v.code) { summary.skipped.vaccines++; continue; }
    if (db.vaccines.some((x) => x.ref === ref)) { summary.skipped.vaccines++; continue; }
    const catalog = VACCINE_CATALOG[animal.species] || VACCINE_CATALOG.other;
    const meta = catalog.find((x) => x.code === v.code);
    db.vaccines.push({
      id: 'v' + (db.vaccines.length ? Math.max(...db.vaccines.map((x) => parseInt(x.id.slice(1)) || 0)) + 1 : 1),
      ref,
      animalId: animal.id,
      date,
      code: v.code,
      name: meta ? meta.name : v.name || v.code,
      source: 'import',
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    summary.imported.vaccines++;
  }

  const statusMap = {
    waiting: 'waiting',
    open: 'open',
    scheduled: 'open',
    pending_review: 'pending_review',
    review: 'pending_review',
    confirmed: 'confirmed',
    done: 'confirmed',
    cancelled: 'cancelled',
    canceled: 'cancelled',
  };

  for (const p of body.appointments || []) {
    const ref = String(p.ref || '').trim();
    const animal = p.animalRef ? animalCache.get(String(p.animalRef)) : getAnimal(p.animalId);
    const adopter = p.adopterRef ? adopterCache.get(String(p.adopterRef)) : getAdopter(p.adopterId);
    const status = statusMap[String(p.status || '').toLowerCase()];
    if (!ref || !animal || !adopter || !status) { summary.skipped.appointments++; continue; }
    if (db.appointments.some((x) => x.ref === ref)) { summary.skipped.appointments++; continue; }
    // 旧表若已经有一份有效预约占着，新导进来的“已排”降级为候补，仍按登记顺序排
    let finalStatus = status;
    if (status === 'open' && activeAppointment(animal.id)) finalStatus = 'waiting';
    if (['open', 'waiting'].includes(finalStatus)) {
      const eg = eligibility(animal);
      if (finalStatus === 'open' && !eg.ok) finalStatus = 'pending_review';
    }
    const nowIso = new Date().toISOString();
    db.appointments.push({
      id: 'p' + (db.appointments.length ? Math.max(...db.appointments.map((x) => parseInt(x.id.slice(1)) || 0)) + 1 : 1),
      ref,
      animalId: animal.id,
      adopterId: adopter.id,
      status: finalStatus,
      seq: ++db.seq,
      source: 'import',
      createdAt: nowIso,
      registeredAt: p.registeredAt && parseDate(p.registeredAt) ? new Date(p.registeredAt + 'T00:00:00Z').toISOString() : nowIso,
      importedAt: nowIso,
    });
    summary.imported.appointments++;
  }

  addEvent('imported', { summary });
  save();
  return summary;
}

// ---------------------------------------------------------------- 读视图

function buildView() {
  const animals = db.animals.map((animal) => {
    const eg = eligibility(animal);
    const live = liveAppointments(animal.id).sort((a, b) => a.seq - b.seq);
    const active = live.find((p) => p.status === 'open' || p.status === 'pending_review') || null;
    const waiting = live.filter((p) => p.status === 'waiting');
    return {
      ...animal,
      eligibility: eg,
      active: active ? decorate(active) : null,
      waiting: waiting.map(decorate),
      liveCount: live.length,
    };
  });

  return {
    now: new Date().toISOString(),
    today: todayStr(),
    vaccineCatalog: VACCINE_CATALOG,
    statusMeta: STATUS,
    adopters: db.adopters.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    animals,
    appointments: db.appointments.slice().sort((a, b) => b.seq - a.seq).map(decorate),
    checks: db.checks.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)),
    vaccines: db.vaccines.slice().sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)),
    events: db.events.slice(-30).reverse(),
  };
}

function decorate(p) {
  return {
    ...p,
    adopterName: getAdopter(p.adopterId)?.name || p.adopterId,
    adopterPhone: getAdopter(p.adopterId)?.phone || '',
    animalName: getAnimal(p.animalId)?.name || p.animalId,
    statusLabel: STATUS[p.status]?.label || p.status,
  };
}

// ---------------------------------------------------------------- HTTP

function httpError(status, message, extra = null) {
  const err = new Error(message);
  err.status = status;
  err.extra = extra;
  return err;
}

// 串行事务：所有写操作入同一队列，杜绝并发下的双确认 / 双名额
let chain = Promise.resolve();
function withTx(fn) {
  const run = chain.then(() => fn());
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(__dirname, 'public', rel));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      sendJson(res, 404, { error: '文件不存在' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, buildView());
    }

    const mutators = {
      '/api/adopters': createAdopter,
      '/api/animals': createAnimal,
      '/api/appointments/apply': applyAppointment,
      '/api/appointments/cancel': cancelAppointment,
      '/api/appointments/confirm': confirmAppointment,
      '/api/appointments/review': reviewAppointment,
      '/api/checks': addCheck,
      '/api/vaccines': addVaccine,
      '/api/import': importLegacy,
    };

    if (req.method === 'POST' && mutators[p]) {
      const body = await readBody(req);
      const result = await withTx(() => mutators[p](body));
      return sendJson(res, 200, { ok: true, result });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, p);
    }

    sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, { error: err.message || '服务器错误', extra: err.extra || null });
  }
});

load();
// 启动对账：把“已排好但动物当前不合格”的预约压到待复诊。
// 覆盖种子初始数据，以及重启后近 7 天窗口滑过 / 疫苗过期等情况。
(function reconcileOnStart() {
  let changed = false;
  for (const p of db.appointments) {
    if (p.status !== 'open') continue;
    const animal = getAnimal(p.animalId);
    if (!animal) continue;
    const { reasons } = eligibility(animal);
    if (reasons.length) {
      p.status = 'pending_review';
      addEvent('blocked', { appointmentId: p.id, animalId: animal.id, reasons, startup: true });
      changed = true;
    }
  }
  if (changed) save();
})();

server.listen(PORT, () => {
  console.log(`救助站领养管理台已启动：http://localhost:${PORT}`);
  console.log(`数据文件：${DB_FILE}（删除后重启可重新生成种子数据）`);
});
