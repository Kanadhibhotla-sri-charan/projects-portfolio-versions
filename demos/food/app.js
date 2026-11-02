"use strict";

let currentDate = null;
let parsedItems = [];
let itemSeq = 0;
let selectedMeal = null;
let selectedGoal = "";
let recommendMeal = null; // which meal a "Log This"/"Log Combination" click logs into
let lastRecommendResponse = null; // the last /api/recommend response, so Log buttons reuse its data — never retyped
let lastInterpretRequest = null; // { text, meal, date } — used by "Try again"

// Quick Entry state (qeSelectedQty/qeSelectedScale/qeSuggestionIndex/
// qeListToken are declared with the rest of the Quick Entry code below)
let qeIdSeq = 0; // suggestion chip id -> food object, avoids embedding JSON in data-* attrs

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, { method = "GET", body } = {}) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
  }
  return data;
}

function fmt0(n) {
  return Number.isFinite(n) ? n.toFixed(0) : "–";
}

// ---------- Tabs ----------

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    const active = b === btn;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const tab = btn.dataset.tab;
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  if (tab === "today") loadToday();
  if (tab === "catalogue" && !catalogueLoadedOnce) loadCatalogue();
  if (tab === "recommend" && !availableNowLoadedOnce) loadAvailableNow();
  if (tab === "plans" && !plansLoadedOnce) loadPlans();
});

document.getElementById("date-input").addEventListener("change", (e) => {
  currentDate = e.target.value;
  loadToday();
});

// ---------- Chip groups (single-select) ----------

function wireChipGroup(containerId, dataKey, onSelect) {
  const container = document.getElementById(containerId);
  container.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    container.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    onSelect(chip.dataset[dataKey]);
  });
}

wireChipGroup("meal-chips", "meal", (meal) => { selectedMeal = meal; });
wireChipGroup("goal-chips", "goal", (goal) => { selectedGoal = goal; });
wireChipGroup("recommend-meal-chips", "meal", (meal) => { recommendMeal = meal; });

// ---------- Today ----------

async function loadToday() {
  const content = document.getElementById("today-content");
  content.innerHTML = '<div class="loading-line"><span class="spinner" aria-hidden="true"></span> Loading today…</div>';
  try {
    const state = await api(`/api/today?date=${encodeURIComponent(currentDate)}`);
    renderToday(state);
    renderMealTimeline(state.meals || []);
  } catch (err) {
    content.innerHTML = `<div class="card"><p class="error">${escapeHtml(err.message)}</p></div>`;
  }
  loadPlanStatus();
  loadFoodEntries();
}

// ---------- Logged food entries (delete) ----------

async function loadFoodEntries() {
  const el = document.getElementById("food-entries-content");
  try {
    const data = await api(`/api/food/entries?date=${encodeURIComponent(currentDate)}`);
    renderFoodEntries(data.entries || []);
  } catch (err) {
    el.innerHTML = "";
  }
}

// "Weighed: 60g (...)" comments come from Weighing Scale Entry rows.
function weighedGramsLabel(comment) {
  const m = /^Weighed: ([\d.]+)g/.exec(comment || "");
  return m ? ` · ${escapeHtml(m[1])}g` : "";
}

function entryMacroLine(e) {
  if (!e.resolved) return "not counted yet";
  const parts = [`${fmt0(e.kcal)} kcal`, `${fmt0(e.protein)}g protein`];
  if (Number.isFinite(e.carbs)) parts.push(`${fmt0(e.carbs)}g carbs`);
  if (Number.isFinite(e.fiber)) parts.push(`${fmt1(e.fiber)}g fiber`);
  return "~" + parts.join(" · ");
}

function renderFoodEntries(entries) {
  const el = document.getElementById("food-entries-content");
  if (!entries.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="section-title">Logged items</div>
    <div class="card food-entry-list">
      ${entries.map((e) => `
        <div class="food-entry-row">
          <div class="food-entry-main">
            <span class="food-entry-name">${MEAL_EMOJI[e.meal] || "🍽️"} ${escapeHtml(e.dish || "")}${weighedGramsLabel(e.comment)}</span>
            <span class="food-entry-macro">${escapeHtml(MEAL_LABELS[e.meal] || e.meal || "")} · ${entryMacroLine(e)}</span>
          </div>
          ${e.deletable ? `<button type="button" class="link food-entry-delete" data-entry-id="${escapeHtml(e.entry_id)}">Delete</button>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  document.querySelectorAll(".food-entry-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entryId = btn.dataset.entryId;
      if (!entryId || !confirm("Delete this food entry?")) return;
      btn.disabled = true;
      btn.textContent = "Deleting…";
      try {
        await api("/api/food/delete", { method: "POST", body: { date: currentDate, entry_id: entryId } });
        loadToday();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = "Delete";
      }
    });
  });
}

// ---- Today dashboard ----
// Rings (outer→inner): calories vs today's target, protein vs the bottom
// of its range, fiber vs a general ~30g/day guideline (GOALS.md has no
// fiber target). Carbs and fat are tracked and shown smaller below.

const FIBER_GUIDE_G = 30;

function fmt1(n) {
  return Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : "–";
}

function fmtThousands(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-IN") : "–";
}

function ringsSvg(rings) {
  // rings: [{ cls, fraction }] from outermost to innermost
  const size = 148;
  const stroke = 13;
  const gap = 4;
  const circles = rings.map((r, i) => {
    const radius = size / 2 - stroke / 2 - i * (stroke + gap);
    const circ = 2 * Math.PI * radius;
    const frac = Math.max(0, Math.min(1, r.fraction || 0));
    return `
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}"></circle>
      <circle class="ring-value ${r.cls}" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-target-offset="${circ * (1 - frac)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
  }).join("");
  return `
    <svg class="rings" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(rings.map((r) => r.label).join(", "))}">
      <defs>
        <linearGradient id="kcalGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--kcal)"></stop>
          <stop offset="100%" stop-color="var(--kcal-2)"></stop>
        </linearGradient>
      </defs>
      ${circles}
    </svg>`;
}

// kind: "floor"  — only the minimum matters, more is fine (protein)
//       "guide"  — a general reference line, no target (fiber)
//       "ceiling" — a guide range where going over the top is the problem (fat)
function statBarHtml({ nutrient, icon, label, value, min, max, unit, kind }) {
  const scaleMax = Math.max(max * 1.2, value * 1.05, 1);
  const pct = (v) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
  let foot;
  if (kind === "ceiling") {
    foot = value > max
      ? `<span class="bad">${fmt0(value - max)}${unit} over the limit</span>`
      : `<span class="good">${fmt0(max - value)}${unit} below the limit</span>`;
  } else if (value < min) {
    foot = `<span>${fmt0(min - value)}${unit} to go</span>`;
  } else {
    foot = `<span class="good">${kind === "guide" ? "guide reached ✓" : "target reached ✓"}</span>`;
  }
  const targetText = kind === "guide"
    ? `guide ~${fmt0(min)}${unit}/day`
    : kind === "ceiling"
    ? `guide ${fmt0(min)}–${fmt0(max)}${unit}`
    : `target ${fmt0(min)}${unit}+`;
  const showZone = kind === "ceiling";
  return `
    <div class="stat-card nutrient-${nutrient}${kind === "ceiling" && value > max ? " over-limit" : ""}">
      <div class="stat-head">
        <span class="stat-label"><span class="stat-icon" aria-hidden="true">${icon}</span>${escapeHtml(label)}</span>
        <span class="stat-value">${unit === "g" && value < 20 ? fmt1(value) : fmt0(value)}<small>${escapeHtml(unit)}</small></span>
      </div>
      <div class="range-track" role="img" aria-label="${escapeHtml(label)}: ${fmt0(value)}${unit}, ${escapeHtml(targetText)}">
        ${showZone ? `<div class="range-zone" style="left:${pct(min)}%; width:${Math.max(0, pct(max) - pct(min))}%"></div>` : ""}
        <div class="range-fill" data-width="${pct(value)}%"></div>
        <div class="range-tick" style="left:${pct(min)}%"></div>
        ${showZone ? `<div class="range-tick" style="left:${pct(max)}%"></div>` : ""}
      </div>
      <div class="stat-foot"><span>${escapeHtml(targetText)}</span>${foot}</div>
    </div>`;
}

// Fat guide: 20–35% of today's calorie target, at 9 kcal per gram.
function fatGuide(targetKcal) {
  return { min: (targetKcal * 0.20) / 9, max: (targetKcal * 0.35) / 9 };
}

function calorieSplitHtml(c) {
  // Share of calories from each macro at 4 kcal/g protein and carbs,
  // 9 kcal/g fat — the standard energy values food labels use.
  const p = (c.protein_g || 0) * 4;
  const cb = (c.carbs_g || 0) * 4;
  const f = (c.fat_g || 0) * 9;
  const total = p + cb + f;
  const share = (v) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const unknown = c.carbs_has_unknowns || c.fat_has_unknowns;
  return `
    <div class="card split-card">
      <div class="split-row">
        <span class="macro-pill nutrient-carbs"><span class="dot carbs"></span>Carbs <strong>${fmt0(c.carbs_g)}g</strong></span>
      </div>
      <div class="split-bar" role="img" aria-label="Calories from protein ${share(p)}%, carbs ${share(cb)}%, fat ${share(f)}%">
        <span class="seg-protein" data-width="${share(p)}%"></span>
        <span class="seg-carbs" data-width="${share(cb)}%"></span>
        <span class="seg-fat" data-width="${share(f)}%"></span>
      </div>
      <div class="split-caption">
        <span>Where calories come from:</span>
        <span><span class="dot protein"></span>protein ${share(p)}%</span>
        <span><span class="dot carbs"></span>carbs ${share(cb)}%</span>
        <span><span class="dot fat"></span>fat ${share(f)}%</span>
      </div>
      ${unknown ? `<p class="note" style="font-size:0.76rem">Some items have no carbs/fat figure yet (e.g. logged before carbs were tracked), so these are a little low.</p>` : ""}
    </div>`;
}

function activityEmoji(state) {
  const t = state.day_type;
  if (t === "both") return "🏋️🏸";
  if (t === "gym") return "🏋️";
  if (t === "badminton") return "🏸";
  return "🛋️";
}

function animateDashboard(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll(".ring-value").forEach((c) => c.setAttribute("stroke-dashoffset", c.dataset.targetOffset));
    root.querySelectorAll("[data-width]").forEach((el) => { el.style.width = el.dataset.width; });
  }));
  const num = root.querySelector(".big-num-value");
  if (!num) return;
  const to = Number(num.dataset.value) || 0;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || to <= 0) {
    num.textContent = fmtThousands(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    num.textContent = fmtThousands(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderToday(state) {
  const content = document.getElementById("today-content");
  const c = state.consumed;
  const target = state.target.kcal_max;
  const left = target - c.kcal;
  const activityLabel = state.target.activity_label || state.day_type;
  const trendAdj = state.target.trend_adjustment_kcal || 0;
  const trendText = trendAdj
    ? ` Trend adjustment ${trendAdj > 0 ? "+" : ""}${fmt0(trendAdj)}kcal${state.target.trend_reason ? ` — ${state.target.trend_reason}` : ""}.`
    : "";

  let html = `
    <div class="hero-card">
      <div class="hero-top">
        <span class="activity-chip">${activityEmoji(state)} ${escapeHtml(activityLabel)}</span>
        <span class="confidence-chip">${escapeHtml(state.confidence)} confidence</span>
      </div>
      <div class="hero-body">
        ${ringsSvg([
          { cls: "ring-kcal", fraction: target > 0 ? c.kcal / target : 0, label: `Calories ${fmt0(c.kcal)} of ${fmt0(target)}` },
          { cls: "ring-protein", fraction: state.target.protein_min_g > 0 ? c.protein_g / state.target.protein_min_g : 0, label: `Protein ${fmt0(c.protein_g)}g of ${fmt0(state.target.protein_min_g)}g` },
          { cls: "ring-fiber", fraction: c.fiber_g / FIBER_GUIDE_G, label: `Fiber ${fmt0(c.fiber_g)}g of ~${FIBER_GUIDE_G}g` },
        ])}
        <div class="hero-numbers">
          <div class="big-num"><span class="big-num-value" data-value="${c.kcal}">0</span><small>kcal</small></div>
          <div class="big-sub">of <strong>${fmtThousands(target)}</strong> kcal target</div>
          <span class="big-left${left < 0 ? " over" : ""}">${left >= 0 ? `${fmtThousands(left)} left` : `${fmtThousands(-left)} over`}</span>
        </div>
      </div>
      <div class="ring-legend">
        <span><span class="dot kcal"></span>Calories</span>
        <span><span class="dot protein"></span>Protein ${fmt0(c.protein_g)}/${fmt0(state.target.protein_min_g)}g</span>
        <span><span class="dot fiber"></span>Fiber ${fmt1(c.fiber_g)}/${FIBER_GUIDE_G}g</span>
      </div>
      <div class="hero-foot">The target is a planning estimate, not a measurement of calories burned.${escapeHtml(trendText)}</div>
    </div>
    <div class="nutrient-grid">
      ${statBarHtml({ nutrient: "protein", icon: "💪", label: "Protein", value: c.protein_g, min: state.target.protein_min_g, max: state.target.protein_max_g, unit: "g", kind: "floor" })}
      ${statBarHtml({ nutrient: "fiber", icon: "🌿", label: "Fiber", value: c.fiber_g, min: FIBER_GUIDE_G, max: FIBER_GUIDE_G, unit: "g", kind: "guide" })}
      ${statBarHtml({ nutrient: "fat", icon: "🧈", label: "Fat", value: c.fat_g, ...fatGuide(target), unit: "g", kind: "ceiling" })}
    </div>
    <div style="height:12px"></div>
    ${calorieSplitHtml(c)}
    ${state.guidance ? `<div class="card guidance-card"><span class="guidance-icon" aria-hidden="true">💬</span><p>${escapeHtml(state.guidance)}</p></div>` : ""}
  `;
  if (state.unresolved_entries && state.unresolved_entries.length) {
    html += `<div class="card">
      <div class="item-head"><span class="name"><span class="item-icon" aria-hidden="true">⚠️</span> Not counted yet</span></div>
      ${state.unresolved_entries.map((u) => `<div class="item-reason">${escapeHtml(MEAL_LABELS[u.meal] || u.meal)}: ${escapeHtml(u.dish)} — ${escapeHtml(u.reason)}</div>`).join("")}
    </div>`;
  }
  if (state.provisional_entries && state.provisional_entries.length) {
    html += `<div class="card">
      <div class="item-head"><span class="name"><span class="item-icon" aria-hidden="true">✨</span> Provisional (AI-estimated)</span></div>
      ${state.provisional_entries.map((p) => `<div class="item-reason">${escapeHtml(MEAL_LABELS[p.meal] || p.meal)}: ${escapeHtml(p.dish)} — ~${p.kcal}kcal / ~${p.protein}g</div>`).join("")}
    </div>`;
  }
  content.innerHTML = html;
  animateDashboard(content);
}

const MEAL_LABELS = { pw: "Pre-workout", bf: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };
const MEAL_EMOJI = { pw: "🏃", bf: "🌅", lunch: "🍛", snack: "🍌", dinner: "🌙" };

function renderMealTimeline(meals) {
  const el = document.getElementById("meal-timeline-content");
  const visible = meals.filter((m) => m.meal !== "pw" || m.logged);
  if (!visible.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="section-title">Meals</div>
    <div class="meal-timeline">
      ${visible.map((m) => `
        <div class="meal-card ${m.logged ? "logged" : ""}">
          <span class="meal-emoji" aria-hidden="true">${MEAL_EMOJI[m.meal] || "🍽️"}</span>
          <div class="meal-main">
            <span class="meal-name">${escapeHtml(m.label || MEAL_LABELS[m.meal] || m.meal)}</span>
            ${m.logged
              ? `<span class="meal-macro">
                  <span><span class="dot protein"></span>${fmt0(m.protein)}g P</span>
                  <span><span class="dot carbs"></span>${fmt0(m.carbs)}g C</span>
                  <span><span class="dot fat"></span>${fmt0(m.fat)}g F</span>
                  <span><span class="dot fiber"></span>${fmt1(m.fiber)}g fiber</span>
                </span>${m.has_provisional ? `<span class="meal-status">some AI-estimated</span>` : ""}`
              : `<span class="meal-status">Not logged yet</span>`}
          </div>
          ${m.logged
            ? `<span class="meal-kcal">${fmt0(m.kcal)}<small>kcal</small></span>`
            : `<button type="button" class="meal-add-btn" data-add-meal="${escapeHtml(m.meal)}">+ Add</button>`}
        </div>
      `).join("")}
    </div>
  `;
  el.querySelectorAll(".meal-add-btn").forEach((btn) => btn.addEventListener("click", () => openAddFoodFor(btn.dataset.addMeal)));
}

// Jumps to Add Food with that meal already picked.
function openAddFoodFor(meal) {
  document.querySelector('.tab-btn[data-tab="add-food"]').click();
  const chip = document.querySelector(`#meal-chips .chip[data-meal="${meal}"]`);
  if (chip) chip.click();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadPlanStatus() {
  const el = document.getElementById("plan-status-content");
  try {
    const status = await api(`/api/plan/status?date=${encodeURIComponent(currentDate)}`);
    if (!status.plan_id) {
      el.innerHTML = "";
      return;
    }
    const categoryLabel = { on_track: "On track", minor_deviation: "Minor deviation", needs_repair: "Needs a small adjustment" }[status.category] || status.category;
    el.innerHTML = `
      <div class="section-title">Plan</div>
      <div class="card">
        <div class="item-head"><span class="name">${escapeHtml(status.plan_name)}</span><span class="badge high">${escapeHtml(categoryLabel)}</span></div>
        <p class="note">${escapeHtml(status.note || "")}</p>
      </div>
    `;
  } catch (err) {
    el.innerHTML = "";
  }
}

// ---------- Add Food ----------

document.getElementById("interpret-btn").addEventListener("click", () => runInterpret());

async function runInterpret() {
  const text = document.getElementById("food-text").value.trim();
  const errEl = document.getElementById("interpret-error");
  errEl.textContent = "";
  if (!text) {
    errEl.textContent = "Tell me what you ate first.";
    return;
  }
  if (!selectedMeal) {
    errEl.textContent = "Pick a meal.";
    return;
  }
  const loading = document.getElementById("interpret-loading");
  const loadingText = document.getElementById("interpret-loading-text");
  const btn = document.getElementById("interpret-btn");
  loading.style.display = "flex";
  loadingText.textContent = "Understanding your meal…";
  btn.disabled = true;
  lastInterpretRequest = { text, meal: selectedMeal, date: currentDate };
  try {
    const result = await api("/api/food/interpret", { method: "POST", body: lastInterpretRequest });
    if (result.items.some((it) => it.resolution === "ai_provisional" || it.resolution === "ai_error")) {
      loadingText.textContent = "Checking the items that need an estimate…";
    }
    parsedItems = result.items.map((it) => ({ ...it, id: ++itemSeq, meal: selectedMeal }));
    renderParsedItems();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    loading.style.display = "none";
    btn.disabled = false;
  }
}

function badgeHtml(item) {
  if (item.source === "weighed") {
    return item.library_source === "estimate"
      ? '<span class="badge provisional">Estimate · per 100g</span>'
      : '<span class="badge high">Food table · per 100g</span>';
  }
  if (item.resolution === "engine_resolved") return '<span class="badge high">Database</span>';
  if (item.resolution === "ai_provisional") return '<span class="badge provisional">AI · provisional</span>';
  return "";
}

function itemIcon(item) {
  if (item.resolution === "engine_resolved") return "✓";
  if (item.resolution === "ai_provisional") return "✺";
  if (item.resolution === "ai_error") return "⟳";
  return "?";
}

function interpretationHtml(interp) {
  const hasTotal = interp.total_quantity != null || interp.total_unit;
  const totalLine = hasTotal
    ? `${interp.total_quantity != null ? interp.total_quantity : ""}${interp.total_unit ? ` ${escapeHtml(interp.total_unit)}` : ""} total`.trim()
    : "";
  const components = interp.components || [];
  if (!totalLine && !components.length) return "";
  const listHtml = components.length
    ? `<ul class="ai-interpretation-list">${components.map((c) => {
        const qty = c.quantity != null ? `${c.quantity}${c.unit ? ` ${escapeHtml(c.unit)}` : ""} ` : "";
        return `<li>${qty}${escapeHtml(c.name)}</li>`;
      }).join("")}</ul>`
    : "";
  return `
    <div class="ai-interpretation">
      <div class="ai-interpretation-label">AI interpretation</div>
      ${totalLine ? `<div>${escapeHtml(totalLine)}</div>` : ""}
      ${listHtml}
    </div>
  `;
}

function itemCardHtml(item) {
  const resolved = item.resolution === "engine_resolved" || item.resolution === "ai_provisional";
  let body;

  if (resolved) {
    body = `
      <div class="provenance-row">${badgeHtml(item)}${item.practical_label ? `<span>Serving: ${escapeHtml(item.practical_label)}</span>` : ""}</div>
      <div class="item-fields">
        <div><label>Qty${item.unit ? ` (${escapeHtml(item.unit)})` : ""}</label>
          <input type="number" step="any" class="qty-input" data-id="${item.id}" value="${item.qty ?? ""}" ${item.source === "ai" || item.weighed_comment ? "disabled" : ""} aria-label="Quantity"></div>
        <div><label>kcal</label><input type="number" step="any" class="kcal-input" data-id="${item.id}" value="${item.kcal ?? ""}" aria-label="Calories"></div>
        <div><label>Protein (g)</label><input type="number" step="any" class="protein-input" data-id="${item.id}" value="${item.protein ?? ""}" aria-label="Protein grams"></div>
        <div><label>Carbs (g)</label><input type="number" step="any" class="carbs-input" data-id="${item.id}" value="${item.carbs ?? ""}" aria-label="Carbs grams"></div>
        <div><label>Fat (g)</label><input type="number" step="any" class="fat-input" data-id="${item.id}" value="${item.fat ?? ""}" aria-label="Fat grams"></div>
        <div><label>Fiber (g)</label><input type="number" step="any" class="fiber-input" data-id="${item.id}" value="${item.fiber ?? ""}" aria-label="Fiber grams"></div>
      </div>
      ${item.weighed_comment ? `<p class="item-reason">${escapeHtml(item.weighed_comment)}${item.source_detail ? ` Source: ${escapeHtml(item.source_detail)}.` : ""}</p>` : ""}
      ${item.resolution === "ai_provisional" && item.interpretation ? interpretationHtml(item.interpretation) : ""}
      ${item.resolution === "ai_provisional" ? `<p class="item-reason">AI estimate — provisional. A manual estimation run can reconcile this later.</p>` : ""}
    `;
  } else if (item.resolution === "needs_clarification" && item.clarification_options && item.clarification_options.length) {
    body = `
      <p class="item-reason">How much did you have?</p>
      <div class="option-row">
        ${item.clarification_options.map((o) => `<button type="button" class="chip clarify-btn" data-id="${item.id}" data-qty="${o.qty}">${escapeHtml(o.label)}</button>`).join("")}
      </div>
    `;
  } else if (item.resolution === "ai_error") {
    body = `
      <p class="item-reason">I couldn't estimate this item right now.</p>
      <div class="option-row">
        <button type="button" class="secondary retry-btn" data-id="${item.id}">Try again</button>
        <button type="button" class="secondary manual-btn" data-id="${item.id}">Enter manually</button>
        <button type="button" class="secondary qe-fix-btn" data-id="${item.id}">Fix with Quick Entry</button>
      </div>
    `;
  } else {
    body = `
      <p class="item-reason">I need a little more information about this one — enter it from the label, use Quick Entry, or remove it.</p>
      <div class="item-fields">
        <div><label>kcal</label><input type="number" step="any" class="kcal-input" data-id="${item.id}" value="" aria-label="Calories"></div>
        <div><label>Protein (g)</label><input type="number" step="any" class="protein-input" data-id="${item.id}" value="" aria-label="Protein grams"></div>
        <div><label>Carbs (g)</label><input type="number" step="any" class="carbs-input" data-id="${item.id}" value="" aria-label="Carbs grams"></div>
        <div><label>Fat (g)</label><input type="number" step="any" class="fat-input" data-id="${item.id}" value="" aria-label="Fat grams"></div>
        <div><label>Fiber (g)</label><input type="number" step="any" class="fiber-input" data-id="${item.id}" value="" aria-label="Fiber grams"></div>
      </div>
      <div class="option-row">
        <button type="button" class="secondary qe-fix-btn" data-id="${item.id}">Fix with Quick Entry</button>
      </div>
    `;
  }

  return `
    <div class="card item-card resolution-${item.resolution}" data-id="${item.id}">
      <div class="item-head">
        <span class="name"><span class="item-icon" aria-hidden="true">${itemIcon(item)}</span> ${escapeHtml(item.food_name || item.raw_text)}</span>
      </div>
      <div class="item-quote">"${escapeHtml(item.raw_text)}"</div>
      ${body}
      <div class="item-actions"><button type="button" class="link remove-btn" data-id="${item.id}">Remove</button></div>
    </div>
  `;
}

function updateConfirmSummary() {
  const count = parsedItems.length;
  const kcal = parsedItems.reduce((sum, i) => sum + (Number.isFinite(i.kcal) ? i.kcal : 0), 0);
  const protein = parsedItems.reduce((sum, i) => sum + (Number.isFinite(i.protein) ? i.protein : 0), 0);
  const fiber = parsedItems.reduce((sum, i) => sum + (Number.isFinite(i.fiber) ? i.fiber : 0), 0);
  document.getElementById("confirm-title").textContent = `${MEAL_EMOJI[selectedMeal] || "🍽️"} ${MEAL_LABELS[selectedMeal] || "Meal"} — ${count} item${count === 1 ? "" : "s"}`;
  document.getElementById("confirm-sub").textContent = `~${fmt0(kcal)}kcal · ~${fmt0(protein)}g protein · ~${fmt1(fiber)}g fiber`;
}

function renderParsedItems() {
  const container = document.getElementById("parsed-items");
  const logActions = document.getElementById("log-actions");
  if (!parsedItems.length) {
    container.innerHTML = "";
    logActions.style.display = "none";
    return;
  }
  container.innerHTML = parsedItems.map(itemCardHtml).join("");
  logActions.style.display = "block";
  document.getElementById("log-result").innerHTML = "";
  document.getElementById("log-error").textContent = "";
  updateConfirmSummary();
  wireItemCardEvents();
}

function wireItemCardEvents() {
  document.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      parsedItems = parsedItems.filter((i) => i.id !== id);
      renderParsedItems();
    });
  });

  document.querySelectorAll(".clarify-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.id);
      const qty = Number(btn.dataset.qty);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      try {
        const resolved = await api("/api/food/resolve-item", {
          method: "POST",
          body: { food_name: item.food_name, source: item.source, qty },
        });
        Object.assign(item, resolved, { resolution: "engine_resolved", confidence: "high", reason: "Quantity confirmed." });
        renderParsedItems();
      } catch (err) {
        document.getElementById("interpret-error").textContent = err.message;
      }
    });
  });

  document.querySelectorAll(".retry-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!lastInterpretRequest) return;
      const id = Number(btn.dataset.id);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      btn.textContent = "Trying again…";
      btn.disabled = true;
      try {
        const result = await api("/api/food/interpret", {
          method: "POST",
          body: { text: item.raw_text, meal: selectedMeal, date: currentDate },
        });
        const fresh = result.items[0];
        if (fresh) {
          Object.assign(item, fresh);
        }
        renderParsedItems();
      } catch (err) {
        document.getElementById("interpret-error").textContent = err.message;
        btn.textContent = "Try again";
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll(".manual-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      item.resolution = "needs_clarification";
      item.clarification_options = [];
      renderParsedItems();
    });
  });

  document.querySelectorAll(".qe-fix-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      parsedItems = parsedItems.filter((i) => i.id !== id);
      renderParsedItems();
      openQuickEntryFor(item.raw_text);
    });
  });

  document.querySelectorAll(".qty-input").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const id = Number(inp.dataset.id);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      const qty = Number(inp.value);
      if (!qty || qty <= 0) return;
      if (item.source === "dish" || item.source === "catalogue") {
        try {
          const resolved = await api("/api/food/resolve-item", {
            method: "POST",
            body: { food_name: item.food_name, source: item.source, qty },
          });
          Object.assign(item, resolved);
          renderParsedItems();
        } catch (err) {
          document.getElementById("interpret-error").textContent = err.message;
        }
      } else {
        item.qty = qty;
        updateConfirmSummary();
      }
    });
  });

  document.querySelectorAll(".kcal-input, .protein-input, .carbs-input, .fat-input, .fiber-input").forEach((inp) => {
    inp.addEventListener("input", () => {
      const id = Number(inp.dataset.id);
      const item = parsedItems.find((i) => i.id === id);
      if (!item) return;
      const val = inp.value === "" ? null : Number(inp.value);
      if (inp.classList.contains("kcal-input")) item.kcal = val;
      if (inp.classList.contains("protein-input")) item.protein = val;
      if (inp.classList.contains("carbs-input")) item.carbs = val;
      if (inp.classList.contains("fat-input")) item.fat = val;
      if (inp.classList.contains("fiber-input")) item.fiber = val;
      item.userEdited = true;
      updateConfirmSummary();
    });
  });
}

document.getElementById("log-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("log-error");
  const resultEl = document.getElementById("log-result");
  errEl.textContent = "";
  resultEl.innerHTML = "";
  if (!parsedItems.length) {
    errEl.textContent = "Nothing to log.";
    return;
  }
  const entries = [];
  for (const item of parsedItems) {
    const hasManualNumbers = Number.isFinite(item.kcal) && Number.isFinite(item.protein);
    const loggable = item.resolution === "engine_resolved" || item.resolution === "ai_provisional" || hasManualNumbers;
    if (!loggable) {
      errEl.textContent = `Still needs info: "${item.raw_text}" — pick a quantity, fill in kcal/protein, or remove it.`;
      return;
    }
    const useEngineLookup = item.source === "dish" && !item.userEdited;
    const baseComment = item.source === "ai"
        ? "AI-estimated, provisional — a manual estimation run can reconcile this later."
        : item.source === "catalogue"
        ? `Instant-food catalogue item${item.practical_label ? ` (${item.practical_label})` : ""}.`
        : !useEngineLookup && (item.resolution === "needs_clarification" || item.resolution === "ai_error" || item.resolution === "ai_unavailable")
        ? "Logged manually — not matched to a known dish."
        : "";
    const entry = {
      meal: item.meal,
      dish: item.food_name || item.raw_text,
      qty: useEngineLookup ? item.qty : 1,
      // A weighed item's grams live in its comment (jot.csv has no unit
      // column); its numbers are frozen as manual values below.
      comment: item.weighed_comment ? [item.weighed_comment, baseComment].filter(Boolean).join(" ") : baseComment,
    };
    if (!useEngineLookup) {
      entry.manual_kcal = item.kcal;
      entry.manual_protein = item.protein;
      entry.manual_fat = item.fat ?? "na";
      entry.manual_fiber = item.fiber ?? "na";
      entry.manual_carbs = item.carbs ?? "na";
    }
    if (item.interpretation) entry.interpretation = item.interpretation;
    entries.push(entry);
  }
  const logBtn = document.getElementById("log-btn");
  logBtn.disabled = true;
  try {
    const state = await api("/api/food/log", { method: "POST", body: { date: currentDate, entries } });
    resultEl.innerHTML = `
      <div class="card" style="border-color:var(--accent)">
        <div class="item-head"><span class="name">${escapeHtml(MEAL_LABELS[selectedMeal] || "Meal")} logged ✓</span></div>
        <p class="note">Today: ${fmt0(state.consumed.kcal)}kcal · ${fmt0(state.consumed.protein_g)}g protein · ${fmt1(state.consumed.fiber_g)}g fiber.\n${escapeHtml(state.guidance || "")}</p>
      </div>
    `;
    parsedItems = [];
    document.getElementById("food-text").value = "";
    document.querySelectorAll("#meal-chips .chip").forEach((c) => c.classList.remove("selected"));
    selectedMeal = null;
    renderParsedItems();
    resultEl.style.display = "block";
    loadToday();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    logBtn.disabled = false;
  }
});

// ---------- Quick Entry ----------
// Free-Text Quick Entry contract: the food/dish field is an ordinary
// free-text input, always accepted whether or not it matches anything in
// the catalogue — the catalogue is knowledge, never a gatekeeper.
// Quantity and scale are explicit, independent, always-visible controls
// (never coupled to the typed description). Quick Entry bypasses the NL
// parser entirely: {description, quantity, scale} goes straight to
// POST /api/food/quick-entry, which resolves it via the same Food
// Resolver a parsed segment uses, and returns the SAME item shape the
// natural-language path produces — feeding the same parsedItems array
// and card rendering. Submission is NEVER blocked by "no matches."

// Mirrors measurement_definitions.py's FRACTION_PRESETS/GLOBAL_SCALE_IDS
// — both are now food-independent (quantity and scale never depend on
// what was typed), so they're rendered once, not fetched per food.
const QE_FRACTION_PRESETS = [
  { label: "⅛", value: 0.125 }, { label: "⅕", value: 0.2 }, { label: "¼", value: 0.25 },
  { label: "⅓", value: 1 / 3 }, { label: "⅜", value: 0.375 }, { label: "½", value: 0.5 },
  { label: "⅝", value: 0.625 }, { label: "⅔", value: 2 / 3 }, { label: "¾", value: 0.75 },
  { label: "⅘", value: 0.8 }, { label: "⅞", value: 0.875 }, { label: "1", value: 1 },
  { label: "1¼", value: 1.25 }, { label: "1½", value: 1.5 }, { label: "1¾", value: 1.75 }, { label: "2", value: 2 },
];
const QE_GLOBAL_SCALES = [
  { id: "30tbsp_container", label: "30 tbsp" }, { id: "tbsp", label: "tbsp" }, { id: "tsp", label: "tsp" },
  { id: "cup", label: "cup" }, { id: "glass", label: "glass" }, { id: "ml", label: "ml" },
  { id: "litre", label: "litre" }, { id: "piece", label: "piece" }, { id: "scoop", label: "scoop" },
  { id: "serving", label: "serving" }, { id: "packet", label: "packet" }, { id: "pack", label: "pack" },
];

let qeSelectedQty = null;
let qeSelectedScale = null;
let qeSuggestionIndex = {};
let qeListToken = 0; // guards against a stale async suggestion fetch overwriting a newer one

document.getElementById("quick-entry-toggle").addEventListener("click", () => {
  const panel = document.getElementById("quick-entry-panel");
  const toggle = document.getElementById("quick-entry-toggle");
  const opening = panel.style.display === "none";
  panel.style.display = opening ? "block" : "none";
  toggle.textContent = opening ? "− Quick Entry" : "+ Quick Entry";
  if (opening) {
    renderQeQuantityChips();
    renderQeScaleChips();
    if (!document.getElementById("qe-description").value.trim()) loadQeSuggestions("");
  }
});

function renderQeQuantityChips() {
  const qtyChips = document.getElementById("qe-qty-chips");
  qtyChips.innerHTML = QE_FRACTION_PRESETS.map((q) =>
    `<button type="button" class="chip qe-qty-chip" data-qty="${q.value}">${escapeHtml(q.label)}</button>`
  ).join("");
  qtyChips.querySelectorAll(".qe-qty-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      qtyChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      document.getElementById("qe-qty-custom-toggle").classList.remove("selected");
      document.getElementById("qe-qty-custom-input").style.display = "none";
      chip.classList.add("selected");
      qeSelectedQty = Number(chip.dataset.qty);
    });
  });
}

function renderQeScaleChips() {
  // Every one of the 12 global scales is always shown — scale is
  // independent of the typed description (contract sections 5/7): no
  // food-based filtering, no required "allowed unit" list to unlock it.
  const unitChips = document.getElementById("qe-unit-chips");
  unitChips.innerHTML = QE_GLOBAL_SCALES.map((s) =>
    `<button type="button" class="chip qe-unit-chip" data-unit="${s.id}">${escapeHtml(s.label)}</button>`
  ).join("");
  unitChips.querySelectorAll(".qe-unit-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      unitChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      qeSelectedScale = chip.dataset.unit;
    });
  });
}

document.getElementById("qe-qty-custom-toggle").addEventListener("click", () => {
  const input = document.getElementById("qe-qty-custom-input");
  const toggle = document.getElementById("qe-qty-custom-toggle");
  const showing = input.style.display !== "none";
  if (showing) {
    input.style.display = "none";
    toggle.classList.remove("selected");
    return;
  }
  document.getElementById("qe-qty-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
  toggle.classList.add("selected");
  input.style.display = "inline-block";
  input.focus();
});

// Accepts a plain decimal ("0.6") or a simple a/b fraction ("3/5", "7/8").
// Returns null for anything else, rather than guessing.
function parseQeCustomQty(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  const fracMatch = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (fracMatch) {
    const num = Number(fracMatch[1]);
    const den = Number(fracMatch[2]);
    return den > 0 ? num / den : null;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

document.getElementById("qe-qty-custom-input").addEventListener("input", (e) => {
  const v = parseQeCustomQty(e.target.value);
  qeSelectedQty = v !== null && v > 0 ? v : null;
});

// ---- Optional, non-blocking catalogue suggestions (contract section 28) ----
// Purely a convenience: clicking one fills the description field. An
// empty/no-match result is never an error and never blocks submission
// (contract section 26 — "No matches" must never be a blocking state).

async function loadQeSuggestions(query) {
  const token = ++qeListToken;
  const box = document.getElementById("qe-suggestions");
  try {
    let groups;
    if (query) {
      const response = await api(`/api/foods/search?q=${encodeURIComponent(query)}`);
      groups = [{ label: "Known food suggestions", foods: response.foods || [] }];
    } else {
      const [recent, frequent] = await Promise.all([
        api(`/api/foods/recent?date=${encodeURIComponent(currentDate)}`),
        api(`/api/foods/frequent?date=${encodeURIComponent(currentDate)}`),
      ]);
      groups = [
        { label: "Recent", foods: recent.foods || [] },
        { label: "Frequent", foods: frequent.foods || [] },
      ];
    }
    if (token !== qeListToken) return;
    renderQeSuggestions(groups);
  } catch (err) {
    if (token !== qeListToken) return;
    box.innerHTML = ""; // suggestions are optional — a failure here is silent, never blocking
  }
}

function renderQeSuggestions(groups) {
  const box = document.getElementById("qe-suggestions");
  const nonEmpty = groups.filter((g) => g.foods.length);
  if (!nonEmpty.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = nonEmpty.map((g) => `
    <div class="section-title">${escapeHtml(g.label)}</div>
    <div class="chip-row">${g.foods.map(qeSuggestionChipHtml).join("")}</div>
  `).join("");
  box.querySelectorAll(".qe-food-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const food = qeSuggestionIndex[Number(btn.dataset.qeId)];
      if (!food) return;
      const input = document.getElementById("qe-description");
      input.value = food.name;
      input.focus();
    });
  });
}

function qeSuggestionChipHtml(food) {
  const id = ++qeIdSeq;
  qeSuggestionIndex[id] = food;
  const countAttr = food.count ? ` data-count="×${food.count}"` : "";
  return `<button type="button" class="chip qe-food-btn${food.count ? " count-badge" : ""}" data-qe-id="${id}"${countAttr}>${escapeHtml(food.name)}</button>`;
}

let qeSuggestDebounce = null;
document.getElementById("qe-description").addEventListener("input", (e) => {
  clearTimeout(qeSuggestDebounce);
  const q = e.target.value.trim();
  qeSuggestDebounce = setTimeout(() => loadQeSuggestions(q), 250);
});

// ---- Add Food ----

document.getElementById("qe-add-btn").addEventListener("click", async () => {
  const errEl = document.getElementById("qe-error");
  errEl.textContent = "";
  const description = document.getElementById("qe-description").value.trim();
  if (!description) {
    errEl.textContent = "Type what you ate first.";
    return;
  }
  if (qeWeighed) {
    addWeighedEntry(description, errEl);
    return;
  }
  if (!qeSelectedQty || qeSelectedQty <= 0) {
    errEl.textContent = "Pick a quantity.";
    return;
  }
  if (!qeSelectedScale) {
    errEl.textContent = "Pick a scale.";
    return;
  }
  if (!selectedMeal) {
    errEl.textContent = "Pick a meal above first.";
    return;
  }
  const btn = document.getElementById("qe-add-btn");
  btn.disabled = true;
  try {
    const resolved = await api("/api/food/quick-entry", {
      method: "POST",
      body: { description, quantity: qeSelectedQty, scale: qeSelectedScale },
    });
    const item = { ...resolved, id: ++itemSeq, meal: selectedMeal };
    parsedItems.push(item);
    renderParsedItems();
    resetQuickEntryForm();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- Weighing Scale Entry ----
// With the switch on, quantity/scale are replaced by grams: a single item
// ("Rice (cooked)" 100g) or a mixed dish (total grams + each part's % of
// the weight). POST /api/food/weighed-entry splits and estimates it from
// the per-100g food table (AI only for a name it doesn't have) and
// returns one card per food/part, logged like any other card.

let qeWeighed = false;
let qeWeighMode = "single";
let qeParts = [];

function newQePart(name = "", percent = "") {
  return { id: ++qeIdSeq, name, percent };
}

document.getElementById("qe-weighed-check").addEventListener("change", (e) => {
  qeWeighed = e.target.checked;
  document.getElementById("qe-standard-fields").style.display = qeWeighed ? "none" : "block";
  document.getElementById("qe-weighed-fields").style.display = qeWeighed ? "block" : "none";
  updateWeighModeUi();
});

document.querySelectorAll("#qe-weigh-mode-chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    qeWeighMode = chip.dataset.mode;
    updateWeighModeUi();
  });
});

// "How many": weigh one piece (or one bowl of a mixed dish) and set how
// many were eaten — one entry for count × weight, not count entries.
function qeCount() {
  const n = Number(document.getElementById("qe-count").value);
  return n > 0 ? n : 1;
}

function setQeCount(n) {
  document.getElementById("qe-count").value = String(Math.max(1, Math.round(n * 100) / 100));
  updateWeighCountUi();
}

document.getElementById("qe-count-minus").addEventListener("click", () => setQeCount(Math.max(1, qeCount() - 1)));
document.getElementById("qe-count-plus").addEventListener("click", () => setQeCount(qeCount() + 1));
document.getElementById("qe-count").addEventListener("input", () => updateWeighCountUi());

function updateWeighCountUi() {
  const mixed = qeWeighMode === "mixed";
  const count = qeCount();
  const grams = Number(document.getElementById("qe-grams").value);
  document.getElementById("qe-grams-label").textContent = count > 1
    ? (mixed ? "Weight of one bowl (g)" : "Weight of one (g)")
    : (mixed ? "Total weight of the dish (g)" : "Weight (g)");
  document.getElementById("qe-count-total").textContent = count > 1 && grams > 0 ? `= ${fmt0(grams * count)}g in all` : "";
  updateQePartGrams();
}

function updateWeighModeUi() {
  const mixed = qeWeighMode === "mixed";
  document.querySelectorAll("#qe-weigh-mode-chips .chip").forEach((c) => c.classList.toggle("selected", c.dataset.mode === qeWeighMode));
  document.getElementById("qe-mixed-fields").style.display = mixed ? "block" : "none";
  updateWeighCountUi();
  document.getElementById("qe-description-label").textContent = qeWeighed && mixed ? "Dish name" : "Food / Dish";
  if (mixed && !qeParts.length) qeParts = [newQePart(), newQePart()];
  renderQeParts();
}

document.getElementById("qe-add-part-btn").addEventListener("click", () => {
  qeParts.push(newQePart());
  renderQeParts();
});

document.getElementById("qe-grams").addEventListener("input", () => updateWeighCountUi());

function renderQeParts() {
  const box = document.getElementById("qe-parts");
  box.innerHTML = qeParts.map((p) => `
    <div class="weigh-part-row" data-part-id="${p.id}">
      <input type="text" class="weigh-part-name" data-part-id="${p.id}" value="${escapeHtml(p.name)}" placeholder="e.g. Rice" aria-label="Part name">
      <input type="number" class="weigh-part-percent" data-part-id="${p.id}" value="${escapeHtml(String(p.percent))}" min="0" max="100" step="any" inputmode="decimal" placeholder="%" aria-label="Percent of the weight">
      <span class="weigh-part-grams" data-part-id="${p.id}"></span>
      <button type="button" class="link weigh-part-remove" data-part-id="${p.id}" aria-label="Remove part">✕</button>
    </div>
  `).join("");
  box.querySelectorAll(".weigh-part-name").forEach((inp) => inp.addEventListener("input", () => {
    const part = qeParts.find((p) => p.id === Number(inp.dataset.partId));
    if (part) part.name = inp.value;
  }));
  box.querySelectorAll(".weigh-part-percent").forEach((inp) => inp.addEventListener("input", () => {
    const part = qeParts.find((p) => p.id === Number(inp.dataset.partId));
    if (part) part.percent = inp.value;
    updateQePartGrams();
  }));
  box.querySelectorAll(".weigh-part-remove").forEach((btn) => btn.addEventListener("click", () => {
    qeParts = qeParts.filter((p) => p.id !== Number(btn.dataset.partId));
    renderQeParts();
  }));
  updateQePartGrams();
}

function updateQePartGrams() {
  const total = Number(document.getElementById("qe-grams").value) * qeCount();
  let sum = 0;
  qeParts.forEach((p) => {
    const pct = Number(p.percent);
    if (Number.isFinite(pct)) sum += pct;
    const el = document.querySelector(`.weigh-part-grams[data-part-id="${p.id}"]`);
    if (el) el.textContent = total > 0 && pct > 0 ? `${fmt0(total * pct / 100)}g` : "";
  });
  const totalEl = document.getElementById("qe-parts-total");
  if (!qeParts.length) {
    totalEl.textContent = "";
    return;
  }
  const ok = Math.abs(sum - 100) <= 0.5;
  totalEl.className = `note ${ok ? "weigh-parts-ok" : "weigh-parts-bad"}`;
  totalEl.textContent = ok ? "Total: 100% ✓" : `Total: ${Math.round(sum * 10) / 10}% — must add up to 100%`;
}

async function addWeighedEntry(description, errEl) {
  if (!selectedMeal) {
    errEl.textContent = "Pick a meal above first.";
    return;
  }
  const grams = Number(document.getElementById("qe-grams").value);
  if (!(grams > 0)) {
    errEl.textContent = qeWeighMode === "mixed" ? "Enter the dish's total weight in grams." : "Enter the weight in grams.";
    return;
  }
  const body = {
    mode: qeWeighMode,
    name: description,
    grams,
    count: qeCount(),
    note: document.getElementById("qe-weigh-note").value.trim(),
  };
  if (qeWeighMode === "mixed") {
    body.parts = qeParts
      .filter((p) => p.name.trim() || p.percent !== "")
      .map((p) => ({ name: p.name.trim(), percent: Number(p.percent) }));
  }
  const btn = document.getElementById("qe-add-btn");
  btn.disabled = true;
  try {
    const response = await api("/api/food/weighed-entry", { method: "POST", body });
    for (const resolved of response.items) {
      parsedItems.push({ ...resolved, id: ++itemSeq, meal: selectedMeal });
    }
    renderParsedItems();
    resetQuickEntryForm();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function resetQuickEntryForm() {
  // The weighed switch and single/mixed choice stay as they are — the
  // next item is often weighed too.
  document.getElementById("qe-grams").value = "";
  document.getElementById("qe-count").value = "1";
  updateWeighCountUi();
  document.getElementById("qe-weigh-note").value = "";
  qeParts = qeWeighMode === "mixed" ? [newQePart(), newQePart()] : [];
  renderQeParts();
  qeSelectedQty = null;
  qeSelectedScale = null;
  document.getElementById("qe-description").value = "";
  document.getElementById("qe-qty-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
  document.getElementById("qe-unit-chips").querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
  document.getElementById("qe-qty-custom-toggle").classList.remove("selected");
  document.getElementById("qe-qty-custom-input").value = "";
  document.getElementById("qe-qty-custom-input").style.display = "none";
  loadQeSuggestions("");
}

function openQuickEntryFor(rawText) {
  const panel = document.getElementById("quick-entry-panel");
  panel.style.display = "block";
  document.getElementById("quick-entry-toggle").textContent = "− Quick Entry";
  renderQeQuantityChips();
  renderQeScaleChips();
  document.getElementById("qe-description").value = rawText || "";
  loadQeSuggestions(rawText || "");
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- What Should I Eat ----------

document.getElementById("recommend-btn").addEventListener("click", () => runRecommend());

async function runRecommend(budgetOverride) {
  const errEl = document.getElementById("recommend-error");
  const content = document.getElementById("recommend-content");
  errEl.textContent = "";
  const instant = document.getElementById("instant-check").checked;
  const list = document.getElementById("list-check").checked;
  const budgetVal = document.getElementById("budget-input").value;
  const body = { date: currentDate, list };
  if (selectedGoal) body.goal = selectedGoal;
  if (instant) body.instant = true;
  const effectiveBudget = budgetOverride !== undefined ? budgetOverride : (budgetVal !== "" ? Number(budgetVal) : undefined);
  if (effectiveBudget !== undefined) body.budget = effectiveBudget;
  content.innerHTML = '<div class="loading-line"><span class="spinner" aria-hidden="true"></span> Finding the best fit…</div>';
  try {
    const response = await api("/api/recommend", { method: "POST", body });
    renderRecommend(response);
  } catch (err) {
    errEl.textContent = err.message;
    content.innerHTML = "";
  }
}

function frequencyExceptionNoteHtml(r) {
  if (!r || !r.frequency_exception_active) return "";
  const pct = r.frequency_alternative_coverage_pct;
  const pctText = pct === null || pct === undefined ? "not enough" : `only ~${pct.toFixed(0)}%`;
  return `
    <div class="frequency-exception-note">
      <strong>Frequency exception</strong>
      This option is normally limited to occasional use. It's included because eligible
      alternatives today would cover ${pctText} of what's still needed.
    </div>
  `;
}

function renderRecommend(response) {
  const content = document.getElementById("recommend-content");

  if (response.source === "plan_repair") {
    let html = `<div class="card"><div class="item-head"><span class="name">Your plan already covers this</span></div><p class="note">${escapeHtml(response.reason)}</p>`;
    if (response.uncertainty_note) html += `<p class="note">${escapeHtml(response.uncertainty_note)}</p>`;
    html += response.options.map((o) => `<div class="item-reason">${escapeHtml(o.description)} → ~${o.projected_kcal.toFixed(0)}kcal / ~${o.projected_protein.toFixed(0)}g protein</div>`).join("");
    html += `</div>`;
    content.innerHTML = html;
    return;
  }

  if (response.status === "needs_budget") {
    const prompt = response.budget.prompt;
    content.innerHTML = `
      <div class="card">
        <p>${escapeHtml(prompt.question)}</p>
        <div class="option-row">
          ${prompt.quick_amounts_inr.map((a) => `<button type="button" class="chip budget-quick-btn" data-amount="${a}">₹${a}</button>`).join("")}
        </div>
      </div>
    `;
    content.querySelectorAll(".budget-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("budget-input").value = btn.dataset.amount;
        runRecommend(Number(btn.dataset.amount));
      });
    });
    return;
  }

  const gap = response.gap;
  if (gap.kcal_max <= 0 && gap.protein_max_g <= 0) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">✓</div><div>${escapeHtml(response.note || "Already within target range — nothing needed right now.")}</div></div>`;
    return;
  }

  let html = `<div class="card"><div class="stat-foot"><span>Remaining</span><span>${Math.max(0, gap.protein_min_g).toFixed(0)}-${Math.max(0, gap.protein_max_g).toFixed(0)}g protein · ${Math.max(0, gap.kcal_min).toFixed(0)}-${Math.max(0, gap.kcal_max).toFixed(0)}kcal</span></div>`;
  if (response.note) html += `<p class="note">${escapeHtml(response.note)}</p>`;
  html += `</div>`;

  lastRecommendResponse = response;

  const singles = response.singles || [];
  singles.slice(0, 5).forEach((r, idx) => {
    const cost = r.estimated_cost_inr !== null && r.estimated_cost_inr !== undefined ? `~₹${r.estimated_cost_inr.toFixed(0)}` : "cost unknown";
    html += `
      <div class="card rec-card ${idx === 0 ? "best-fit" : ""}" id="rec-single-${idx}">
        ${idx === 0 ? '<span class="best-fit-ribbon">BEST FIT</span>' : ""}
        <div class="rec-head"><span class="rec-name">${escapeHtml(r.display_name)}</span></div>
        <p class="note">${escapeHtml(r.practical_quantity)}</p>
        <div class="rec-macros">
          <div><div class="macro-value">${r.protein_g.toFixed(0)}g</div><div class="macro-label">Protein</div></div>
          <div><div class="macro-value">${r.kcal.toFixed(0)}</div><div class="macro-label">Kcal</div></div>
          <div><div class="macro-value">${cost}</div><div class="macro-label">Cost</div></div>
        </div>
        <p class="item-reason">Why: ${escapeHtml(r.reason)}</p>
        ${frequencyExceptionNoteHtml(r)}
        <div class="pill-list">
          ${r.already_available ? '<span class="pill pill-available">✓ Already have this</span>' : ""}
          <span class="pill">${escapeHtml(r.frequency_class)}</span><span class="pill">${escapeHtml(r.preparation_tier)}</span>
        </div>
        <div class="option-row">
          <button type="button" class="primary log-this-btn" data-single-idx="${idx}">Log This</button>
          <button type="button" class="secondary alternatives-btn" data-single-idx="${idx}">Alternatives</button>
        </div>
        <p class="log-status" data-single-idx="${idx}"></p>
      </div>
    `;
  });

  (response.combos || []).forEach((c, cIdx) => {
    const names = c.items.map((i) => `${i.display_name} (${i.practical_quantity})`).join(" + ");
    const cost = c.total_cost_inr !== null && c.total_cost_inr !== undefined ? `~₹${c.total_cost_inr.toFixed(0)}` : "cost unknown";
    const allAvailable = c.items.every((i) => i.already_available);
    html += `
      <div class="card rec-card" id="rec-combo-${cIdx}">
        <div class="rec-head"><span class="rec-name">${escapeHtml(names)}</span></div>
        <div class="rec-macros">
          <div><div class="macro-value">${c.total_protein_g.toFixed(0)}g</div><div class="macro-label">Protein</div></div>
          <div><div class="macro-value">${c.total_kcal.toFixed(0)}</div><div class="macro-label">Kcal</div></div>
          <div><div class="macro-value">${cost}</div><div class="macro-label">Cost</div></div>
        </div>
        <p class="item-reason">${escapeHtml(c.reason)}</p>
        ${c.items.map(frequencyExceptionNoteHtml).join("")}
        ${allAvailable ? '<div class="pill-list"><span class="pill pill-available">✓ Already have this</span></div>' : ""}
        <div class="option-row">
          <button type="button" class="primary log-combo-btn" data-combo-idx="${cIdx}">Log Combination</button>
          <button type="button" class="secondary alternatives-btn" data-combo-idx="${cIdx}">Alternatives</button>
        </div>
        <p class="log-status" data-combo-idx="${cIdx}"></p>
      </div>
    `;
  });

  if (!singles.length && !(response.combos || []).length) {
    html += `<div class="empty-state"><div>No suggestions right now.</div></div>`;
  }

  const warning = response.budget && response.budget.monthly_reference_warning;
  if (warning) html += `<p class="note" style="padding:0 4px">${escapeHtml(warning)}</p>`;

  content.innerHTML = html;
}

// "Log This" / "Log Combination" (Phase 5 Completion Corrections section
// 4): reuse the recommendation's own already-known food/quantity/nutrition
// — never re-collect it from the user, just confirm + a meal + submit.
document.getElementById("recommend-content").addEventListener("click", (e) => {
  const logSingle = e.target.closest(".log-this-btn");
  const logCombo = e.target.closest(".log-combo-btn");
  const alternatives = e.target.closest(".alternatives-btn");
  if (logSingle) return logRecommendation("single", Number(logSingle.dataset.singleIdx));
  if (logCombo) return logRecommendation("combo", Number(logCombo.dataset.comboIdx));
  if (alternatives) return jumpToAlternative(alternatives);
});

function jumpToAlternative(btn) {
  const isSingle = btn.dataset.singleIdx !== undefined;
  const idx = Number(isSingle ? btn.dataset.singleIdx : btn.dataset.comboIdx);
  const nextEl = document.getElementById(isSingle ? `rec-single-${idx + 1}` : `rec-combo-${idx + 1}`);
  const target = nextEl || document.getElementById(isSingle ? "rec-single-0" : "rec-combo-0");
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("rec-card-highlight");
  setTimeout(() => target.classList.remove("rec-card-highlight"), 1200);
}

async function logRecommendation(kind, idx) {
  if (!lastRecommendResponse) return;
  const statusEl = document.querySelector(`.log-status[data-${kind}-idx="${idx}"]`);
  if (!recommendMeal) {
    if (statusEl) statusEl.innerHTML = '<span class="error">Pick a meal above first.</span>';
    return;
  }
  const items = kind === "single" ? [lastRecommendResponse.singles[idx]] : lastRecommendResponse.combos[idx].items;
  const cardId = kind === "single" ? `rec-single-${idx}` : `rec-combo-${idx}`;
  const card = document.getElementById(cardId);
  const buttons = card ? card.querySelectorAll("button") : [];
  buttons.forEach((b) => { b.disabled = true; });
  if (statusEl) statusEl.innerHTML = '<span class="loading-line"><span class="spinner" aria-hidden="true"></span> Logging…</span>';
  try {
    await api("/api/recommend/log", { method: "POST", body: { date: currentDate, meal: recommendMeal, items } });
    if (statusEl) statusEl.innerHTML = `<span class="pill pill-available">✓ Logged to ${escapeHtml(recommendMeal)} — today's totals updated below.</span>`;
    loadToday();
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// ---------- Available Now (Phase 5 Completion Corrections section 3) ----------
// A lightweight checklist only — no stock quantities, no expiry, no
// shopping list. Just which food_ids the user says they can use right now,
// persisted server-side (data/available_now.json via available_now_io.py)
// so the recommendation engine can treat them as tier-1 availability.

let availableNowLoadedOnce = false;
let availableNowIds = new Set();
let availableNowQuery = "";
let availableNowSearchTimer = null;
// Multiple fetches of "current"/"candidates" can be in flight at once (the
// initial tab-load fetch, a debounced search, a toggle's own refresh) and
// can resolve out of order. Each fetcher stamps a request id before
// awaiting and only applies its result if it's still the latest one
// issued — otherwise a slow, now-stale response would clobber a faster,
// newer one (e.g. an initial empty-state load resolving AFTER a quick
// toggle, wiping the just-added item back off the screen).
let availableNowCurrentRequestId = 0;
let availableNowCandidatesRequestId = 0;

async function refreshAvailableNowCurrent() {
  const requestId = ++availableNowCurrentRequestId;
  const data = await api("/api/available-now");
  if (requestId !== availableNowCurrentRequestId) return; // superseded by a newer request
  availableNowIds = new Set(data.available_food_ids || []);
  renderAvailableNowCurrent(data.items || []);
}

async function loadAvailableNow() {
  availableNowLoadedOnce = true;
  try {
    await refreshAvailableNowCurrent();
  } catch (err) {
    // Non-fatal — recommendations still work without Available Now data.
  }
  loadAvailableNowCandidates();
}

function renderAvailableNowCurrent(items) {
  const el = document.getElementById("available-now-current");
  if (!items.length) {
    el.innerHTML = '<span class="note" style="margin:0">Nothing marked available yet.</span>';
    return;
  }
  el.innerHTML = items.map((i) => `
    <span class="pill pill-available">
      ${escapeHtml(i.name)}${i.known ? "" : " (unrecognized)"}
      <button type="button" class="pill-remove" data-food-id="${escapeHtml(i.food_id)}" aria-label="Remove ${escapeHtml(i.name)}">×</button>
    </span>
  `).join("");
  el.querySelectorAll(".pill-remove").forEach((btn) => {
    btn.addEventListener("click", () => toggleAvailableNow(btn.dataset.foodId));
  });
}

async function loadAvailableNowCandidates() {
  const requestId = ++availableNowCandidatesRequestId;
  const list = document.getElementById("available-now-candidates");
  try {
    const data = await api(`/api/available-now/candidates?q=${encodeURIComponent(availableNowQuery)}&limit=30`);
    if (requestId !== availableNowCandidatesRequestId) return; // superseded by a newer request
    const foods = data.foods || [];
    list.innerHTML = foods.map((f) => `
      <button type="button" class="chip${availableNowIds.has(f.food_id) ? " selected" : ""}" data-food-id="${escapeHtml(f.food_id)}">
        ${availableNowIds.has(f.food_id) ? "✓ " : ""}${escapeHtml(f.name)}
      </button>
    `).join("") || '<span class="note" style="margin:0">No matches.</span>';
    list.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => toggleAvailableNow(chip.dataset.foodId));
    });
  } catch (err) {
    if (requestId !== availableNowCandidatesRequestId) return;
    list.innerHTML = `<span class="note" style="margin:0">${escapeHtml(err.message)}</span>`;
  }
}

async function toggleAvailableNow(foodId) {
  try {
    await api("/api/available-now", { method: "POST", body: { action: "toggle", food_id: foodId } });
  } catch (err) {
    return;
  }
  await refreshAvailableNowCurrent();
  loadAvailableNowCandidates();
}

document.getElementById("available-now-search").addEventListener("input", (e) => {
  availableNowQuery = e.target.value;
  clearTimeout(availableNowSearchTimer);
  availableNowSearchTimer = setTimeout(loadAvailableNowCandidates, 200);
});

// ---------- Instant Foods catalogue ----------

let catalogueLoadedOnce = false;
let catalogueFoods = [];
let catalogueRole = "";
let catalogueTier = "";

wireChipGroup("catalogue-role-chips", "role", (role) => { catalogueRole = role; loadCatalogue(); });

document.getElementById("catalogue-tier-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#catalogue-tier-chips .chip").forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected");
  catalogueTier = chip.dataset.tier;
  renderCatalogue();
});

document.getElementById("catalogue-search").addEventListener("input", () => renderCatalogue());
document.getElementById("catalogue-no-fridge").addEventListener("change", () => renderCatalogue());

async function loadCatalogue() {
  catalogueLoadedOnce = true;
  const content = document.getElementById("catalogue-content");
  content.innerHTML = '<div class="loading-line"><span class="spinner" aria-hidden="true"></span> Loading foods…</div>';
  try {
    const qs = new URLSearchParams();
    if (catalogueRole) qs.set("role", catalogueRole);
    const response = await api(`/api/instant-foods?${qs.toString()}`);
    catalogueFoods = response.foods;
    renderCatalogue();
  } catch (err) {
    content.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function renderCatalogue() {
  const content = document.getElementById("catalogue-content");
  const search = document.getElementById("catalogue-search").value.trim().toLowerCase();
  const noFridge = document.getElementById("catalogue-no-fridge").checked;

  let foods = catalogueFoods;
  if (catalogueTier) foods = foods.filter((f) => f.preparation_tier === catalogueTier);
  if (noFridge) foods = foods.filter((f) => !f.requires_refrigeration);
  if (search) {
    foods = foods.filter((f) => f.name.toLowerCase().includes(search) || (f.aliases || []).some((a) => a.toLowerCase().includes(search)));
  }

  if (!foods.length) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">▤</div><div>No foods match these filters.</div></div>`;
    return;
  }

  content.innerHTML = foods.map((f) => {
    const serving = f.practical_measurements && f.practical_measurements[0];
    const cost = f.cost_per_serving !== null && f.cost_per_serving !== undefined ? `~₹${f.cost_per_serving.toFixed(0)}` : "cost unknown";
    return `
      <div class="card food-card">
        <div class="food-name">${escapeHtml(f.name)}</div>
        ${serving ? `<div class="food-serving">${escapeHtml(serving.label)}${serving.kcal != null ? ` — ~${serving.kcal.toFixed(0)}kcal / ~${(serving.protein_g || 0).toFixed(1)}g` : ""}</div>` : ""}
        <div class="food-cost">${cost} · ${escapeHtml(f.frequency_class)}</div>
        <div class="pill-list">
          <span class="pill">${escapeHtml(f.preparation_tier.replace(/_/g, " "))}</span>
          ${f.requires_refrigeration ? '<span class="pill">needs fridge</span>' : '<span class="pill">no fridge</span>'}
        </div>
      </div>
    `;
  }).join("");
}

// ---------- Meal Plans (Phase 5 Completion Corrections section 5) ----------
// A real UI entry point for the two existing plans. Every kcal/protein
// number rendered here comes straight from /api/plans (backed by
// meal_plan.py's own compute_*_default_total — no second calculation).
// Selecting a plan reuses the existing /api/plan/select endpoint — same
// one CLAUDE.md's "select Plan A/B" flow already uses — never a
// competing selection mechanism.

let plansLoadedOnce = false;
let lastPlansResponse = null;
let selectedPlanIdForDate = null;
let expandedPlanId = null;

async function loadPlans() {
  plansLoadedOnce = true;
  const content = document.getElementById("plans-content");
  content.innerHTML = '<div class="loading-line"><span class="spinner" aria-hidden="true"></span> Loading plans…</div>';
  try {
    const [plansData, selection] = await Promise.all([
      api("/api/plans"),
      api(`/api/plan?date=${encodeURIComponent(currentDate)}`),
    ]);
    lastPlansResponse = plansData;
    selectedPlanIdForDate = selection.plan_id || null;
    renderPlans();
  } catch (err) {
    content.innerHTML = `<div class="card"><p class="error">${escapeHtml(err.message)}</p></div>`;
  }
}

function planCostLabel(total) {
  return total.cost !== null && total.cost !== undefined ? `~₹${total.cost.toFixed(0)}` : "cost unknown";
}

function renderPlanMealDetail(plan, meal) {
  const items = [...meal.anchors, ...meal.fixed_sides, ...meal.slots.filter((s) => s.required && s.options.length).map((s) => s.options[0])];
  const rows = items.map((i) => `
    <div class="plan-item-row">
      <span>${escapeHtml(i.dish)} — ${i.qty}</span>
      <span>${i.kcal != null ? i.kcal.toFixed(0) : "–"}kcal · ${i.protein != null ? i.protein.toFixed(0) : "–"}g</span>
    </div>
  `).join("");
  return `
    <div class="plan-meal">
      <div class="plan-meal-head">
        <span class="plan-meal-name">${escapeHtml(MEAL_LABELS[meal.meal_id] || meal.meal_id)}</span>
        <button type="button" class="secondary log-plan-meal-btn" data-plan-id="${escapeHtml(plan.plan_id)}" data-meal-id="${escapeHtml(meal.meal_id)}">Log Meal</button>
      </div>
      ${rows}
      <div class="plan-item-row plan-meal-total">
        <span>Meal total</span>
        <span>${meal.default_total.kcal.toFixed(0)}kcal · ${meal.default_total.protein.toFixed(0)}g</span>
      </div>
    </div>
  `;
}

function renderPlanDetail(plan) {
  const isSelected = selectedPlanIdForDate === plan.plan_id;
  return `
    <div class="card plan-detail" id="plan-detail-${plan.plan_id}">
      <div class="rec-head"><span class="rec-name">${escapeHtml(plan.plan_name)}</span></div>
      ${plan.meals.map((m) => renderPlanMealDetail(plan, m)).join("")}
      <div class="stat-foot" style="margin-top:8px">
        <span>Daily total</span>
        <span>${plan.default_total.kcal.toFixed(0)}kcal · ${plan.default_total.protein.toFixed(0)}g · ${planCostLabel(plan.default_total)}</span>
      </div>
      <div class="option-row">
        <button type="button" class="primary select-plan-btn" data-plan-id="${escapeHtml(plan.plan_id)}" ${isSelected ? "disabled" : ""}>
          ${isSelected ? "Selected for today" : "Select this plan"}
        </button>
        <button type="button" class="secondary log-plan-day-btn" data-plan-id="${escapeHtml(plan.plan_id)}">Log Day</button>
      </div>
      <p class="log-status" data-plan-id="${escapeHtml(plan.plan_id)}"></p>
    </div>
  `;
}

function renderPlans() {
  const content = document.getElementById("plans-content");
  if (!lastPlansResponse || !lastPlansResponse.plans || !lastPlansResponse.plans.length) {
    content.innerHTML = `<div class="empty-state"><div>No meal plans found.</div></div>`;
    return;
  }
  let html = lastPlansResponse.plans.map((plan) => {
    const isSelected = selectedPlanIdForDate === plan.plan_id;
    return `
      <div class="card rec-card">
        <div class="rec-head">
          <span class="rec-name">${escapeHtml(plan.plan_name)}</span>
          ${isSelected ? '<span class="pill pill-available">Selected for today</span>' : ""}
        </div>
        <div class="rec-macros">
          <div><div class="macro-value">${plan.default_total.kcal.toFixed(0)}</div><div class="macro-label">Kcal</div></div>
          <div><div class="macro-value">${plan.default_total.protein.toFixed(0)}g</div><div class="macro-label">Protein</div></div>
          <div><div class="macro-value">${planCostLabel(plan.default_total)}</div><div class="macro-label">Cost</div></div>
        </div>
        <div class="option-row">
          <button type="button" class="secondary view-plan-btn" data-plan-id="${escapeHtml(plan.plan_id)}">
            ${expandedPlanId === plan.plan_id ? "Hide plan" : "View Plan"}
          </button>
        </div>
      </div>
      ${expandedPlanId === plan.plan_id ? renderPlanDetail(plan) : ""}
    `;
  }).join("");
  content.innerHTML = html;
}

document.getElementById("plans-content").addEventListener("click", async (e) => {
  const viewBtn = e.target.closest(".view-plan-btn");
  const selectBtn = e.target.closest(".select-plan-btn");
  const logMealBtn = e.target.closest(".log-plan-meal-btn");
  const logDayBtn = e.target.closest(".log-plan-day-btn");

  if (viewBtn) {
    expandedPlanId = expandedPlanId === viewBtn.dataset.planId ? null : viewBtn.dataset.planId;
    renderPlans();
    return;
  }
  if (selectBtn) {
    selectBtn.disabled = true;
    try {
      await api("/api/plan/select", { method: "POST", body: { date: currentDate, plan_id: selectBtn.dataset.planId } });
      selectedPlanIdForDate = selectBtn.dataset.planId;
      renderPlans();
      loadPlanStatus();
    } catch (err) {
      selectBtn.disabled = false;
    }
    return;
  }
  if (logMealBtn || logDayBtn) {
    const btn = logMealBtn || logDayBtn;
    const planId = btn.dataset.planId;
    const statusEl = document.querySelector(`.log-status[data-plan-id="${planId}"]`);
    btn.disabled = true;
    if (statusEl) statusEl.innerHTML = '<span class="loading-line"><span class="spinner" aria-hidden="true"></span> Logging…</span>';
    try {
      const path = logMealBtn ? "/api/plan/log-meal" : "/api/plan/log-day";
      const body = logMealBtn ? { date: currentDate, plan_id: planId, meal_id: btn.dataset.mealId } : { date: currentDate, plan_id: planId };
      await api(path, { method: "POST", body });
      if (statusEl) statusEl.innerHTML = `<span class="pill pill-available">✓ Logged — today's totals updated below.</span>`;
      loadToday();
    } catch (err) {
      if (statusEl) statusEl.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
    }
    btn.disabled = false;
    return;
  }
});

// ---------- Init ----------

async function init() {
  try {
    const state = await api("/api/today");
    currentDate = state.date;
    document.getElementById("date-input").value = currentDate;
    renderToday(state);
    renderMealTimeline(state.meals || []);
    loadPlanStatus();
    loadFoodEntries();
  } catch (err) {
    document.getElementById("today-content").innerHTML = `<div class="card"><p class="error">${escapeHtml(err.message)}</p></div>`;
  }
}

init();
