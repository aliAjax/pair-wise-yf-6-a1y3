// 页面交互：渲染与事件委托。理赔判定见 claims.js，状态变更一律走 store.js。

import {
  batchStatusLabels,
  eligibilityReason,
  findOpenBatch,
  itemStatusLabels,
  reasonLabels
} from "./claims.js";
import { createStore, priorities, statuses } from "./store.js";

export function mountApp(app) {
  const store = createStore();
  const ui = {
    notice: null,
    editingId: null,
    selected: new Set()
  };

  function notify(type, text) {
    ui.notice = { type, text };
    render();
  }

  function render() {
    const stats = store.getStats();
    const editing = ui.editingId ? store.getRepair(ui.editingId) : null;

    app.innerHTML = `
      <main class="shell">
        ${renderHeader(stats)}
        ${ui.notice ? `<div class="notice ${ui.notice.type}">${escapeHtml(ui.notice.text)}</div>` : ""}
        <section class="layout">
          <aside class="panel">
            <h2>${editing ? "编辑维修事项" : "新增维修事项"}</h2>
            ${renderForm(editing)}
          </aside>
          <section class="main-col">
            ${renderClaimPanel()}
            <div class="toolbar">
              ${Object.entries(statuses)
                .map(
                  ([value, label]) =>
                    `<button type="button" class="seg ${store.state.filter === value ? "active" : ""}" data-action="filter" data-value="${value}">${label}</button>`
                )
                .join("")}
            </div>
            <div class="repairs">
              ${filteredRepairs().length ? filteredRepairs().map(renderRepair).join("") : `<div class="empty">当前状态下没有维修事项</div>`}
            </div>
          </section>
        </section>
        ${renderBatchSection()}
      </main>
    `;
  }

  function renderHeader(stats) {
    return `
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维护台</p>
          <h1>家庭维修事项</h1>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成</span><strong>${stats.unfinishedCount}</strong></div>
          <div class="stat"><span>处理中</span><strong>${stats.doingCount}</strong></div>
          <div class="stat"><span>预计费用</span><strong>¥${stats.unfinishedCost}</strong></div>
          <div class="stat"><span>待审理赔批次</span><strong>${stats.pendingBatchCount}</strong></div>
          <div class="stat"><span>锁定事项</span><strong>${stats.lockedCount}</strong></div>
          <div class="stat"><span>累计赔付</span><strong>¥${stats.payoutTotal}</strong></div>
        </section>
      </header>
    `;
  }

  function renderForm(editing) {
    const data = editing || {
      location: "",
      title: "",
      priority: "medium",
      cost: 0,
      status: "todo",
      photo: "",
      note: ""
    };
    return `
      <form class="form" id="repair-form" data-editing="${editing ? editing.id : ""}">
        <label>位置<input name="location" required placeholder="例如卫生间" value="${escapeHtml(data.location)}"></label>
        <label>问题描述<textarea name="title" required placeholder="例如门锁松动">${escapeHtml(data.title)}</textarea></label>
        <label>优先级<select name="priority">${renderPriorityOptions(data.priority)}</select></label>
        <label>预计费用<input name="cost" type="number" min="0" step="1" value="${Number(data.cost || 0)}"></label>
        <label>处理状态<select name="status">${renderStatusOptions(data.status)}</select></label>
        <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址" value="${escapeHtml(data.photo)}"></label>
        <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项">${escapeHtml(data.note || "")}</textarea></label>
        ${editing ? `<p class="hint">该事项在待审核批次中时，改动费用、照片或状态会自动撤回该事项，批次历史保留。</p>` : `<p class="hint">新登记的事项按已投保处理；旧数据中的事项按未投保处理。</p>`}
        <div class="form-actions">
          <button class="primary" type="submit">${editing ? "保存修改" : "保存事项"}</button>
          ${editing ? `<button class="ghost" type="button" data-action="cancel-edit">取消编辑</button>` : ""}
        </div>
      </form>
    `;
  }

  function renderClaimPanel() {
    const rows = claimCandidates();
    const selectableIds = rows.filter((row) => row.selectable).map((row) => row.repair.id);
    for (const id of [...ui.selected]) {
      if (!selectableIds.includes(id)) ui.selected.delete(id);
    }
    const checkedCount = [...ui.selected].length;

    return `
      <section class="panel claim-panel">
        <div class="claim-head">
          <h2>保险理赔批次</h2>
          <span class="hint">入批条件：已投保 · 已完成 · 费用大于零 · 有照片链接</span>
        </div>
        <form id="claim-form">
          <ul class="claim-list">
            ${rows.map(renderClaimRow).join("")}
          </ul>
          <div class="form-actions">
            <button class="primary" type="submit" ${checkedCount ? "" : "disabled"}>提交理赔批次（已选 ${checkedCount} 项）</button>
          </div>
        </form>
      </section>
    `;
  }

  function claimCandidates() {
    const rows = store.state.repairs.map((repair) => {
      const openBatch = findOpenBatch(repair.id, store.batches);
      const reason = eligibilityReason(repair);
      let selectable = false;
      let note = "";

      if (openBatch) {
        note = `审核中（批次 ${openBatch.code}），已锁定`;
      } else if (repair.paidClaimId) {
        note = reasonLabels.paid;
      } else if (reason) {
        note = reasonLabels[reason];
      } else {
        selectable = true;
        note = "可入批";
      }
      return { repair, openBatch, reason, selectable, note };
    });

    return rows.sort((a, b) => Number(b.selectable) - Number(a.selectable));
  }

  function renderClaimRow({ repair, selectable, note }) {
    const checked = ui.selected.has(repair.id);
    return `
      <li class="claim-row ${selectable ? "selectable" : "blocked"}">
        <label>
          <input type="checkbox" name="claim-item" value="${repair.id}" ${checked ? "checked" : ""} ${selectable ? "" : "disabled"}>
          <span class="claim-name">${escapeHtml(repair.location)} · ${escapeHtml(repair.title)}</span>
        </label>
        <span class="chip">¥${Number(repair.cost || 0)}</span>
        <span class="claim-note">${escapeHtml(note)}</span>
      </li>
    `;
  }

  function renderBatchSection() {
    const batches = store.batches;
    return `
      <section class="batches-wrap">
        <h2 class="section-title">理赔批次（本地存档）</h2>
        ${batches.length ? `<div class="batches">${batches.map(renderBatch).join("")}</div>` : `<div class="empty">还没有理赔批次</div>`}
      </section>
    `;
  }

  function renderBatch(batch) {
    const lockedItems = batch.items.filter((item) => item.status === "locked");
    const costTotal = batch.items.reduce((sum, item) => sum + Number(item.cost || 0), 0);

    return `
      <article class="batch ${batch.status}">
        <div class="batch-head">
          <div>
            <h3>${escapeHtml(batch.code)}</h3>
            <span class="hint">提交于 ${formatDate(batch.createdAt)}</span>
          </div>
          <span class="batch-status ${batch.status}">${batchStatusLabels[batch.status]}</span>
        </div>
        ${batch.rejectReason ? `<p class="reject-reason">拒绝原因：${escapeHtml(batch.rejectReason)}</p>` : ""}
        <div class="batch-meta">
          <span class="chip">事项 ${batch.items.length} 项</span>
          <span class="chip">入批费用合计 ¥${costTotal}</span>
          ${batch.status === "approved" ? `<span class="chip payout">实赔 ¥${batch.payoutTotal}</span>` : ""}
          ${batch.decidedAt ? `<span class="chip">结案于 ${formatDate(batch.decidedAt)}</span>` : ""}
        </div>

        <form data-review="${batch.id}">
          <ul class="batch-items">
            ${batch.items.map((item) => renderBatchItem(batch, item)).join("")}
          </ul>
          ${batch.status === "pending" ? `
            <div class="form-actions">
              <button class="primary" type="submit" data-action="approve" ${lockedItems.length ? "" : "disabled"}>审核通过并登记赔付</button>
              <button class="danger" type="submit" data-action="reject" ${lockedItems.length ? "" : "disabled"}>驳回并释放事项</button>
            </div>` : ""}
        </form>

        <details class="history">
          <summary>批次与事项历史（${batch.events.length} 条）</summary>
          ${renderItemHistories(batch)}
          <ol class="timeline">
            ${batch.events.map((event) => `<li><time>${formatDate(event.at)}</time><span>${escapeHtml(event.text)}</span></li>`).join("")}
          </ol>
        </details>
      </article>
    `;
  }

  function renderBatchItem(batch, item) {
    const locked = batch.status === "pending" && item.status === "locked";
    return `
      <li class="batch-item">
        <div class="batch-item-main">
          <span class="claim-name">${escapeHtml(item.location)} · ${escapeHtml(item.title)}</span>
          <span class="chip">费用 ¥${item.cost}</span>
          <span class="item-status ${item.status}">${itemStatusLabels[item.status]}</span>
          ${item.status === "approved" ? `<span class="chip payout">赔付 ¥${item.payout}</span>` : ""}
        </div>
        ${locked ? `
          <label class="payout-input">赔付额
            <input type="number" name="payout-${item.repairId}" min="0" step="1" value="${item.cost}">
          </label>
          <span class="hint">赔付额高于费用（¥${item.cost}）将整批拒绝</span>` : ""}
        ${item.photo ? `<a class="photo-link" href="${escapeHtml(item.photo)}" target="_blank" rel="noreferrer">查看入批照片</a>` : ""}
      </li>
    `;
  }

  function renderItemHistories(batch) {
    const withEvents = batch.items.filter((item) => item.events.length);
    if (!withEvents.length) return "";
    return `
      <div class="item-histories">
        ${withEvents
          .map(
            (item) => `
          <details>
            <summary>${escapeHtml(item.location)} · ${escapeHtml(item.title)}</summary>
            <ol class="timeline">
              ${item.events
                .map((event) => `<li><time>${formatDate(event.at)}</time><span>${escapeHtml(event.text)}</span></li>`)
                .join("")}
            </ol>
          </details>`
          )
          .join("")}
      </div>
    `;
  }

  function renderRepair(repair) {
    const locked = Boolean(findOpenBatch(repair.id, store.batches));
    return `
      <article class="repair ${locked ? "locked" : ""}">
        <div class="photo">${repair.photo ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">` : "未添加照片"}</div>
        <div class="content">
          <div class="row">
            <h3>${escapeHtml(repair.location)}</h3>
            <span class="priority ${repair.priority}">${priorities[repair.priority]}</span>
            <span class="status ${repair.status}">${statuses[repair.status]}</span>
            <span class="tag ${repair.insured ? "insured" : "uninsured"}">${repair.insured ? "已投保" : "未投保·旧事项"}</span>
            ${repair.paidClaimId ? `<span class="tag paid">已赔付 ¥${Number(repair.claimPayout || 0)}</span>` : ""}
            ${locked ? `<span class="tag locked-tag">理赔审核中·已锁定</span>` : ""}
          </div>
          <p>${escapeHtml(repair.title)}</p>
          <div class="row">
            <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
            <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
          </div>
          ${locked ? `<p class="hint">待审核期间事项锁定；改动费用、照片或状态会自动撤回该事项并保留历史。</p>` : ""}
          <div class="actions">
            <select data-action="status" data-id="${repair.id}" ${locked ? "disabled" : ""}>${renderStatusOptions(repair.status)}</select>
            <button class="ghost" type="button" data-action="edit" data-id="${repair.id}">编辑</button>
            <button class="ghost danger-text" type="button" data-action="delete" data-id="${repair.id}" ${locked ? "disabled" : ""}>删除</button>
          </div>
        </div>
      </article>
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

  function filteredRepairs() {
    if (store.state.filter === "all") return store.state.repairs;
    return store.state.repairs.filter((repair) => repair.status === store.state.filter);
  }

  // ---- 事件：统一委托，重渲染后无需重新绑定 ----
  app.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "filter") {
      store.setFilter(target.dataset.value);
      render();
    } else if (action === "edit") {
      ui.editingId = target.dataset.id;
      ui.notice = null;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (action === "cancel-edit") {
      ui.editingId = null;
      render();
    } else if (action === "delete") {
      const result = store.deleteRepair(target.dataset.id);
      notify(result.ok ? "ok" : "error", result.ok ? "事项已删除，列表与存档已同步" : result.message);
    }
  });

  app.addEventListener("change", (event) => {
    const target = event.target;

    if (target.matches('[data-action="status"]')) {
      const result = store.setStatus(target.dataset.id, target.value);
      notify(result.withdrawn ? "warn" : "ok", result.withdrawn || "状态已更新，费用统计与存档已同步");
      return;
    }

    if (target.matches('input[name="claim-item"]')) {
      if (target.checked) ui.selected.add(target.value);
      else ui.selected.delete(target.value);
      render();
    }
  });

  app.addEventListener("submit", (event) => {
    const form = event.target;

    if (form.id === "repair-form") {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const editingId = form.dataset.editing;
      const result = editingId
        ? store.updateRepair(editingId, data)
        : (store.addRepair(data), { ok: true });
      ui.editingId = null;
      notify(result.withdrawn ? "warn" : "ok", result.withdrawn || (editingId ? "事项修改已保存，列表与存档已同步" : "事项已保存"));
      return;
    }

    if (form.id === "claim-form") {
      event.preventDefault();
      const ids = [...form.querySelectorAll('input[name="claim-item"]:checked')].map((input) => input.value);
      const result = store.submitClaim(ids);
      if (result.ok) {
        ui.selected.clear();
        notify("ok", result.message);
      } else {
        notify("error", result.message);
      }
      return;
    }

    const reviewBatchId = form.dataset.review;
    if (reviewBatchId) {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form, event.submitter));
      const action = event.submitter?.dataset.action;
      const payouts = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("payout-")) payouts[key.slice(7)] = value;
      }
      const result = store.reviewClaim(reviewBatchId, action, payouts);
      if (!result.ok) {
        notify("error", result.message);
      } else {
        notify(result.action === "approved" ? "ok" : "warn", result.message);
      }
    }
  });

  render();
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]
  );
}
