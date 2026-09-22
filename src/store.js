// 状态存储：localStorage 存档、旧数据迁移、维修事项与理赔批次的全部变更。

import {
  createBatch,
  decideBatch,
  eligibilityReason,
  findOpenBatch,
  validateSubmission,
  withdrawItem
} from "./claims.js";

export const STORAGE_KEY = "zfl-14-repairs";
export const CLAIM_STORAGE_KEY = "zfl-14-claim-batches";

export const statuses = {
  all: "全部",
  todo: "待处理",
  doing: "处理中",
  done: "已完成"
};

export const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

function seedRepairs() {
  return [
    {
      id: crypto.randomUUID(),
      location: "厨房",
      title: "水槽下方渗水",
      priority: "high",
      cost: 260,
      status: "todo",
      photo: "",
      note: "先检查软管接口",
      // 旧数据无 insured 字段，迁移时按未投保处理
      insured: false,
      paidClaimId: null
    },
    {
      id: crypto.randomUUID(),
      location: "阳台",
      title: "外墙排水管开裂",
      priority: "medium",
      cost: 480,
      status: "done",
      photo: "https://placehold.co/240x180?text=Balcony+Drain",
      note: "师傅已换管，留了发票",
      insured: true,
      paidClaimId: null
    },
    {
      id: crypto.randomUUID(),
      location: "卫生间",
      title: "排风扇异响",
      priority: "low",
      cost: 150,
      status: "done",
      photo: "https://placehold.co/240x180?text=Bathroom+Fan",
      note: "更换轴承后正常",
      insured: true,
      paidClaimId: null
    }
  ];
}

function normalizeRepair(repair) {
  return {
    paidClaimId: null,
    ...repair,
    // 旧事项没有投保标记，一律按未投保处理
    insured: repair.insured === true
  };
}

function normalizeBatch(batch) {
  return {
    decidedAt: null,
    rejectReason: null,
    payoutTotal: 0,
    events: [],
    ...batch,
    items: (batch.items || []).map((item) => ({
      payout: null,
      events: [],
      ...item
    }))
  };
}

export function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    return {
      filter: parsed.filter || "all",
      repairs: (parsed.repairs || []).map(normalizeRepair)
    };
  }
  return { filter: "all", repairs: seedRepairs() };
}

export function loadBatches() {
  const raw = localStorage.getItem(CLAIM_STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw).map(normalizeBatch);
  } catch {
    return [];
  }
}

// 列表、费用统计和本地存档同步的唯一入口。
export function createStore() {
  const state = loadState();
  let batches = loadBatches();

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify(batches));
  }

  persist();

  function getRepair(id) {
    return state.repairs.find((repair) => repair.id === id) || null;
  }

  // 若事项正被待审核批次锁定，记录关键字段改动（费用、照片、状态），
  // 触发自动撤回；备注、优先级等改动不影响锁定。
  function captureWithdrawal(repair, before, changes) {
    const batch = findOpenBatch(repair.id, batches);
    if (!batch) return null;
    const item = batch.items.find((entry) => entry.repairId === repair.id && entry.status === "locked");
    if (!item) return null;
    withdrawItem(batch, item, changes);
    return { batch, item };
  }

  function addRepair(data) {
    state.repairs.unshift({
      id: crypto.randomUUID(),
      location: data.location.trim(),
      title: data.title.trim(),
      priority: data.priority,
      cost: Number(data.cost || 0),
      status: data.status,
      photo: data.photo.trim(),
      note: data.note.trim(),
      // 新事项默认投保；旧事项按迁移结果处理
      insured: true,
      paidClaimId: null
    });
    persist();
  }

  // 编辑事项：费用/照片/状态在锁定时会自动撤回该事项（历史保留在批次内）。
  function updateRepair(id, data) {
    const repair = getRepair(id);
    if (!repair) return { ok: false, message: "事项不存在" };

    const before = { ...repair };
    const changes = {};
    if (Number(data.cost) !== Number(repair.cost)) {
      changes.cost = { from: Number(repair.cost), to: Number(data.cost) };
    }
    if (data.photo.trim() !== repair.photo) {
      changes.photo = { from: repair.photo, to: data.photo.trim() };
    }
    if (data.status !== repair.status) {
      changes.status = { from: repair.status, to: data.status };
    }

    repair.location = data.location.trim();
    repair.title = data.title.trim();
    repair.priority = data.priority;
    repair.cost = Number(data.cost || 0);
    repair.status = data.status;
    repair.photo = data.photo.trim();
    repair.note = data.note.trim();

    let withdrawal = null;
    if (Object.keys(changes).length) {
      withdrawal = captureWithdrawal(repair, before, changes);
    }
    persist();

    return {
      ok: true,
      withdrawn: withdrawal
        ? `关键字段已改动，该事项自动从批次 ${withdrawal.batch.code} 撤回，历史记录保留`
        : null
    };
  }

  function setStatus(id, status) {
    return updateRepair(id, { ...getRepair(id), status: String(status) });
  }

  // 待审核锁定中的事项不允许直接删除（必须先释放或撤回）。
  function deleteRepair(id) {
    if (findOpenBatch(id, batches)) {
      return { ok: false, message: "该事项在待审核理赔批次中已锁定，审核结束或撤回后才能删除" };
    }
    state.repairs = state.repairs.filter((repair) => repair.id !== id);
    persist();
    return { ok: true };
  }

  function setFilter(filter) {
    state.filter = filter;
    persist();
  }

  // 提交理赔批次：不合格或存在未结理赔则整批拒绝，原批次不动。
  function submitClaim(ids) {
    const result = validateSubmission(ids, state.repairs, batches);
    if (!result.ok) return result;

    const batch = createBatch(ids, state.repairs);
    batches.unshift(batch);
    persist();
    return {
      ok: true,
      batch,
      message: `批次 ${batch.code} 已提交，${batch.items.length} 个事项进入待审核并锁定`
    };
  }

  // 审核：通过需逐项登记赔付额，任一赔付额高于费用则整批拒绝；驳回释放事项。
  function reviewClaim(batchId, action, payouts = {}) {
    const batch = batches.find((entry) => entry.id === batchId);
    if (!batch) return { ok: false, message: "批次不存在" };

    const approvedIds = batch.items
      .filter((item) => item.status === "locked")
      .map((item) => item.repairId);

    const result = decideBatch(batch, action, payouts);
    if (!result.ok) return result;

    if (batch.status === "approved") {
      for (const item of batch.items.filter((entry) => entry.status === "approved")) {
        const repair = getRepair(item.repairId);
        if (repair) {
          repair.paidClaimId = batch.id;
          repair.claimPayout = item.payout;
        }
      }
    }
    persist();

    return {
      ...result,
      batch,
      releasedIds: batch.status === "rejected" ? approvedIds : [],
      message:
        result.message ||
        (batch.status === "approved"
          ? `批次 ${batch.code} 审核通过，共登记赔付 ¥${batch.payoutTotal}`
          : `批次 ${batch.code} 已驳回，${approvedIds.length} 个事项已释放`)
    };
  }

  // 费用统计与理赔数据统一从当前存档计算，保证列表/统计/存档同步。
  function getStats() {
    const unfinished = state.repairs.filter((repair) => repair.status !== "done");
    const pendingBatches = batches.filter((batch) => batch.status === "pending");
    const approvedBatches = batches.filter((batch) => batch.status === "approved");
    const payoutTotal = approvedBatches.reduce((sum, batch) => sum + Number(batch.payoutTotal || 0), 0);
    const claimedCount = state.repairs.filter((repair) => repair.paidClaimId).length;

    return {
      unfinishedCount: unfinished.length,
      doingCount: state.repairs.filter((repair) => repair.status === "doing").length,
      unfinishedCost: unfinished.reduce((sum, repair) => sum + Number(repair.cost || 0), 0),
      pendingBatchCount: pendingBatches.length,
      lockedCount: pendingBatches.reduce(
        (sum, batch) => sum + batch.items.filter((item) => item.status === "locked").length,
        0
      ),
      payoutTotal,
      claimedCount
    };
  }

  return {
    state,
    get batches() {
      return batches;
    },
    getRepair,
    addRepair,
    updateRepair,
    setStatus,
    deleteRepair,
    setFilter,
    submitClaim,
    reviewClaim,
    getStats
  };
}

export { eligibilityReason, findOpenBatch };
