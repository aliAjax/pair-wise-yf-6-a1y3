import "./styles.css";
import {
  CLAIM_STATUS,
  CLAIM_ITEM_STATUS,
  getClaimIssues,
  isClaimable,
  findOpenClaim,
  findPaidClaim,
  isRepairLocked,
  evaluateSubmission,
  createClaimBatch,
  withdrawFromOpenClaims,
  getActiveItems,
  getActiveCost,
  reviewClaimBatch,
  summarizeClaims
} from "./claims.js";
import { loadState, saveState } from "./storage.js";

const statuses = {
  all: "全部",
  todo: "待处理",
  doing: "处理中",
  done: "已完成"
};

const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

export function mountApp(root) {
  let state = loadState();
  const selectedIds = new Set();
  const payoutDrafts = {};
  let editingId = null;
  let notice = null;

  function persist() {
    saveState(state);
  }

  function flash(message, kind = "info") {
    notice = { message, kind };
    render();
  }

  function filteredRepairs() {
    if (state.filter === "all") return state.repairs;
    return state.repairs.filter((repair) => repair.status === state.filter);
  }

  // 改动费用 / 照片 / 状态时，自动从待审核批次撤回该事项并保留历史
  function updateRepair(repairId, patch) {
  const repair = state.repairs.find((item) => item.id === repairId);
    if (!repair) return false;
    const watched = ["cost", "photo", "status"];
    const triggersWithdraw = watched.some(
      (key) => key in patch && String(patch[key]).trim() !== String(repair[key] ?? "").trim()
    );
    Object.assign(repair, patch);

    if (triggersWithdraw && isRepairLocked(state.claims, repairId)) {
      const result = withdrawFromOpenClaims(state.claims, repairId);
      state.claims = result.claims;
      return "withdrew";
    }
    return true;
  }

  function render() {
    const repairs = filteredRepairs();
    const unfinished = state.repairs.filter((repair) => repair.status !== "done");
    const totalCost = unfinished.reduce((sum, repair) => sum + Number(repair.cost || 0), 0);
    const doing = state.repairs.filter((repair) => repair.status === "doing").length;
    const claimSummary = summarizeClaims(state.claims);
    const selectedRepairs = [...selectedIds]
      .map((id) => state.repairs.find((repair) => repair.id === id))
      .filter(Boolean);

    root.innerHTML = `
      <main class="shell">
        ${notice ? renderNotice(notice) : ""}
        <header class="header">
          <div>
            <p class="eyebrow">本地家庭维护台</p>
            <h1>家庭维修事项</h1>
          </div>
          <section class="stats">
            <div class="stat"><span>未完成</span><strong>${unfinished.length}</strong></div>
            <div class="stat"><span>处理中</span><strong>${doing}</strong></div>
            <div class="stat"><span>预计费用</span><strong>¥${totalCost}</strong></div>
            <div class="stat"><span>待审核批次</span><strong>${claimSummary.pendingCount}</strong></div>
            <div class="stat"><span>累计赔付</span><strong>¥${claimSummary.totalPayout}</strong></div>
          </section>
        </header>

        <section class="layout">
          <aside class="panel">
            <h2>${editingId ? "编辑维修事项" : "新增维修事项"}</h2>
            ${renderForm()}
          </aside>

          <section>
            <div class="toolbar">
              ${Object.entries(statuses)
                .map(
                  ([value, label]) =>
                    `<button class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
                )
                .join("")}
            </div>
            ${selectedRepairs.length ? renderBatchBar(selectedRepairs) : ""}
            <div class="repairs">
              ${repairs.length ? repairs.map(renderRepair).join("") : `<div class="empty">当前状态下没有维修事项</div>`}
            </div>
          </section>
        </section>

        ${renderClaimsSection(claimSummary)}
      </main>
    `;
  }

  function renderNotice(item) {
    return `
      <div class="notice ${item.kind}">
        <span>${escapeHtml(item.message)}</span>
        <button type="button" data-notice-close aria-label="关闭提示">×</button>
      </div>
    `;
  }

  function renderForm() {
    const editing = editingId
      ? state.repairs.find((repair) => repair.id === editingId)
      : null;
    const data = editing || {
      location: "",
      title: "",
      priority: "medium",
      cost: 0,
      status: "todo",
      photo: "",
      note: "",
      insured: true
    };
    const lockedHint =
      editing && isRepairLocked(state.claims, editing.id)
        ? `<p class="form-hint warn">该事项正在待审核批次中：保存对费用、照片或状态的改动会自动撤回，批次历史保留。</p>`
        : "";

    return `
      <form class="form" id="repair-form">
        <label>位置<input name="location" required placeholder="例如卫生间" value="${escapeHtml(data.location)}"></label>
        <label>问题描述<textarea name="title" required placeholder="例如门锁松动">${escapeHtml(data.title)}</textarea></label>
        <label>优先级<select name="priority">${renderPriorityOptions(data.priority)}</select></label>
        <label>预计费用<input name="cost" type="number" min="0" step="1" value="${Number(data.cost || 0)}"></label>
        <label>处理状态<select name="status">${renderStatusOptions(data.status)}</select></label>
        <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址" value="${escapeHtml(data.photo || "")}"></label>
        <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项">${escapeHtml(data.note || "")}</textarea></label>
        <label class="inline"><input type="checkbox" name="insured" value="on" ${data.insured ? "checked" : ""}>已投保（可参与保险理赔）</label>
        ${lockedHint}
        <button class="primary" type="submit">${editing ? "保存修改" : "保存事项"}</button>
        ${editing ? `<button class="ghost" type="button" id="cancel-edit">取消编辑</button>` : ""}
      </form>
    `;
  }

  function renderBatchBar(repairs) {
    const total = repairs.reduce((sum, repair) => sum + Number(repair.cost || 0), 0);
    return `
      <div class="batch-bar">
        <div>
          <strong>已选 ${repairs.length} 项</strong>
          <span>合计费用 ¥${total}</span>
        </div>
        <div class="actions">
          <button class="primary" type="button" data-submit-batch>提交理赔批次</button>
          <button class="ghost" type="button" data-clear-selection>清空选择</button>
        </div>
      </div>
    `;
  }

  function renderRepair(repair) {
    const locked = isRepairLocked(state.claims, repair.id);
    const open = findOpenClaim(state.claims, repair.id);
    const paid = findPaidClaim(state.claims, repair.id);
    const claimable = isClaimable(repair);
    const checked = selectedIds.has(repair.id);
    const canPick = !locked && claimable;
    const pickHint = locked
      ? `已有未结理赔（批次 #${open.batch.id.slice(0, 8)}），不能重复入批`
      : claimable
        ? "加入理赔批次"
        : getClaimIssues(repair).join("、");

    return `
      <article class="repair ${locked ? "locked" : ""}">
        <div class="photo">${repair.photo ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">` : "未添加照片"}</div>
        <div class="content">
          <div class="row">
            <h3>${escapeHtml(repair.location)}</h3>
            <span class="priority ${repair.priority}">${priorities[repair.priority] || repair.priority}</span>
            <span class="status ${repair.status}">${statuses[repair.status] || repair.status}</span>
            ${repair.insured ? `<span class="tag insured">已投保</span>` : `<span class="tag uninsured">未投保</span>`}
            ${locked ? `<span class="tag claim-locked">理赔锁定中 · #${open.batch.id.slice(0, 8)}</span>` : ""}
            ${!locked && paid ? `<span class="tag claim-done">已理赔</span>` : ""}
          </div>
          <p>${escapeHtml(repair.title)}</p>
          <div class="row">
            <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
            <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
          </div>
          <div class="actions">
            <label class="pick" title="${escapeHtml(pickHint)}">
              <input type="checkbox" data-select="${repair.id}" ${checked ? "checked" : ""} ${canPick ? "" : "disabled"}>
              入批
            </label>
            <select data-status="${repair.id}" ${locked ? `title="改动状态会自动从待审核批次撤回"` : ""}>${renderStatusOptions(repair.status)}</select>
            <button class="ghost" data-edit="${repair.id}">编辑</button>
            <button class="ghost" data-delete="${repair.id}" ${locked ? "disabled" : ""} title="${locked ? "理赔审核中，不能删除" : ""}">删除</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderClaimsSection(summary) {
    const batches = [...state.claims].reverse();
    return `
      <section class="claims">
        <div class="claims-head">
          <h2>保险理赔批次</h2>
          <p>待审核 ${summary.pendingCount} 批 · 锁定事项 ${summary.lockedCount} 项 · 已赔付 ¥${summary.totalPayout}</p>
        </div>
        ${batches.length ? `<div class="claim-list">${batches.map(renderClaimBatch).join("")}</div>` : `<div class="empty">还没有理赔批次。勾选「已完成、费用大于零、有照片」的已投保事项即可发起。</div>`}
      </section>
    `;
  }

  function renderClaimBatch(batch) {
    const meta = CLAIM_STATUS[batch.status];
    const activeCost = getActiveCost(batch);
    const activeCount = getActiveItems(batch).length;

    return `
      <article class="claim-card ${meta.className}">
        <div class="claim-head">
          <div>
            <h3>批次 #${batch.id.slice(0, 8)}</h3>
            <span class="claim-time">提交于 ${formatTime(batch.createdAt)}</span>
          </div>
          <span class="claim-status ${meta.className}">${meta.label}</span>
        </div>
        <ul class="claim-items">
          ${batch.items
            .map((item) => renderClaimItem(item, batch.status))
            .join("")}
        </ul>
        <div class="claim-foot">
          <div class="claim-summary">
            <span>入批 ${batch.items.length} 项 / 费用 ¥${batch.totalCost}</span>
            ${batch.items.length !== activeCount ? `<span>在批 ${activeCount} 项 / 费用 ¥${activeCost}</span>` : ""}
          </div>
          ${renderClaimActions(batch, activeCount, activeCost)}
          ${batch.status === "approved" ? `<p class="claim-result ok">审核通过（${formatTime(batch.reviewedAt)}）：赔付 <strong>¥${batch.payout}</strong></p>` : ""}
          ${batch.status === "rejected" ? `<p class="claim-result bad">${escapeHtml(batch.rejectReason || "审核驳回")}（${formatTime(batch.reviewedAt)}），事项已释放</p>` : ""}
        </div>
      </article>
    `;
  }

  function renderClaimItem(item) {
    const current = state.repairs.find((repair) => repair.id === item.repairId);
    return `
      <li class="claim-item ${item.status}">
        <span class="claim-item-state">${CLAIM_ITEM_STATUS[item.status]}</span>
        <span class="claim-item-name">${escapeHtml(item.location)} · ${escapeHtml(item.title)}</span>
        ${current ? "" : `<span class="chip warn">源事项已删除</span>`}
        <span class="chip">¥${item.cost}</span>
        ${item.photo ? `<a href="${escapeHtml(item.photo)}" target="_blank" rel="noopener noreferrer">查看照片</a>` : ""}
        ${item.withdrawnAt ? `<time>${formatTime(item.withdrawnAt)} 撤回</time>` : ""}
      </li>
    `;
  }

  function renderClaimActions(batch, activeCount, activeCost) {
    if (batch.status !== "pending") return "";
    const draft = payoutDrafts[batch.id] ?? String(activeCost);
    return `
      <div class="review-row">
        <label>赔付额
          <input type="number" min="0" step="1" data-payout="${batch.id}" value="${escapeHtml(draft)}" ${activeCount ? "" : "disabled"}>
        </label>
        <button class="primary" type="button" data-approve="${batch.id}" ${activeCount ? "" : "disabled"} title="${activeCount ? "" : "事项均已撤回，请驳回该批次"}">审核通过</button>
        <button class="danger" type="button" data-reject="${batch.id}">驳回并释放</button>
      </div>
      ${activeCount ? "" : `<p class="form-hint warn">批次内事项均已撤回，只能驳回。</p>`}
    `;
  }

  function renderStatusOptions(selected) {
    return Object.entries(statuses)
      .filter(([value]) => value !== "all")
      .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
      .join("");
  }

  function renderPriorityOptions(selected) {
    return Object.entries(priorities)
      .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
      .join("");
  }

  function bindEvents() {
    root.addEventListener("submit", (event) => {
      if (event.target.id !== "repair-form") return;
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      const payload = {
        location: data.location.trim(),
        title: data.title.trim(),
        priority: data.priority,
        cost: Number(data.cost || 0),
        status: data.status,
        photo: String(data.photo || "").trim(),
        note: String(data.note || "").trim(),
        insured: data.insured === "on"
      };

      if (editingId) {
        const result = updateRepair(editingId, payload);
        editingId = null;
        persist();
        render();
        flash(result === "withdrew" ? "修改已保存，该事项已自动从待审核批次撤回（历史保留）。" : "修改已保存。", result === "withdrew" ? "warn" : "success");
        return;
      }

      state.repairs.unshift({ id: crypto.randomUUID(), ...payload });
      persist();
      render();
      flash("维修事项已保存。", "success");
    });

    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter],[data-clear-selection],[data-submit-batch],[data-approve],[data-reject],[data-delete],[data-edit],[id='cancel-edit'],[data-notice-close]");
      if (!button) return;

      if (button.dataset.filter) {
        state.filter = button.dataset.filter;
        persist();
        render();
      } else if (button.dataset.clearSelection !== undefined) {
        selectedIds.clear();
        render();
      } else if (button.dataset.submitBatch !== undefined) {
        submitBatch();
      } else if (button.dataset.approve) {
        reviewBatch(button.dataset.approve, "approve", payoutDrafts[button.dataset.approve]);
      } else if (button.dataset.reject) {
        reviewBatch(button.dataset.reject, "reject");
      } else if (button.dataset.delete) {
        deleteRepair(button.dataset.delete);
      } else if (button.dataset.edit) {
        editingId = button.dataset.edit;
        render();
        document.querySelector(".panel")?.scrollIntoView({ behavior: "smooth" });
      } else if (button.id === "cancel-edit") {
        editingId = null;
        render();
      } else if (button.dataset.noticeClose !== undefined) {
        notice = null;
        render();
      }
    });

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches("[data-status]")) {
        const result = updateRepair(target.dataset.status, { status: target.value });
        persist();
        render();
        if (result === "withdrew") {
          flash("状态已更新，该事项已自动从待审核批次撤回（历史保留）。", "warn");
        }
      } else if (target.matches("[data-select]")) {
        if (target.checked) selectedIds.add(target.dataset.select);
        else selectedIds.delete(target.dataset.select);
        render();
      }
    });

    root.addEventListener("input", (event) => {
      if (event.target.matches("[data-payout]")) {
        payoutDrafts[event.target.dataset.payout] = event.target.value;
      }
    });
  }

  function submitBatch() {
    const result = evaluateSubmission(state.claims, state.repairs, [...selectedIds]);
    if (!result.ok) {
      // 整批拒绝：不创建批次，原批次保持不动
      flash(result.reason, "error");
      return;
    }
    const batch = createClaimBatch(result);
    state.claims.push(batch);
    selectedIds.clear();
    persist();
    render();
    flash(`批次 #${batch.id.slice(0, 8)} 已提交，进入待审核，所选 ${batch.items.length} 项已锁定。`, "success");
  }

  function reviewBatch(batchId, action, payout) {
    const result = reviewClaimBatch(state.claims, batchId, action, payout);
    if (result.error) {
      flash(result.error, "error");
      return;
    }
    state.claims = result.claims;
    const approved = result.code === "APPROVED";
    const overLimit = result.code === "PAYOUT_EXCEEDS";
    delete payoutDrafts[batchId];
    persist();
    render();
    if (approved) {
      flash(`批次已审核通过，登记赔付额 ¥${result.payout}。`, "success");
    } else if (overLimit) {
      flash(`赔付额高于在批费用，整批拒绝，事项已释放。`, "error");
    } else {
      flash("批次已驳回，事项已释放。", "warn");
    }
  }

  function deleteRepair(id) {
    if (isRepairLocked(state.claims, id)) {
      flash("该事项正在待审核理赔批次中，不能删除。", "error");
      return;
    }
    state.repairs = state.repairs.filter((repair) => repair.id !== id);
    selectedIds.delete(id);
    if (editingId === id) editingId = null;
    persist();
    render();
    flash("维修事项已删除。", "success");
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  }

  render();
  bindEvents();
}
