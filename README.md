# 🐾 救助站领养管理台

零依赖的网页小台：Node 内置 `http` 提供服务，数据整体落盘到 `data/db.json`（原子写），
**重启后原样继续使用**；删除 `data/db.json` 再启动可回到内置的示例数据。

## 启动

```bash
node server.js
# 打开 http://localhost:3000
# 换端口：PORT=8080 node server.js
```

无需 `npm install`（Node ≥ 18）。

## 规则实现

- **开放三条件同时满足才可领走**：隔离期满（默认到店 14 天，可按动物设置）＋
  近 7 天内有体检且最新一条正常 ＋ 该物种要求的疫苗全部在有效期内。
  不满足时新申请直接被拒，卡片与接口响应都列出**具体阻塞原因**。
- **同一动物只有一份有效预约**（`open`/`pending_review`），其余申请按登记顺序进入
  `waiting` 候补队列；同一领养人对同一动物不能重复占位。
- **并发确认只成功一笔**：所有写操作进入服务端同一串行事务队列，第二次确认拿到的
  状态已不是 `open`，返回 409。确认成功后其余候补自动关闭。
- **取消后自动递补**：有效预约取消时，候补按 `seq`（登记顺序）第一位补上；
  若此时动物不达标（如体检已过期），递补上来的预约直接进 `待复诊` 而不是开放。
- **待复诊流转**：
  - 到店体检登记为异常（或近 7 天无正常体检、缺/过期疫苗）时，当前 `open` 预约
    立即转 `pending_review`，**动物不能领走**；待复诊状态下确认会被拒绝。
  - 补做体检/疫苗后必须人工**复核**：达标才恢复为 `open`，不达标保持待复诊并说明原因。
- **记录只追加、不覆盖**：体检和疫苗都是 append-only，“最新一条”决定当前事实，
  旧记录永远保留；补打疫苗新增一行。
- **旧表导入照常继续**：`POST /api/import` 按业务编号（`ref`）幂等去重，
  重复导入同一批数据全部跳过，**新记录绝不盖掉旧记录**；导入的预约同样进入
  状态机（`scheduled/review/done` 等旧状态词会映射），可继续取消/确认/复核。

## 页面能做什么

- 动物卡片：开放状态、**阻塞原因清单**、当前有效预约、候补队列（带顺序号）、
  最近体检与疫苗概况；支持筛选（可申请 / 已排 / 待复诊 / 未开放 / 有人候补 / 已领养）。
- 申请领养（选已有领养人或现场登记新领养人）、取消、确认（可同时登记到店异常）、
  登记复诊并复核、登记体检、补打疫苗、旧表 JSON 导入。
- 全部预约表、体检/疫苗记录表、操作流水（申请/候补/递补/阻塞/确认/取消/复核/导入均留痕）。
- 页面每 5 秒轮询一次，两个窗口同时操作可即时看到对方结果。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 页面所需的完整视图 |
| POST | `/api/appointments/apply` | `{animalId, adopterId}` 或 `{animalId, name, phone}` |
| POST | `/api/appointments/cancel` | `{appointmentId}`，自动递补 |
| POST | `/api/appointments/confirm` | `{appointmentId}`，并发第二笔 409 |
| POST | `/api/appointments/review` | `{appointmentId, note}`，达标才恢复 |
| POST | `/api/checks` | `{animalId, result: normal\|abnormal, date, note}` |
| POST | `/api/vaccines` | `{animalId, code, date}`（犬：rabies/distemper；猫：rabies/fvrcp） |
| POST | `/api/adopters`、`/api/animals` | 新增领养人 / 动物 |
| POST | `/api/import` | 旧表 JSON，按 `ref` 幂等去重 |

## 文件

```
server.js          # 零依赖服务：领域规则、串行事务、文件持久化、旧表导入
public/index.html  # 页面结构
public/styles.css
public/app.js
data/db.json       # 运行后生成；备份/复制此文件即可带走全部数据
```

## 内置示例数据

6 只动物（豆豆：已排+两名候补；花花：隔离未满；阿黄：体检异常待复诊；
咪咪：缺猫三联待复诊；煤球：可直接申请；大福：旧表导入的预约/记录）
和 6 位领养人，覆盖所有典型场景。
