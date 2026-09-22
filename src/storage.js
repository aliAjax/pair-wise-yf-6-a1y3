// 状态存储：localStorage 读写与旧数据迁移（旧事项按未投保处理，刷新保留）

export const STORAGE_KEY = "zfl-14-repairs";

export function createInitialState() {
  return {
    filter: "all",
    repairs: [
      {
        id: crypto.randomUUID(),
        location: "厨房",
        title: "水槽下方渗水",
        priority: "high",
        cost: 260,
        status: "todo",
        photo: "",
        note: "先检查软管接口",
        insured: true
      }
    ],
    claims: []
  };
}

function migrate(raw) {
  const state = {
    filter: raw.filter || "all",
    repairs: Array.isArray(raw.repairs) ? raw.repairs : [],
    claims: Array.isArray(raw.claims) ? raw.claims : []
  };

  // 旧版本数据没有 insured / claims 字段：旧事项一律按未投保处理
  state.repairs = state.repairs.map((repair) => ({
    id: repair.id,
    location: repair.location || "",
    title: repair.title || "",
    priority: repair.priority || "medium",
    cost: Number(repair.cost) || 0,
    status: repair.status || "todo",
    photo: repair.photo || "",
    note: repair.note || "",
    insured: repair.insured === true
  }));

  state.claims = state.claims.map((batch) => ({
    id: batch.id,
    createdAt: batch.createdAt || "",
    status: ["pending", "approved", "rejected"].includes(batch.status)
      ? batch.status
      : "rejected",
    items: Array.isArray(batch.items)
      ? batch.items.map((item) => ({
          repairId: item.repairId,
          location: item.location || "",
          title: item.title || "",
          cost: Number(item.cost) || 0,
          photo: item.photo || "",
          status: ["locked", "withdrawn"].includes(item.status) ? item.status : "withdrawn",
          withdrawnAt: item.withdrawnAt || null
        }))
      : [],
    totalCost: Number(batch.totalCost) || 0,
    payout: batch.payout == null ? null : Number(batch.payout) || 0,
    rejectReason: batch.rejectReason || "",
    reviewedAt: batch.reviewedAt || null
  }));

  return state;
}

export function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return createInitialState();
  try {
    return migrate(JSON.parse(saved));
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
