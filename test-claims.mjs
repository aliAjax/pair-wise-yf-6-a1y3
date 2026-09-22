import assert from "node:assert/strict";
import {
  createBatch,
  decideBatch,
  eligibilityReason,
  findOpenBatch,
  validateSubmission,
  withdrawItem
} from "./src/claims.js";

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const mkRepair = (over = {}) => ({
  id: crypto.randomUUID(),
  location: "厨房",
  title: "渗水",
  cost: 100,
  status: "done",
  photo: "http://x/p.jpg",
  insured: true,
  paidClaimId: null,
  ...over
});

// 1. 入批资格
ok(eligibilityReason(mkRepair()) === null, "满足全部条件可入批");
ok(eligibilityReason(mkRepair({ status: "todo" })) === "not-done", "未完成拒绝");
ok(eligibilityReason(mkRepair({ cost: 0 })) === "zero-cost", "零费用拒绝");
ok(eligibilityReason(mkRepair({ photo: "  " })) === "no-photo", "无照片拒绝");
ok(eligibilityReason(mkRepair({ insured: false })) === "uninsured", "未投保拒绝");
ok(eligibilityReason(mkRepair({ paidClaimId: "b1" })) === "paid", "已理赔拒绝");

// 2. 空批 / 不存在
ok(validateSubmission([], [], []).ok === false, "空选择拒绝");
ok(validateSubmission(["nope"], [], []).code === "missing", "事项不存在拒绝");

// 3. 正常建批
const a = mkRepair();
const b = mkRepair({ cost: 300 });
let res = validateSubmission([a.id, b.id], [a, b], []);
ok(res.ok, "两个合格事项通过校验");
const batch = createBatch([a.id, b.id], [a, b]);
ok(batch.status === "pending", "新批次待审核");
ok(batch.items.every((i) => i.status === "locked"), "事项锁定");
ok(batch.items[0].cost === 100, "费用已快照");

// 4. 同一事项已有未结理赔 -> 整批拒绝，原批次不动
const c = mkRepair({ cost: 50 });
res = validateSubmission([a.id, c.id], [a, b, c], [batch]);
ok(res.ok === false && res.code === "conflict", "未结冲突整批拒绝");
ok(batch.status === "pending" && batch.items[0].status === "locked", "原批次不动");

// 5. findOpenBatch
ok(findOpenBatch(b.id, [batch]) === batch, "能找到未结批次");

// 6. 改动费用 -> 自动撤回该事项，历史保留；批次仍待审
const itemA = batch.items.find((i) => i.repairId === a.id);
withdrawItem(batch, itemA, { cost: { from: 100, to: 120 } }, new Date("2026-09-22T10:00:00Z"));
ok(itemA.status === "withdrawn", "事项撤回");
ok(itemA.events.some((e) => e.type === "withdrawn"), "撤回历史保留");
ok(batch.status === "pending", "还有锁定项，批次仍待审");

// 改照片/状态同样撤回
const itemB = batch.items.find((i) => i.repairId === b.id);
withdrawItem(batch, itemB, { photo: { from: "x", to: "y" } });
ok(itemB.status === "withdrawn", "照片改动撤回");
ok(batch.status === "withdrawn", "全部撤回后批次关闭");
ok(findOpenBatch(a.id, [batch]) === undefined, "撤回后不再有未结理赔");

// 7. 审核通过：赔付额 <= 费用
const d = mkRepair({ cost: 200 });
const e = mkRepair({ cost: 80 });
const b2 = createBatch([d.id, e.id], [d, e]);
res = decideBatch(b2, "approve", { [d.id]: 200, [e.id]: 70 });
ok(res.ok && b2.status === "approved", "审核通过");
ok(b2.payoutTotal === 270, "赔付合计 270");
ok(b2.items.find((i) => i.repairId === e.id).payout === 70, "逐项赔付登记");

// 8. 赔付额高于费用 -> 整批拒绝，全部释放
const f = mkRepair({ cost: 200 });
const g = mkRepair({ cost: 80 });
const b3 = createBatch([f.id, g.id], [f, g]);
res = decideBatch(b3, "approve", { [f.id]: 200, [g.id]: 90 });
ok(res.ok && b3.status === "rejected", "超额整批拒绝");
ok(b3.items.every((i) => i.status === "rejected"), "锁定事项全部释放（驳回态）");
ok(findOpenBatch(f.id, [b3]) === undefined, "拒绝后未结理赔消失，可重新入批");
ok(b3.rejectReason.includes("高于费用"), "拒绝原因已记录");

// 无效赔付额
const h = mkRepair({ cost: 100 });
const b4 = createBatch([h.id], [h]);
res = decideBatch(b4, "approve", { [h.id]: -5 });
ok(b4.status === "rejected", "负数赔付整批拒绝");

// 9. 驳回释放事项
const k = mkRepair();
const b5 = createBatch([k.id], [k]);
res = decideBatch(b5, "reject");
ok(res.ok && b5.status === "rejected", "驳回成功");
ok(b5.items[0].status === "rejected", "驳回后事项释放");

// 10. 已结案批次不能重复审核
ok(decideBatch(b5, "reject").ok === false, "重复审核拒绝");
ok(decideBatch({ ...b5, status: "withdrawn", items: [] }, "reject").ok === false, "已关闭批次拒绝");

console.log(`\n全部 ${passed} 条断言通过 ✅`);
