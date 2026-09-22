// 理赔判定：只负责入批规则与批次状态流转，不接触 DOM 和 localStorage

export const CLAIM_STATUS = {
  pending: { label: "待审核", className: "pending" },
  approved: { label: "已通过", className: "approved" },
  rejected: { label: "已驳回", className: "rejected" }
};

export const CLAIM_ITEM_STATUS = {
  locked: "锁定中",
  withdrawn: "已撤回"
};

// 入批条件：已投保 + 已完成 + 费用大于零 + 有照片链接
export function getClaimIssues(repair) {
  const issues = [];
  if (!repair.insured) issues.push("未投保");
  if (repair.status !== "done") issues.push("仅已完成事项可入批");
  if (!(Number(repair.cost) > 0)) issues.push("费用需大于零");
  if (!String(repair.photo || "").trim()) issues.push("需要照片链接");
  return issues;
}

export function isClaimable(repair) {
  return getClaimIssues(repair).length === 0;
}

// 未结理赔 = 待审核批次中仍处于锁定状态的事项
export function findOpenClaim(claims, repairId) {
  for (const batch of claims) {
    if (batch.status !== "pending") continue;
    const item = batch.items.find(
      (entry) => entry.repairId === repairId && entry.status === "locked"
    );
    if (item) return { batch, item };
  }
  return null;
}

export function isRepairLocked(claims, repairId) {
  return findOpenClaim(claims, repairId) !== null;
}

export function findPaidClaim(claims, repairId) {
  for (const batch of claims) {
    if (batch.status !== "approved") continue;
    const item = batch.items.find((entry) => entry.repairId === repairId);
    if (item) return { batch, item };
  }
  return null;
}

function snapshotItem(repair) {
  return {
    repairId: repair.id,
    location: repair.location,
    title: repair.title,
    cost: Number(repair.cost) || 0,
    photo: String(repair.photo || "").trim(),
    status: "locked",
    withdrawnAt: null
  };
}

// 提交前整批校验：任一事项有未结理赔或不符合条件，则整批拒绝（不产生任何改动）
export function evaluateSubmission(claims, repairs, repairIds) {
  const ids = [...new Set(repairIds)];
  const selected = ids
    .map((id) => repairs.find((repair) => repair.id === id))
    .filter(Boolean);

  if (selected.length === 0) {
    return { ok: false, code: "EMPTY", reason: "请先勾选要入批的维修事项" };
  }

  const conflict = selected.find((repair) => findOpenClaim(claims, repair.id));
  if (conflict) {
    return {
      ok: false,
      code: "OPEN_CLAIM",
      repairId: conflict.id,
      reason: `「${conflict.location} · ${conflict.title}」已有未结理赔，整批拒绝，原批次未改动`
    };
  }

  const invalid = selected.find((repair) => !isClaimable(repair));
  if (invalid) {
    return {
      ok: false,
      code: "INELIGIBLE",
      repairId: invalid.id,
      reason: `「${invalid.location} · ${invalid.title}」不能入批：${getClaimIssues(invalid).join("、")}`
    };
  }

  const items = selected.map(snapshotItem);
  return {
    ok: true,
    items,
    totalCost: items.reduce((sum, item) => sum + item.cost, 0)
  };
}

export function createClaimBatch(
  { items, totalCost },
  now = new Date().toISOString(),
  id = crypto.randomUUID()
) {
  return {
    id,
    createdAt: now,
    status: "pending",
    items,
    totalCost,
    payout: null,
    rejectReason: "",
    reviewedAt: null
  };
}

// 事项的费用 / 照片 / 状态被改动时，从其待审核批次中撤回；批次与快照作为历史保留
export function withdrawFromOpenClaims(
  claims,
  repairId,
  now = new Date().toISOString()
) {
  let changed = false;
  const nextClaims = claims.map((batch) => {
    if (batch.status !== "pending") return batch;
    let batchChanged = false;
    const items = batch.items.map((item) => {
      if (item.repairId === repairId && item.status === "locked") {
        batchChanged = true;
        return { ...item, status: "withdrawn", withdrawnAt: now };
      }
      return item;
    });
    if (!batchChanged) return batch;
    changed = true;
    return { ...batch, items };
  });
  return { claims: nextClaims, changed };
}

export function getActiveItems(batch) {
  return batch.items.filter((item) => item.status === "locked");
}

export function getActiveCost(batch) {
  return getActiveItems(batch).reduce((sum, item) => sum + item.cost, 0);
}

function commitReview(claims, reviewedBatch, code) {
  return {
    code,
    status: reviewedBatch.status,
    payout: reviewedBatch.payout,
    reason: reviewedBatch.rejectReason,
    claims: claims.map((batch) =>
      batch.id === reviewedBatch.id ? reviewedBatch : batch
    )
  };
}

// 审核：通过需登记赔付额；赔付额高于在批费用则整批拒绝；驳回释放全部事项
export function reviewClaimBatch(claims, batchId, action, payout, now = new Date().toISOString()) {
  const batch = claims.find((item) => item.id === batchId);
  if (!batch || batch.status !== "pending") {
    return { error: "理赔批次不存在或已审结" };
  }

  if (action === "reject") {
    return commitReview(
      claims,
      { ...batch, status: "rejected", rejectReason: "审核驳回", reviewedAt: now, payout: null },
      "REJECTED"
    );
  }

  const amount = Number(payout);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "请输入不小于 0 的有效赔付额" };
  }
  if (getActiveItems(batch).length === 0) {
    return { error: "批次内事项均已撤回，请驳回该批次" };
  }

  const activeCost = getActiveCost(batch);
  if (amount > activeCost) {
    return commitReview(
      claims,
      {
        ...batch,
        status: "rejected",
        rejectReason: `赔付额 ¥${amount} 高于费用 ¥${activeCost}，整批拒绝`,
        reviewedAt: now,
        payout: null
      },
      "PAYOUT_EXCEEDS"
    );
  }

  return commitReview(
    claims,
    { ...batch, status: "approved", payout: amount, rejectReason: "", reviewedAt: now },
    "APPROVED"
  );
}

export function summarizeClaims(claims) {
  const summary = {
    pendingCount: 0,
    lockedCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    totalPayout: 0
  };
  for (const batch of claims) {
    if (batch.status === "pending") {
      summary.pendingCount += 1;
      summary.lockedCount += getActiveItems(batch).length;
    } else if (batch.status === "approved") {
      summary.approvedCount += 1;
      summary.totalPayout += Number(batch.payout || 0);
    } else {
      summary.rejectedCount += 1;
    }
  }
  return summary;
}
