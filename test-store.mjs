import assert from "node:assert/strict";

// localStorage shim
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const { createStore, STORAGE_KEY, CLAIM_STORAGE_KEY } = await import("./src/store.js");

// 1. 旧数据迁移：没有 insured 字段 -> 未投保；刷新后保留
mem.set(
  STORAGE_KEY,
  JSON.stringify({
    filter: "done",
    repairs: [
      { id: "old-1", location: "客厅", title: "老问题", cost: 100, status: "done", photo: "http://x/1.jpg", note: "" },
      { id: "old-2", location: "次卧", title: "无照片", cost: 0, status: "todo", photo: "", note: "" }
    ]
  })
);
mem.delete(CLAIM_STORAGE_KEY);

let store = createStore();
ok(store.getRepair("old-1").insured === false, "旧事项按未投保处理");
ok(store.state.filter === "done", "刷新保留筛选状态");
const savedAfterLoad = JSON.parse(mem.get(STORAGE_KEY));
ok(savedAfterLoad.repairs[0].insured === false, "迁移结果写回存档");

// 2. 未投保旧事项不能入批
let res = store.submitClaim(["old-1"]);
ok(res.ok === false && res.code === "ineligible" && res.reason === "uninsured", "旧事项入批整批拒绝");

// 3. 新事项默认投保且满足条件可入批
store.addRepair({
  location: "阳台",
  title: "排水管",
  priority: "medium",
  cost: 480,
  status: "done",
  photo: "http://x/2.jpg",
  note: ""
});
const newRepair = store.state.repairs[0];
ok(newRepair.insured === true, "新事项默认已投保");
res = store.submitClaim([newRepair.id]);
ok(res.ok, "合格新事项可提交");
const batchId = res.batch.id;

// 存档同步：批次已写入 localStorage
ok(JSON.parse(mem.get(CLAIM_STORAGE_KEY)).length === 1, "批次同步到本地存档");

// 4. 锁定后再次提交同一事项 -> 冲突整批拒绝
res = store.submitClaim([newRepair.id]);
ok(res.code === "conflict", "未结理赔冲突");
ok(JSON.parse(mem.get(CLAIM_STORAGE_KEY))[0].items[0].status === "locked", "原批次未动");

// 5. 锁定中不能删除
res = store.deleteRepair(newRepair.id);
ok(res.ok === false, "锁定事项禁止删除");

// 状态下拉被锁定时由 UI 禁用；直接调用 setStatus 模拟绕过 -> 自动撤回
res = store.setStatus(newRepair.id, "doing");
ok(res.withdrawn, "状态改动自动撤回该事项");
const batchOnDisk = JSON.parse(mem.get(CLAIM_STORAGE_KEY))[0];
ok(batchOnDisk.items[0].status === "withdrawn", "撤回状态已存档");
ok(batchOnDisk.items[0].events.length >= 2, "事项历史保留");
ok(batchOnDisk.status === "withdrawn", "唯一事项撤回后批次关闭");

// 撤回后事项释放，可删除
ok(store.deleteRepair(newRepair.id).ok, "撤回后可删除");

// 6. 新批次：费用改动撤回、照片改动撤回
store.addRepair({
  location: "卫生间", title: "风扇", priority: "low",
  cost: 150, status: "done", photo: "http://x/f.jpg", note: ""
});
const r1 = store.state.repairs[0];
store.addRepair({
  location: "厨房", title: "龙头", priority: "high",
  cost: 90, status: "done", photo: "http://x/t.jpg", note: ""
});
const r2 = store.state.repairs[0];
res = store.submitClaim([r1.id, r2.id]);
const bx = res.batch;

res = store.updateRepair(r1.id, { ...store.getRepair(r1.id), cost: 160 });
ok(res.withdrawn && bx.status === "pending", "改费用撤回单事项，批次仍待审");
res = store.updateRepair(r2.id, { ...store.getRepair(r2.id), photo: "http://x/t2.jpg" });
ok(res.withdrawn && bx.status === "withdrawn", "改照片撤回，批次关闭");

// 备注/优先级改动不触发撤回（新批次验证）
store.addRepair({
  location: "书房", title: "插座", priority: "low",
  cost: 60, status: "done", photo: "http://x/s.jpg", note: ""
});
const r3 = store.state.repairs[0];
res = store.submitClaim([r3.id]);
const bz = res.batch;
res = store.updateRepair(r3.id, { ...store.getRepair(r3.id), note: "仅改备注", priority: "high" });
ok(!res.withdrawn && bz.status === "pending", "非关键字段不撤回");

// 7. 审核通过登记赔付并写回事项
res = store.reviewClaim(bz.id, "approve", { [r3.id]: 55 });
ok(res.ok && bz.status === "approved", "审核通过");
ok(store.getRepair(r3.id).paidClaimId === bz.id, "事项登记已理赔");
ok(store.getRepair(r3.id).claimPayout === 55, "事项登记赔付额");
ok(store.getStats().payoutTotal === 55, "累计赔付统计同步");

// 已理赔事项不能再次入批
res = store.submitClaim([r3.id]);
ok(res.reason === "paid", "已理赔事项不可再入批");

// 8. 驳回释放
store.addRepair({
  location: "玄关", title: "门锁", priority: "medium",
  cost: 120, status: "done", photo: "http://x/d.jpg", note: ""
});
const r4 = store.state.repairs[0];
res = store.submitClaim([r4.id]);
const bw = res.batch;
res = store.reviewClaim(bw.id, "reject");
ok(res.ok && res.releasedIds.includes(r4.id), "驳回释放事项");
ok(store.deleteRepair(r4.id).ok, "释放后可删除/可重新入批");

// 9. 赔付高于费用 -> 整批拒绝
store.addRepair({
  location: "阳台", title: "窗户", priority: "low",
  cost: 200, status: "done", photo: "http://x/w.jpg", note: ""
});
const r5 = store.state.repairs[0];
res = store.submitClaim([r5.id]);
res = store.reviewClaim(res.batch.id, "approve", { [r5.id]: 201 });
ok(res.ok && res.code === "payout-exceeded", "超额赔付整批拒绝");
ok(store.getRepair(r5.id).paidClaimId === null, "被拒事项未登记理赔，已释放");

// 10. 刷新：重新 createStore 数据与批次都保留
const store2 = createStore();
ok(store2.state.repairs.some((r) => r.title === "窗户"), "刷新后事项保留");
const batches2 = JSON.parse(mem.get(CLAIM_STORAGE_KEY));
ok(batches2.some((b) => b.code.startsWith("BX")), "刷新后批次保留");
ok(store2.getStats().payoutTotal === 55, "刷新后统计一致");

console.log(`\n存储层 ${passed} 条断言全部通过 ✅`);
