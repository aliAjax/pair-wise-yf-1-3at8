# -*- coding: utf-8 -*-
"""端到端场景验证（针对已运行的 server）。"""
import json
import threading
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8099"
fails = []


def call(path, payload=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def state():
    with urllib.request.urlopen(BASE + "/api/state") as r:
        return json.loads(r.read())


def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), name, extra)
    if not cond:
        fails.append(name)


def aid(s, nm):
    return next(a["id"] for a in s["animals"] if a["name"] == nm)


def rid_of(s, animal, adopter, status=None):
    out = [r for r in s["reservations"]
           if r["animal_name"] == animal and r["adopter_name"] == adopter
           and (status is None or r["status"] == status)]
    return out[0]["id"] if out else None


# 1. 小黄已有 active（王芳）。李强、赵敏申请 -> 候补 1/2；李强重复申请 -> 拒绝
s = state()
xh = aid(s, "小黄")
st, d = call("/api/apply", {"animal_id": xh, "adopter_id": 2})  # 李强
check("申请已占动物 -> 候补(李强)", d["ok"])
st, d = call("/api/apply", {"animal_id": xh, "adopter_id": 3})  # 赵敏
check("申请 -> 候补(赵敏)", d["ok"])
st, d = call("/api/apply", {"animal_id": xh, "adopter_id": 2})
check("同一人重复申请被拒", st == 409 and not d["ok"], str(st))

s = state()
liq = next(r for r in s["reservations"] if r["adopter_name"] == "李强" and r["animal_name"] == "小黄")
zhaom = next(r for r in s["reservations"] if r["adopter_name"] == "赵敏" and r["animal_name"] == "小黄")
check("李强候补第1", liq["status"] == "waiting" and liq["wait_position"] == 1, str(liq["wait_position"]))
check("赵敏候补第2", zhaom["status"] == "waiting" and zhaom["wait_position"] == 2, str(zhaom["wait_position"]))

# 2. 不开放动物申请被拒（黑豆：近7天无正常体检）
hd = aid(s, "黑豆")
st, d = call("/api/apply", {"animal_id": hd, "adopter_id": 1})
check("不开放动物拒绝申请", st == 409 and "近 7 天" in d["error"], d.get("error", ""))

# 3. 并发申请橘橘（陈杰/周婷同时），只允许一个 active，另一个 waiting
ju = aid(s, "橘橘")
results = {}
barrier = threading.Barrier(2)


def apply_concurrent(key, adopter):
    barrier.wait()
    results[key] = call("/api/apply", {"animal_id": ju, "adopter_id": adopter})


t1 = threading.Thread(target=apply_concurrent, args=("chen", 4))
t2 = threading.Thread(target=apply_concurrent, args=("zhou", 5))
t1.start(); t2.start(); t1.join(); t2.join()
oks = [v[1]["ok"] for v in results.values()]
check("并发申请两笔都被接收(1有效+1候补)", all(oks), str(results))
s = state()
ju_live = [r for r in s["reservations"] if r["animal_name"] == "橘橘"
           and r["status"] in ("active", "waiting")]
check("橘橘恰好一份有效+一份候补",
      len([r for r in ju_live if r["status"] == "active"]) == 1
      and len([r for r in ju_live if r["status"] == "waiting"]) == 1,
      str([(r["adopter_name"], r["status"], r["wait_position"]) for r in ju_live]))

# 4. 并发确认王芳的小黄预约 -> 只有一笔成功，completed，李强候补补位
wf = rid_of(s, "小黄", "王芳", "active")
conf = {}
b2 = threading.Barrier(2)


def confirm_concurrent(key):
    b2.wait()
    conf[key] = call("/api/confirm", {"reservation_id": wf})


t1 = threading.Thread(target=confirm_concurrent, args=("A",))
t2 = threading.Thread(target=confirm_concurrent, args=("B",))
t1.start(); t2.start(); t1.join(); t2.join()
ok_count = sum(1 for v in conf.values() if v[1]["ok"])
check("两人同时确认只有一笔成功", ok_count == 1,
      str({k: (v[0], v[1].get("ok"), v[1].get("error", "")) for k, v in conf.items()}))
s = state()
wf_r = next(r for r in s["reservations"] if r["id"] == wf)
check("小黄预约 completed（已领走）", wf_r["status"] == "completed", wf_r["status"])
liq_r = next(r for r in s["reservations"] if r["adopter_name"] == "李强" and r["animal_name"] == "小黄")
check("取消/完成后李强按序补为 active", liq_r["status"] == "active", liq_r["status"])
zhaom_r = next(r for r in s["reservations"] if r["adopter_name"] == "赵敏" and r["animal_name"] == "小黄")
check("赵敏升为候补第1", zhaom_r["wait_position"] == 1, str(zhaom_r["wait_position"]))

# 5. 取消李强 -> 赵敏补位
liq_id = liq_r["id"]
st, d = call("/api/cancel", {"reservation_id": liq_id, "reason": "放弃"})
check("取消有效预约成功", d["ok"])
s = state()
zhaom_r = next(r for r in s["reservations"] if r["id"] == zhaom_r["id"])
check("取消后赵敏补为 active", zhaom_r["status"] == "active", zhaom_r["status"])

# 6. 导入旧表
st, d = call("/api/import-legacy", {"batch_code": "2026-09-old"})
check("旧表首次导入成功", d["ok"], str(st))
st, d = call("/api/import-legacy", {"batch_code": "2026-09-old"})
check("旧表重复导入被拒", st == 409, d.get("error", ""))
s = state()
cj = next(r for r in s["reservations"] if r.get("id") and r["animal_name"] == "橘橘"
          and r["adopter_name"] == "孙磊（旧表）")
zt = next(r for r in s["reservations"] if r["animal_name"] == "黑豆"
          and r["adopter_name"] == "周婷")
check("旧表橘橘预约照常进队列", cj["source"] == "legacy" and cj["status"] in ("active", "waiting"),
      cj["status"])
check("旧表黑豆异常体检+缺疫苗 -> 待复诊", zt["status"] == "pending_recheck" and zt["source"] == "legacy",
      str(zt["blocked_reasons"]))

# 7. 黑豆待复诊：先登记一次异常（不补疫苗）-> 仍待复诊，原因保留
st, d = call("/api/recheck", {"reservation_id": zt["id"], "exam_result": "abnormal",
                              "notes": "仍有流涕", "vaccines": []})
check("复诊仍异常 -> 保持待复诊", d["ok"])
s = state()
zt_r = next(r for r in s["reservations"] if r["id"] == zt["id"])
check("待复诊阻塞原因可见", zt_r["status"] == "pending_recheck"
      and any("到店体检异常" in x for x in zt_r["blocked_reasons"]),
      str(zt_r["blocked_reasons"]))

# 8. 复诊正常 + 补狂犬疫苗 -> 复核通过 active；再确认 -> completed
st, d = call("/api/recheck", {"reservation_id": zt["id"], "exam_result": "normal",
                              "notes": "症状消失", "vaccines": ["狂犬疫苗"]})
check("复诊正常+补疫苗提交成功", d["ok"])
s = state()
hd_animal = next(a for a in s["animals"] if a["name"] == "黑豆")
check("黑豆复核后开放", hd_animal["open"], str(hd_animal["blocked_reasons"]))
zt_r = next(r for r in s["reservations"] if r["id"] == zt["id"])
check("黑豆预约恢复 active", zt_r["status"] == "active", zt_r["status"])
n_exams_before = len(hd_animal["exams"])
st, d = call("/api/confirm", {"reservation_id": zt["id"]})
check("恢复后确认领走成功", d["ok"])
s = state()
zt_r = next(r for r in s["reservations"] if r["id"] == zt["id"])
check("黑豆预约 completed", zt_r["status"] == "completed", zt_r["status"])
hd_animal = next(a for a in s["animals"] if a["name"] == "黑豆")
check("旧异常体检记录仍在（未被覆盖）",
      len(hd_animal["exams"]) == n_exams_before + 1
      and any(e["result"] == "abnormal" and e["source"] == "legacy" for e in hd_animal["exams"])
      and sum(1 for e in hd_animal["exams"] if e["result"] == "abnormal") == 2,
      "exam count=%d" % len(hd_animal["exams"]))

# 9. 取消候补不触发补位异常（橘橘候补取消）
cj_wait = [r for r in s["reservations"] if r["animal_name"] == "橘橘" and r["status"] == "waiting"]
if cj_wait:
    st, d = call("/api/cancel", {"reservation_id": cj_wait[0]["id"]})
    check("取消候补成功且不报错", d["ok"])

# 10. 每个动物至多一份有效预约（全局约束校验）
s = state()
for a in s["animals"]:
    live = [r for r in s["reservations"] if r["animal_id"] == a["id"]
            and r["status"] in ("active", "waiting", "pending_recheck")]
    n_eff = len([r for r in live if r["status"] in ("active", "pending_recheck")])
    check("动物 %s 至多一份有效预约" % a["name"], n_eff <= 1, str(n_eff))

print()
print("FAILED:", len(fails), fails if fails else "")
