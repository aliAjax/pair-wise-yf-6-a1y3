// 理赔判定：纯业务规则，不操作 DOM，也不直接读写 localStorage。

export const batchStatusLabels = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  withdrawn: "全部撤回"
};

export const itemStatusLabels = {
  locked: "审核中",
  withdrawn: "已撤回",
  approved: "已赔付",
  rejected: "已驳回"
};

export const reasonLabels = {
  paid: "已理赔过",
  uninsured: "未投保（旧事项）",
  "not-done": "状态不是已完成",
  "zero-cost": "费用为零",
  "no-photo": "缺少照片链接",
  locked: "已在待审核理赔批次中",
  missing: "事项不存在"
};

// 入批资格：已投保、已完成、费用大于零、有照片链接、且未理赔过。
// 返回 null 表示可入批，否则返回不可入批的原因。
export function eligibilityReason(repair) {
  if (!repair) return "missing";
  if (repair.paidClaimId) return "paid";
  if (!repair.insured) return "uninsured";
  if (repair.status !== "done") return "not-done";
  if (!(Number(repair.cost) > 0)) return "zero-cost";
  if (!String(repair.photo || "").trim()) return "no-photo";
  return null;
}

// 未结理赔 = 待审核批次中仍处于锁定状态的事项。
export function findOpenBatch(repairId, batches) {
  return (batches || []).find(
    (batch) =>
      batch.status === "pending" &&
      batch.items.some((item) => item.repairId === repairId && item.status === "locked")
  );
}

// 提交前整批校验：任一事项不合格或存在未结理赔，则整批拒绝。
// 只返回结论，不创建、不改动任何批次（原批次不动由调用方保证）。
export function validateSubmission(ids, repairs, batches) {
  if (!ids.length) {
    return { ok: false, code: "empty", message: "请先勾选要入批的维修事项" };
  }

  const byId = new Map(repairs.map((repair) => [repair.id, repair]));
  for (const id of ids) {
    const repair = byId.get(id);
    const name = repair ? `「${repair.location} · ${repair.title}」` : "该事项";

    if (!repair) {
      return {
        ok: false,
        code: "missing",
        message: `${name}已不存在，整批拒绝，原批次未改动`
      };
    }

    const reason = eligibilityReason(repair);
    if (reason) {
      return {
        ok: false,
        code: "ineligible",
        reason,
        message: `${name}${reasonLabels[reason]}，不满足入批条件，整批拒绝，原批次未改动`
      };
    }

    const openBatch = findOpenBatch(id, batches);
    if (openBatch) {
      return {
        ok: false,
        code: "conflict",
        batchId: openBatch.id,
        message: `${name}已有未结理赔（批次 ${openBatch.code}），整批拒绝，原批次未改动`
      };
    }
  }

  return { ok: true };
}

// 校验通过后按快照建批，入批事项此后被锁定。
export function createBatch(ids, repairs, now = new Date()) {
  const at = now.toISOString();
  const id = crypto.randomUUID();
  const byId = new Map(repairs.map((repair) => [repair.id, repair]));

  return {
    id,
    code: `BX${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    createdAt: at,
    status: "pending",
    decidedAt: null,
    rejectReason: null,
    payoutTotal: 0,
    events: [{ type: "created", at, text: "批次提交，进入待审核，所选事项已锁定" }],
    items: ids.map((repairId) => {
      const repair = byId.get(repairId);
      return {
        repairId,
        location: repair.location,
        title: repair.title,
        cost: Number(repair.cost),
        photo: repair.photo,
        status: "locked",
        payout: null,
        events: [{ type: "locked", at, text: `入批锁定，登记费用 ¥${repair.cost}，照片链接已存档` }]
      };
    })
  };
}

// 费用、照片或状态发生改动时，自动撤回该事项；批次记录与事项历史全部保留。
// 若批次内已无锁定事项，批次整体关闭。
export function withdrawItem(batch, item, changes, now = new Date()) {
  const at = now.toISOString();
  const parts = [];
  if (changes.cost) parts.push(`费用 ¥${changes.cost.from} → ¥${changes.cost.to}`);
  if (changes.photo) parts.push("照片链接已更换");
  if (changes.status) {
    parts.push(`状态由「${statusText(changes.status.from)}」改为「${statusText(changes.status.to)}」`);
  }

  item.status = "withdrawn";
  item.events.push({
    type: "withdrawn",
    at,
    text: `关键字段改动，自动撤回该事项（${parts.join("，")}），历史保留`
  });
  batch.events.push({
    type: "item-withdrawn",
    at,
    text: `「${item.location} · ${item.title}」因信息改动自动撤回`
  });

  if (!batch.items.some((entry) => entry.status === "locked")) {
    batch.status = "withdrawn";
    batch.decidedAt = at;
    batch.events.push({ type: "closed", at, text: "批次内事项已全部撤回，批次关闭" });
  }
}

// 审核：reject 为驳回（释放事项）；approve 需登记赔付额，
// 赔付额高于该事项费用或无效时，整批拒绝并释放全部锁定事项。
export function decideBatch(batch, action, payouts = {}, now = new Date()) {
  if (batch.status !== "pending") {
    return { ok: false, message: "该批次已结案，不能重复审核" };
  }

  const at = now.toISOString();
  const locked = batch.items.filter((item) => item.status === "locked");

  if (!locked.length) {
    return { ok: false, message: "批次内没有待审核的锁定事项" };
  }

  if (action === "reject") {
    for (const item of locked) {
      item.status = "rejected";
      item.events.push({ type: "rejected", at, text: "批次审核驳回，事项已释放" });
    }
    batch.status = "rejected";
    batch.decidedAt = at;
    batch.events.push({ type: "rejected", at, text: `审核驳回，${locked.length} 个锁定事项已释放` });
    return { ok: true, action: "rejected" };
  }

  // 审核通过：先逐项登记并校验赔付额。
  const planned = locked.map((item) => {
    const payout = Number(payouts[item.repairId]);
    return { item, payout };
  });

  for (const { item, payout } of planned) {
    if (!Number.isFinite(payout) || payout < 0) {
      return rejectForPayout(batch, locked, at, `赔付额无效（「${item.location} · ${item.title}」）`);
    }
    if (payout > item.cost) {
      return rejectForPayout(
        batch,
        locked,
        at,
        `「${item.location} · ${item.title}」赔付额 ¥${payout} 高于费用 ¥${item.cost}`
      );
    }
  }

  let total = 0;
  for (const { item, payout } of planned) {
    item.status = "approved";
    item.payout = payout;
    total += payout;
    item.events.push({ type: "approved", at, text: `审核通过，登记赔付额 ¥${payout}` });
  }
  batch.status = "approved";
  batch.decidedAt = at;
  batch.payoutTotal = total;
  batch.events.push({
    type: "approved",
    at,
    text: `审核通过，${locked.length} 个事项共登记赔付 ¥${total}`
  });
  return { ok: true, action: "approved", total };
}

function rejectForPayout(batch, locked, at, reason) {
  for (const item of locked) {
    item.status = "rejected";
    item.events.push({ type: "rejected", at, text: "赔付额不合规导致整批拒绝，事项已释放" });
  }
  batch.status = "rejected";
  batch.decidedAt = at;
  batch.rejectReason = reason;
  batch.events.push({ type: "rejected", at, text: `${reason}，整批拒绝，锁定事项全部释放` });
  return { ok: true, action: "rejected", code: "payout-exceeded", message: `${reason}，整批拒绝，事项已释放` };
}

function statusText(value) {
  return { todo: "待处理", doing: "处理中", done: "已完成" }[value] || value;
}
