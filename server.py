# -*- coding: utf-8 -*-
"""
救助站领养管理台 —— 零依赖实现（Python 标准库 + SQLite）

设计要点：
- 数据全部落在 shelter.db，重启进程后继续使用，不会重建。
- 预约与体检事件均为“只追加”（append-only events / health_exams），
  新记录永远不覆盖旧记录；旧表导入用 import_batches 防重复导入。
- “同一动物只有一份有效预约”由 DB 唯一索引 partial unique index 兜底，
  配合事务 + BEGIN IMMEDIATE，两人同时确认/申请只有一笔成功。
- 开放资格三条件：隔离期满、近 7 天内最近一次体检正常、疫苗齐全。
"""

import json
import os
import sqlite3
import sys
import threading
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SHELTER_DB", os.path.join(BASE_DIR, "shelter.db"))
STATIC_DIR = os.path.join(BASE_DIR, "static")
HOST = os.environ.get("SHELTER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SHELTER_PORT", "8080"))

REQUIRED_VAX = {
    "猫": ["猫三联", "狂犬疫苗"],
    "狗": ["犬四联", "狂犬疫苗"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS animals(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  species TEXT NOT NULL,
  quarantine_until TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  external_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adopters(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  external_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vaccine_records(
  id INTEGER PRIMARY KEY,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  vaccine TEXT NOT NULL,
  vaccinated_on TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health_exams(
  id INTEGER PRIMARY KEY,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  exam_type TEXT NOT NULL,          -- routine(定期/近7天体检) | in_store(到店体检)
  result TEXT NOT NULL,             -- normal | abnormal
  notes TEXT NOT NULL DEFAULT '',
  exam_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY,
  animal_id INTEGER NOT NULL REFERENCES animals(id),
  adopter_id INTEGER NOT NULL REFERENCES adopters(id),
  status TEXT NOT NULL,             -- waiting | active | pending_recheck | cancelled | completed
  blocked_reasons TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'app',
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_events(
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches(
  id INTEGER PRIMARY KEY,
  batch_code TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL
);

-- 核心约束：每只动物至多一份“占名额”的有效预约（active / pending_recheck）；
-- waiting 是候补，允许多人排队，不占唯一名额。
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_live_reservation
  ON reservations(animal_id)
  WHERE status IN ('active','pending_recheck');

CREATE INDEX IF NOT EXISTS idx_exams_animal ON health_exams(animal_id);
CREATE INDEX IF NOT EXISTS idx_vax_animal ON vaccine_records(animal_id);
CREATE INDEX IF NOT EXISTS idx_resv_animal ON reservations(animal_id);
CREATE INDEX IF NOT EXISTS idx_events_resv ON reservation_events(reservation_id);
"""


def now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def today():
    return datetime.date.today()


def iso_date(d):
    return d.isoformat()


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- 数据库

def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def add_animal(conn, name, species, quarantine_until, source="seed", external_id=None):
    cur = conn.execute(
        "INSERT INTO animals(name,species,quarantine_until,source,external_id,created_at)"
        " VALUES(?,?,?,?,?,?)",
        (name, species, quarantine_until, source, external_id, now()),
    )
    return cur.lastrowid


def add_adopter(conn, name, phone, source="seed", external_id=None):
    cur = conn.execute(
        "INSERT INTO adopters(name,phone,source,external_id,created_at)"
        " VALUES(?,?,?,?,?)",
        (name, phone, source, external_id, now()),
    )
    return cur.lastrowid


def add_vax(conn, animal_id, vaccine, date_str, source="seed"):
    conn.execute(
        "INSERT INTO vaccine_records(animal_id,vaccine,vaccinated_on,source,created_at)"
        " VALUES(?,?,?,?,?)",
        (animal_id, vaccine, date_str, source, now()),
    )


def add_exam(conn, animal_id, exam_type, result, notes, date_str, source="seed"):
    conn.execute(
        "INSERT INTO health_exams(animal_id,exam_type,result,notes,exam_date,source,created_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (animal_id, exam_type, result, notes, date_str, source, now()),
    )


def add_reservation(conn, animal_id, adopter_id, status, source="app", external_id=None,
                    blocked_reasons=None):
    ts = now()
    cur = conn.execute(
        "INSERT INTO reservations(animal_id,adopter_id,status,blocked_reasons,source,"
        "external_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        (animal_id, adopter_id, status, json.dumps(blocked_reasons or [], ensure_ascii=False),
         source, external_id, ts, ts),
    )
    return cur.lastrowid


def log_event(conn, reservation_id, kind, detail="", source="app"):
    conn.execute(
        "INSERT INTO reservation_events(reservation_id,kind,detail,source,created_at)"
        " VALUES(?,?,?,?,?)",
        (reservation_id, kind, detail, source, now()),
    )


def latest_exam(conn, animal_id):
    row = conn.execute(
        "SELECT * FROM health_exams WHERE animal_id=? ORDER BY exam_date DESC, id DESC LIMIT 1",
        (animal_id,),
    ).fetchone()
    return dict(row) if row else None


def missing_vaccines(conn, animal_id, species):
    had = {
        r["vaccine"]
        for r in conn.execute(
            "SELECT vaccine FROM vaccine_records WHERE animal_id=?", (animal_id,)
        )
    }
    return [v for v in REQUIRED_VAX.get(species, []) if v not in had]


def evaluate(conn, animal_row):
    """开放资格评估。返回 (open: bool, reasons: list[str])。"""
    reasons = []
    a = dict(animal_row)

    qdate = datetime.date.fromisoformat(a["quarantine_until"])
    if today() < qdate:
        reasons.append("隔离期未满（至 %s）" % a["quarantine_until"])

    ex = latest_exam(conn, a["id"])
    if ex is None:
        reasons.append("近 7 天无体检记录")
    else:
        ex_date = datetime.date.fromisoformat(ex["exam_date"])
        age = (today() - ex_date).days
        if 0 <= age <= 7 and ex["result"] == "normal":
            pass
        elif age > 7:
            reasons.append("近 7 天无正常体检（最近体检 %s，已过 %d 天）"
                           % (ex["exam_date"], age))
        else:  # 未来时间不会出现；最近一次异常
            etype = "到店体检" if ex["exam_type"] == "in_store" else "体检"
            reasons.append("%s异常（%s：%s）"
                           % (etype, ex["exam_date"], ex["notes"] or "异常"))

    miss = missing_vaccines(conn, a["id"], a["species"])
    if miss:
        reasons.append("缺疫苗：" + "、".join(miss))

    return (len(reasons) == 0, reasons)


def reservation_row_view(conn, r, wait_positions):
    a = conn.execute("SELECT * FROM animals WHERE id=?", (r["animal_id"],)).fetchone()
    p = conn.execute("SELECT * FROM adopters WHERE id=?", (r["adopter_id"],)).fetchone()
    return {
        "id": r["id"],
        "animal_id": r["animal_id"],
        "animal_name": a["name"],
        "adopter_id": r["adopter_id"],
        "adopter_name": p["name"],
        "adopter_phone": p["phone"],
        "status": r["status"],
        "source": r["source"],
        "blocked_reasons": json.loads(r["blocked_reasons"] or "[]"),
        "wait_position": wait_positions.get(r["id"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def build_state(conn):
    animals = []
    for a in conn.execute("SELECT * FROM animals ORDER BY id"):
        open_, reasons = evaluate(conn, a)
        exams = [
            dict(e) for e in conn.execute(
                "SELECT * FROM health_exams WHERE animal_id=? ORDER BY exam_date DESC, id DESC",
                (a["id"],),
            )
        ]
        vaccines = [
            dict(v) for v in conn.execute(
                "SELECT * FROM vaccine_records WHERE animal_id=? ORDER BY vaccinated_on, id",
                (a["id"],),
            )
        ]
        animals.append({
            "id": a["id"],
            "name": a["name"],
            "species": a["species"],
            "quarantine_until": a["quarantine_until"],
            "source": a["source"],
            "open": open_,
            "blocked_reasons": reasons,
            "exams": exams,
            "vaccines": vaccines,
        })

    rows = conn.execute("SELECT * FROM reservations ORDER BY id").fetchall()
    # 候补序号：每只动物按登记先后（created_at, id）
    wait_positions = {}
    by_animal = {}
    for r in rows:
        by_animal.setdefault(r["animal_id"], []).append(r)
    for aid, lst in by_animal.items():
        pos = 0
        for r in sorted(lst, key=lambda x: (x["created_at"], x["id"])):
            if r["status"] == "waiting":
                pos += 1
                wait_positions[r["id"]] = pos

    reservations = [reservation_row_view(conn, r, wait_positions) for r in rows]

    events = [
        dict(e) for e in conn.execute(
            "SELECT * FROM reservation_events ORDER BY id DESC LIMIT 200"
        )
    ]
    batches = [
        dict(b) for b in conn.execute("SELECT * FROM import_batches ORDER BY id")
    ]
    adopters = [
        {"id": x["id"], "name": x["name"], "phone": x["phone"]}
        for x in conn.execute("SELECT id,name,phone FROM adopters ORDER BY id")
    ]
    required_vax = REQUIRED_VAX

    return {
        "today": iso_date(today()),
        "animals": animals,
        "adopters": adopters,
        "reservations": reservations,
        "events": events,
        "imported_batches": batches,
        "required_vaccines": required_vax,
    }


# ---------------------------------------------------------------- 初始化种子数据

def seed_if_empty(conn):
    conn.executescript(SCHEMA)
    n = conn.execute("SELECT COUNT(*) c FROM animals").fetchone()["c"]
    if n:
        return False
    do_seed(conn)
    return True


def do_seed(conn):
    """初始数据：几只动物 + 领养人 + 一只动物的正常预约。"""
    t = today()

    a1 = add_animal(conn, "小黄", "狗", iso_date(t - datetime.timedelta(days=20)))
    a2 = add_animal(conn, "橘橘", "猫", iso_date(t - datetime.timedelta(days=15)))
    a3 = add_animal(conn, "黑豆", "狗", iso_date(t - datetime.timedelta(days=10)))
    a4 = add_animal(conn, "雪雪", "猫", iso_date(t + datetime.timedelta(days=3)))
    a5 = add_animal(conn, "旺财", "狗", iso_date(t - datetime.timedelta(days=12)))
    a6 = add_animal(conn, "煤球", "猫", iso_date(t - datetime.timedelta(days=18)))

    p1 = add_adopter(conn, "王芳", "13800000001")
    p2 = add_adopter(conn, "李强", "13800000002")
    p3 = add_adopter(conn, "赵敏", "13800000003")
    p4 = add_adopter(conn, "陈杰", "13800000004")
    p5 = add_adopter(conn, "周婷", "13800000005")

    # 小黄：齐全、近 7 天正常、隔离已满 —— 开放
    add_vax(conn, a1, "犬四联", iso_date(t - datetime.timedelta(days=18)))
    add_vax(conn, a1, "狂犬疫苗", iso_date(t - datetime.timedelta(days=18)))
    add_exam(conn, a1, "routine", "normal", "状态良好",
             iso_date(t - datetime.timedelta(days=2)))

    # 橘橘：齐全、正常 —— 开放
    add_vax(conn, a2, "猫三联", iso_date(t - datetime.timedelta(days=14)))
    add_vax(conn, a2, "狂犬疫苗", iso_date(t - datetime.timedelta(days=14)))
    add_exam(conn, a2, "routine", "normal", "进食正常",
             iso_date(t - datetime.timedelta(days=1)))

    # 黑豆：疫苗齐全，但最近体检在 9 天前 —— 阻塞（近 7 天无正常体检）
    add_vax(conn, a3, "犬四联", iso_date(t - datetime.timedelta(days=9)))
    add_vax(conn, a3, "狂犬疫苗", iso_date(t - datetime.timedelta(days=9)))
    add_exam(conn, a3, "routine", "normal", "",
             iso_date(t - datetime.timedelta(days=9)))

    # 雪雪：隔离中
    add_vax(conn, a4, "猫三联", iso_date(t - datetime.timedelta(days=2)))
    add_vax(conn, a4, "狂犬疫苗", iso_date(t - datetime.timedelta(days=2)))
    add_exam(conn, a4, "routine", "normal", "", iso_date(t - datetime.timedelta(days=1)))

    # 旺财：缺狂犬疫苗
    add_vax(conn, a5, "犬四联", iso_date(t - datetime.timedelta(days=11)))
    add_exam(conn, a5, "routine", "normal", "", iso_date(t - datetime.timedelta(days=3)))

    # 煤球：近一次体检异常
    add_vax(conn, a6, "猫三联", iso_date(t - datetime.timedelta(days=16)))
    add_vax(conn, a6, "狂犬疫苗", iso_date(t - datetime.timedelta(days=16)))
    add_exam(conn, a6, "routine", "normal", "", iso_date(t - datetime.timedelta(days=10)))
    add_exam(conn, a6, "routine", "abnormal", "轻微猫癣，已上药",
             iso_date(t - datetime.timedelta(days=2)))

    # 小黄已有一份有效预约（王芳）
    rid = add_reservation(conn, a1, p1, "active")
    log_event(conn, rid, "apply", "初始预约登记")


# ---------------------------------------------------------------- 业务操作

def get_animal_or_404(conn, aid):
    a = conn.execute("SELECT * FROM animals WHERE id=?", (aid,)).fetchone()
    if not a:
        raise HttpError(404, "动物不存在")
    return a


def tx_apply(conn, animal_id, adopter_id):
    conn.execute("BEGIN IMMEDIATE")
    a = get_animal_or_404(conn, animal_id)
    ad = conn.execute("SELECT * FROM adopters WHERE id=?", (adopter_id,)).fetchone()
    if not ad:
        raise HttpError(404, "领养人不存在")

    open_, reasons = evaluate(conn, a)
    if not open_:
        raise HttpError(409, "该动物当前不开放：" + "；".join(reasons))

    live = conn.execute(
        "SELECT * FROM reservations WHERE animal_id=? AND status IN "
        "('waiting','active','pending_recheck')",
        (animal_id,),
    ).fetchall()
    if live:
        # 同一人重复登记直接提示，不产生第二条
        for r in live:
            if r["adopter_id"] == adopter_id:
                raise HttpError(409, "你已在该动物的领养序列中，无需重复申请")
        status = "waiting"
    else:
        status = "active"

    rid = add_reservation(conn, animal_id, adopter_id, status, source="app")
    log_event(conn, rid, "apply", "页面申请，状态=%s"
              % ("有效预约" if status == "active" else "候补"))
    conn.execute("COMMIT")
    return rid


def promote_next_waiting(conn, animal_id):
    """同一事务内：把登记最早的候补补为有效预约。返回被补位的预约 id 或 None。"""
    nxt = conn.execute(
        "SELECT * FROM reservations WHERE animal_id=? AND status='waiting'"
        " ORDER BY created_at, id LIMIT 1",
        (animal_id,),
    ).fetchone()
    if not nxt:
        return None
    conn.execute(
        "UPDATE reservations SET status='active', blocked_reasons='[]', updated_at=? WHERE id=?",
        (now(), nxt["id"]),
    )
    log_event(conn, nxt["id"], "promote", "前一份有效预约取消，按登记顺序候补补上")
    return nxt["id"]


def tx_cancel(conn, reservation_id, reason=""):
    conn.execute("BEGIN IMMEDIATE")
    r = conn.execute("SELECT * FROM reservations WHERE id=?",
                     (reservation_id,)).fetchone()
    if not r:
        raise HttpError(404, "预约不存在")
    if r["status"] not in ("waiting", "active", "pending_recheck"):
        raise HttpError(409, "该预约已结束，不能取消")

    was_live = r["status"] in ("active", "pending_recheck")
    conn.execute(
        "UPDATE reservations SET status='cancelled', blocked_reasons='[]', updated_at=? WHERE id=?",
        (now(), reservation_id),
    )
    log_event(conn, reservation_id, "cancel", reason or "领养人取消")

    promoted = None
    if was_live:
        promoted = promote_next_waiting(conn, r["animal_id"])
    conn.execute("COMMIT")
    return promoted


def tx_confirm(conn, reservation_id):
    conn.execute("BEGIN IMMEDIATE")
    r = conn.execute("SELECT * FROM reservations WHERE id=?",
                     (reservation_id,)).fetchone()
    if not r:
        raise HttpError(404, "预约不存在")
    if r["status"] != "active":
        labels = {"waiting": "候补中", "pending_recheck": "待复诊",
                  "cancelled": "已取消", "completed": "已完成"}
        raise HttpError(409, "当前状态为「%s」，不能确认领走" % labels[r["status"]])

    a = conn.execute("SELECT * FROM animals WHERE id=?", (r["animal_id"],)).fetchone()
    p = conn.execute("SELECT name FROM adopters WHERE id=?", (r["adopter_id"],)).fetchone()
    open_, reasons = evaluate(conn, a)

    if open_:
        add_exam(conn, a["id"], "in_store", "normal", "到店体检通过，确认领养", iso_date(today()),
                 source="app")
        conn.execute(
            "UPDATE reservations SET status='completed', blocked_reasons='[]', updated_at=? WHERE id=?",
            (now(), reservation_id),
        )
        log_event(conn, reservation_id, "confirm",
                  "到店体检正常、疫苗齐全，%s 已领走 %s" % (p["name"], a["name"]))
        promote_next_waiting(conn, a["id"])
        conn.execute("COMMIT")
        return {"result": "completed"}

    # 资格被挡：到店体检异常或缺疫苗 -> 待复诊，动物不能领走
    conn.execute(
        "UPDATE reservations SET status='pending_recheck', blocked_reasons=?, updated_at=? WHERE id=?",
        (json.dumps(reasons, ensure_ascii=False), now(), reservation_id),
    )
    log_event(conn, reservation_id, "to_recheck",
              "确认时未通过复核，转待复诊：" + "；".join(reasons))
    conn.execute("COMMIT")
    return {"result": "pending_recheck", "reasons": reasons}


def tx_recheck(conn, reservation_id, exam_result, notes, vaccines):
    """登记复诊：补录到店体检结果与补做的疫苗，系统复核资格。"""
    conn.execute("BEGIN IMMEDIATE")
    r = conn.execute("SELECT * FROM reservations WHERE id=?",
                     (reservation_id,)).fetchone()
    if not r:
        raise HttpError(404, "预约不存在")
    if r["status"] != "pending_recheck":
        raise HttpError(409, "仅「待复诊」预约可以登记复诊")

    aid = r["animal_id"]
    add_exam(conn, aid, "in_store", exam_result, notes or "", iso_date(today()),
             source="app")
    for v in vaccines or []:
        v = (v or "").strip()
        if v:
            add_vax(conn, aid, v, iso_date(today()), source="app")
            log_event(conn, reservation_id, "vaccine", "补做疫苗：" + v)

    a = conn.execute("SELECT * FROM animals WHERE id=?", (aid,)).fetchone()
    open_, reasons = evaluate(conn, a)
    if open_:
        conn.execute(
            "UPDATE reservations SET status='active', blocked_reasons='[]', updated_at=? WHERE id=?",
            (now(), reservation_id),
        )
        log_event(conn, reservation_id, "recheck_pass",
                  "复诊复核通过，恢复为有效预约（旧记录保留备查）")
        conn.execute("COMMIT")
        return {"result": "active"}

    conn.execute(
        "UPDATE reservations SET status='pending_recheck', blocked_reasons=?, updated_at=? WHERE id=?",
        (json.dumps(reasons, ensure_ascii=False), now(), reservation_id),
    )
    log_event(conn, reservation_id, "recheck_fail",
              "复诊复核仍未通过：" + "；".join(reasons))
    conn.execute("COMMIT")
    return {"result": "pending_recheck", "reasons": reasons}


def tx_import_legacy(conn, batch_code):
    """导入旧表：预约与体检记录照常进入系统继续处理，历史只追加不覆盖。"""
    conn.execute("BEGIN IMMEDIATE")
    exists = conn.execute("SELECT 1 FROM import_batches WHERE batch_code=?",
                          (batch_code,)).fetchone()
    if exists:
        raise HttpError(409, "旧表批次 %s 已导入，不能重复导入" % batch_code)

    ju = conn.execute("SELECT id FROM animals WHERE name='橘橘'").fetchone()
    hd = conn.execute("SELECT id FROM animals WHERE name='黑豆'").fetchone()
    if not ju or not hd:
        raise HttpError(409, "种子动物缺失，无法演示旧表导入")

    p5 = conn.execute("SELECT id FROM adopters WHERE name='周婷'").fetchone()["id"]
    t = today()

    # 旧表：橘橘有一份旧的有效预约（旧表登记的新领养人，照常继续处理；若名额已占则进候补）
    p_old = add_adopter(conn, "孙磊（旧表）", "13900001010", source="legacy",
                        external_id="OLD-P-009")
    ju_live = conn.execute(
        "SELECT COUNT(*) c FROM reservations WHERE animal_id=? AND status IN "
        "('active','pending_recheck')", (ju["id"],)
    ).fetchone()["c"]
    ju_status = "active" if ju_live == 0 else "waiting"
    r1 = add_reservation(conn, ju["id"], p_old, ju_status, source="legacy",
                         external_id="OLD-J-101")
    log_event(conn, r1, "import", "旧表导入预约 OLD-J-101，继续处理", source="legacy")
    log_event(conn, r1, "apply", "旧表登记申请", source="legacy")

    # 旧表：黑豆有一份预约，且旧体检记录显示到店体检异常、缺狂犬疫苗 -> 待复诊
    add_exam(conn, hd["id"], "in_store", "abnormal", "到店咳嗽，疑似上呼吸道感染",
             iso_date(t - datetime.timedelta(days=1)), source="legacy")
    r2 = add_reservation(conn, hd["id"], p5, "pending_recheck", source="legacy",
                         external_id="OLD-H-204",
                         blocked_reasons=["到店体检异常（旧表）", "缺疫苗：狂犬疫苗"])
    log_event(conn, r2, "import", "旧表导入预约 OLD-H-204 及异常体检，继续待复诊",
              source="legacy")
    log_event(conn, r2, "to_recheck", "旧表记录：到店体检异常、狂犬疫苗未做",
              source="legacy")

    conn.execute("INSERT INTO import_batches(batch_code,imported_at) VALUES(?,?)",
                 (batch_code, now()))
    conn.execute("COMMIT")
    return True


# ---------------------------------------------------------------- HTTP 服务

STATIC_FILES = {
    "/": ("static/index.html", "text/html; charset=utf-8"),
    "/index.html": ("static/index.html", "text/html; charset=utf-8"),
    "/app.js": ("static/app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("static/styles.css", "text/css; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise HttpError(400, "请求不是合法 JSON")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            conn = connect()
            try:
                self._send_json(build_state(conn))
            finally:
                conn.close()
            return
        if path == "/health":
            self._send_json({"ok": True})
            return
        if path in STATIC_FILES:
            rel, ctype = STATIC_FILES[path]
            full = os.path.join(BASE_DIR, rel)
            try:
                with open(full, "rb") as f:
                    body = f.read()
            except FileNotFoundError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            conn = connect()
            try:
                if path == "/api/apply":
                    tx_apply(conn, int(data["animal_id"]), int(data["adopter_id"]))
                elif path == "/api/cancel":
                    tx_cancel(conn, int(data["reservation_id"]), str(data.get("reason", "")))
                elif path == "/api/confirm":
                    tx_confirm(conn, int(data["reservation_id"]))
                elif path == "/api/recheck":
                    tx_recheck(
                        conn,
                        int(data["reservation_id"]),
                        "normal" if data.get("exam_result") == "normal" else "abnormal",
                        str(data.get("notes", "")),
                        data.get("vaccines", []) or [],
                    )
                elif path == "/api/import-legacy":
                    tx_import_legacy(conn, str(data.get("batch_code") or "2026-09-old"))
                else:
                    raise HttpError(404, "未知接口")
                self._send_json({"ok": True, "state": build_state(conn)})
            finally:
                conn.close()
        except HttpError as e:
            self._send_json({"ok": False, "error": e.message}, status=e.status)
        except (KeyError, TypeError, ValueError) as e:
            self._send_json({"ok": False, "error": "参数有误：%s" % e}, status=400)
        except sqlite3.IntegrityError as e:
            # 唯一索引兜底：并发下后到的那一笔
            self._send_json(
                {"ok": False,
                 "error": "该动物已有一份有效预约（系统拦截重复预约），请刷新查看候补"},
                status=409,
            )


def main():
    conn = connect()
    try:
        created = seed_if_empty(conn)
    finally:
        conn.close()
    if created:
        print("已初始化数据库 %s（种子数据）" % DB_PATH)
    else:
        print("沿用已有数据库 %s（重启继续使用，数据未重建）" % DB_PATH)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print("领养管理台已启动: http://%s:%d" % (HOST, PORT))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
