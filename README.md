# 库存呆滞分析与处置

一个可运行的库存呆滞（obsolescence）分析工作台：把入库、销售、退货、替代品和保质期放进同一张事实账本，按不同仓库/批次给出可解释的呆滞候选，并把处置动作走完「策略变更 → 审批 → 版本化任务 → 执行/回滚」的闭环。

零第三方运行时依赖，仅用 Node.js 内置的 `node:sqlite` 和 `node:http`，前端为原生 JS + SVG。

## 运行

```bash
node -v            # 需要 >= 22.5（node:sqlite）
npm start          # http://localhost:5178
npm run seed       # 重新生成 data/inventory.db
npm test           # 38 个测试（领域 30 + HTTP 8）
```

环境变量：`PORT`、`DB_FILE`、`SEED`（`0` 关闭首次自动播种）、`SEED_AS_OF`（演示业务日期）。
页面右上角「重置演示」会清库并重新播种。

## 可用量口径

同一批货在不同口径下数量不同，这是分析结论差异的主要来源：

| 口径 | 含义 |
|---|---|
| `physical` 在手 | 账本数量合计，含残损、质量冻结、已过期 |
| `good` 良品 | 在手 − 残损/冻结（仍含过期） |
| `available` 可用 | 良品 − 有效期内的货 − 已预留 |
| `sellable` 可售 | 可用 − 安全库存（按近 30 天动销 × 安全天数，从最接近到期的新批次先扣） |

`/api/stock/batches?caliber=...` 一次返回四种口径的数值，便于对比。呆滞分析的数量基数默认取策略里的 `caliber`，但**已过期/冻结批次的处置量始终取在手量**——它们本来就在所有可售口径之外。

## 事实账本与迟到销售

所有库存变动都是 `movements` 里的一行，按 `business_date` 入账：

- `external_ref` 全局唯一 → 入库/退货/调拨重复回传直接幂等忽略。
- 销售以 `sale_id` 为主键 → 同一笔销售重复回传返回 `duplicate`，**不会重复扣减**。
- `business_date` 是业务日期而非回传时间，**必填**：缺失时返回 `400 business_date is required`，不会以「今天」猜一个日子入账，也不会落成驱动层错误。
- 迟到销售（回传滞后 > 1 天）按**原业务日期**入账，只写一次分录；事后重放不会改变余额。
- 迟到销售回填时通过 `committedAfter` 避开「业务日期之后已经发生的出库」（报废/调拨），不会把已处置的库存重新占用或复活。

页面的「流水与迟到销售」标签会列出每笔迟到销售的实际分录，可直接核对只有一次扣减。

## 分析模型

`server/domain/strategy.js` 对每个批次给出**候选原因（可解释）+ 风险分 + 建议动作 + 替代方案**：

- 原因：已过期、质量冻结、临期、剩余货架期占比低、长期无销售、销售停滞、周转过慢、窗口内无动销、库存集中、存在跨仓缺口。
- 建议动作用**打分**而非硬规则：临期/滞销会加分给折价或调拨，但只有确实存在跨仓缺口时才允许调拨；已过期/冻结只可能报废或退供应商。
- 替代方案按可达性排序：调拨（有目标缺口）> 替代品（同 `substitute_group`）> 折价 > 报废。

## 策略变更

`GET /api/analysis/compare?to=<id>` 返回：

- **呆滞名单迁移**：新增 / 移出 / 动作变化 / 金额变化；
- **潜在缺货影响**：按新策略执行处置/调拨后，未来预测窗口内哪些仓库-SKU 会出现缺口。

`POST /api/strategies/:id/activate` 不带 `confirm` 时只返回预览；名单有迁移时必须带 `migration_acknowledged: true`，否则 409。每次切换都写 `strategy_migrations` 快照。

## 处置任务

计划（`plans`）→ 审批（生成任务）→ 任务版本（`task_versions`）→ 执行 / 回滚。

- 修订任务 = 追加新版本，旧版本标记 `superseded`，历史保留。
- 执行前先预览影响与阻断项；执行写 `TRANSFER_OUT/IN` 或 `DISPOSAL` 分录。
- 回滚写反向分录，可精确还原（测试覆盖调拨的「执行→回滚」后库存完全一致）。
- 已过期批次的报废回滚默认被阻断（避免复活不可售库存），可用 `force: true` + 书面原因强制，豁免项会写入审计。
- 跨仓调拨在创建、修订、执行三处都校验可用量。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/meta` | 口径、仓库、品类、策略 |
| GET | `/api/stock/batches` | 批次级四口径库存 |
| GET | `/api/stock/warehouses` | 仓库×SKU 汇总 |
| GET | `/api/stock/timeline` | 库存时间线（可下钻批次） |
| GET | `/api/stock/late-sales` | 迟到销售与分录 |
| POST | `/api/inbound` `/api/sales` `/api/returns` `/api/transfers/inbound` | 入库/销售/退货/调拨，支持数组批量 |
| GET/POST | `/api/strategies` | 列出/新建策略 |
| GET | `/api/analysis` `/api/analysis/compare` | 呆滞分析 / 策略对比 |
| POST | `/api/strategies/:id/activate` | 预览或激活 |
| POST | `/api/plans` `/api/plans/bulk` | 创建处置计划 |
| POST | `/api/plans/:id/approve` | 审批（生成任务）或驳回 |
| POST | `/api/tasks/:id/revise` | 修订任务（版本+1） |
| POST | `/api/tasks/:id/execute` | 预览或执行 |
| POST | `/api/tasks/:id/rollback` | 预览或回滚（可 force+reason） |
| GET | `/api/audit` `/api/ingestion-log` | 审计 / 幂等日志 |

## 代码结构

```
server/
  lib/db.js            schema、事务、连接
  lib/dates.js         日期工具
  domain/inventory.js  四口径库存、时间线、动销
  domain/ingest.js     入库/销售/退货/调拨、幂等、迟到销售
  domain/strategy.js   策略参数、呆滞诊断、迁移对比、缺货影响
  domain/plans.js      计划/任务/版本/执行/回滚
  domain/seed.js       覆盖全部规则的演示数据
  index.js             HTTP 路由 + 静态服务
web/                   原生 JS/SVG 单页
tests/                 node:test
```
