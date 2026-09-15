import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { startScan, advanceJob, refreshAfter } from "../lib/rescan.server";
import { applyFix, undoFix, recentFixes, fixedCount } from "../lib/fixes.server";
import { latestScan, scanHistory } from "../lib/scans.server";
import { addWord } from "../lib/dictionary.server";
import { addIgnore } from "../lib/ignores.server";
import { applyEdit } from "../lib/edits.server";
import { CATEGORIES, categoryOf } from "../lib/categories";

// ---------- server ----------

async function loadState(shop) {
  const [result, history, fixes, fixedWeek] = await Promise.all([
    latestScan(shop),
    scanHistory(shop),
    recentFixes(shop),
    fixedCount(shop, 7),
  ]);
  return { result, history, fixes, fixedWeek };
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  // Moves a background scan along (and finishes it) every time the page loads or polls.
  const job = await advanceJob(admin.graphql, session.shop);
  return { ...(await loadState(session.shop)), job };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") || "scan";

  try {
    let fix = null;
    let undo = null;
    let edit = null;
    let job = null;
    if (intent === "scan") {
      job = await startScan(admin.graphql, session.shop);
    } else {
      // What changed, so the stored scan can be refreshed without re-reading a large catalog.
      let change = null;
      if (intent === "fix") {
        const ruleId = form.get("ruleId");
        const latest = await latestScan(session.shop);
        fix = { ruleId, ...(await applyFix(admin.graphql, session.shop, ruleId, latest?.findings || [])) };
        change = { kind: "products", ids: fix.productIds, ruleId };
      }
      if (intent === "undo") {
        undo = await undoFix(admin.graphql, session.shop, form.get("batchId"));
        change = { kind: "products", ids: undo.productIds };
      }
      if (intent === "learn") {
        const word = form.get("word");
        await addWord(session.shop, word);
        change = { kind: "learn", word };
      }
      if (intent === "ignore") {
        const finding = JSON.parse(form.get("finding"));
        await addIgnore(session.shop, finding);
        change = { kind: "ignore", finding };
      }
      if (intent === "edit") {
        const descriptor = JSON.parse(form.get("edit"));
        edit = await applyEdit(admin.graphql, session.shop, descriptor, form.get("value"));
        change = { kind: "products", ids: [descriptor.productId], ruleId: descriptor.ruleId };
      }
      if (change) await refreshAfter(admin.graphql, session.shop, change);
    }
    const state = await loadState(session.shop);
    return { ok: true, ...state, fix, undo, edit, job };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------- helpers ----------

const TONE = { high: "critical", medium: "warning", low: "neutral" };
const RULE_LABELS = {
  vendor_casing: "Vendor spelling",
  missing_weight: "Shipping weight",
  missing_alt_text: "Image alt text",
  compare_at_not_higher: "Sale price",
  zero_price: "Price",
  missing_sku: "SKU",
  duplicate_sku: "Duplicate SKU",
};
const MAX_ROWS = 100;

// One responsive track list for the metrics row: five equal columns separated by
// vertical dividers on wide containers, a single column on narrow ones.
// (Unquoted minmax() breaks Polaris's responsive parser, since parentheses and commas are
// delimiters there; quote the whole value if minmax is ever needed in an @container list.)
const METRIC_COLUMNS = "@container (inline-size <= 560px) 1fr, 1fr auto 1fr auto 1fr auto 1fr auto 1fr";
const METRIC_DIVIDER_DISPLAY = "@container (inline-size <= 560px) none, auto";

// Overview tables. Polaris has no column-width API: the browser sizes each <s-table> from its own
// content, so separate tables never share boundaries on their own. Every overview table (one card
// per category, plus Recent fixes) therefore uses one header skeleton whose header cells carry a
// grid with a fixed track. The tracks set each column's intrinsic minimum and maximum, identical in
// every table, so the table algorithm puts every column boundary in the same place no matter what
// the rows contain. The primary track has a range rather than one size, so the text column is the
// one that takes the slack. The action track fits the longest fix label.
const OVERVIEW_TRACKS = {
  primary: "minmax(240px, 640px)",
  inline: "72px",
  numeric: "56px",
  action: "240px",
};
// Below this container width the Issue column is too narrow for the one label with a parenthetical
// aside, so the aside is hidden there rather than wrapping that row onto two lines.
const LABEL_ASIDE_DISPLAY = "@container (inline-size <= 900px) none, auto";

// Detail view. Polaris sizes table columns from their content and a bare text field has almost no
// intrinsic width, so the "Corrected" field sits in a one-track grid whose track has a real width:
// wide enough for ~30 characters of text, narrower only for numeric values (a price or a weight).
// (Sizing props such as minInlineSize do not accept the @container syntax at runtime; grid tracks do.)
const CORRECTED_TRACKS = {
  text: "@container (inline-size > 1100px) 320px, (inline-size > 900px) and (inline-size <= 1100px) 260px, 160px",
  numeric: "@container (inline-size > 900px) 120px, 96px",
};
const NUMERIC_FIELDS = new Set(["price", "compareAt"]);
function isNumericEdit(e) {
  return e.kind === "weight" || e.kind === "cost" || (e.kind === "variant" && NUMERIC_FIELDS.has(e.field));
}
// "Current" values longer than one word get a track of their own too, so they are not broken one
// word per line while the product title keeps most of the row.
const CURRENT_TRACK = "@container (inline-size > 1100px) 200px, (inline-size > 900px) and (inline-size <= 1100px) 160px, 140px";
// Row actions sit in one auto track each at every width: auto tracks never shrink, so the table cannot
// wrap a button mid-row, and the flexible Product column yields instead of the actions breaking 2 + 1.
function actionTracks(count) {
  return Array(count).fill("auto").join(" ");
}
function ruleLabel(id) {
  return RULE_LABELS[id] || id.replace(/_/g, " ");
}
// "Description has junk (raw URL, empty tags, spam phrases)" -> the label and its aside, so the aside
// can be hidden where the column is narrow. Labels without a trailing parenthetical have no aside.
function splitLabel(label) {
  const m = /^(.*\S)\s+(\([^()]*\))$/.exec(label);
  return m ? { main: m[1], aside: m[2] } : { main: label, aside: "" };
}
function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}
function truncate(text, n) {
  const t = String(text ?? "");
  return t.length > n ? `${t.slice(0, n)}...` : t;
}
function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
function scoreTone(score) {
  return score >= 90 ? "success" : score >= 70 ? "warning" : "critical";
}
function scoreLabel(tone) {
  return tone === "success" ? "Good" : tone === "warning" ? "Needs work" : "Poor";
}
const TONE_COLOR = { success: "#29845a", warning: "#b98900", critical: "#e51c00" };
// Light tint of the success color for the "checks passed" row at the end of each category card.
// Polaris has no tinted-background prop, so it is an inline style.
const PASSED_BACKGROUND = "rgba(41, 132, 90, 0.08)";
const PASSED_BORDER = "rgba(41, 132, 90, 0.2)";

// Polaris has no primitive that takes an arbitrary hex color, and the category
// colors mirror the Shopify product page (app/lib/categories.js), so the dot is
// the only place that uses an inline style for color. The label next to it stays
// in the default text color so it keeps AA contrast for every category hue.
function Dot({ color, size = 10 }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color, flexShrink: 0 }}
    />
  );
}

function CategoryChip({ id }) {
  const cat = categoryOf(id);
  return (
    <s-grid gridTemplateColumns="auto auto" gap="small-200" alignItems="center">
      <Dot color={cat.color} size={8} />
      <s-text>{cat.label}</s-text>
    </s-grid>
  );
}
function exportCsv(result) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Issue", "Severity", "Product", "Detail", "Product ID"].map(esc).join(",")];
  for (const f of result.findings) {
    lines.push([f.label, f.severity, f.productTitle, f.detail || "", f.productId.split("/").pop()].map(esc).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `catalog-lint-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- shared pieces ----------

function Notices({ data, onUndo, busy }) {
  if (!data) return null;
  if (!data.ok) {
    return (
      <s-banner tone="critical" heading="Something went wrong">
        <s-paragraph>{data.error}</s-paragraph>
      </s-banner>
    );
  }
  const { fix, undo, edit } = data;
  return (
    <>
      {fix ? (
        <s-banner tone={fix.errors.length ? "warning" : "success"} heading={`${ruleLabel(fix.ruleId)}: ${fix.fixed} fixed`}>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-paragraph>
              {[
                fix.skipped > 0 ? `${fix.skipped} skipped, no safe value to use` : null,
                fix.errors.length > 0 ? `${fix.errors.length} failed: ${fix.errors.slice(0, 2).join("; ")}` : null,
              ]
                .filter(Boolean)
                .join(". ") || "Catalog rescanned."}
            </s-paragraph>
            {fix.batchId ? (
              <s-button variant="secondary" onClick={() => onUndo(fix.batchId)} disabled={busy || undefined}>Undo</s-button>
            ) : null}
          </s-stack>
        </s-banner>
      ) : null}
      {undo ? (
        <s-banner tone={undo.errors.length ? "warning" : "success"} heading={`${undo.undone} changes reverted`}>
          {undo.errors.length ? <s-paragraph>{undo.errors.slice(0, 2).join("; ")}</s-paragraph> : null}
        </s-banner>
      ) : null}
      {edit && !edit.ok ? (
        <s-banner tone="critical" heading="Could not save">
          <s-paragraph>{edit.error}</s-paragraph>
        </s-banner>
      ) : null}
    </>
  );
}

// A background scan (Shopify bulk export) in progress or failed. The page polls the loader while
// one is running, so the banner updates on its own.
function ScanProgress({ job }) {
  if (!job) return null;
  if (job.status === "failed") {
    return (
      <s-banner tone="critical" heading="Scan failed">
        <s-paragraph>{job.error || "Shopify could not export the catalog."} Run the scan again to retry.</s-paragraph>
      </s-banner>
    );
  }
  if (job.status !== "running") return null;
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  return (
    <s-banner tone="info" heading={`Scanning ${n(job.expected)} products`}>
      <s-paragraph>
        Shopify is exporting the catalog in the background{job.objects ? `: ${n(job.objects)} records so far` : ""}. This
        page updates by itself, and it is safe to leave and come back.
      </s-paragraph>
    </s-banner>
  );
}

// Metrics card composition: a label over a heading-sized value, five cells in one grid separated by
// dividers. The value has heading styling but the presentation role, so the five tiles do not add
// five h2s next to the section's own (visually hidden) "Catalog health" heading.
function Metric({ label, value, tone }) {
  return (
    <s-stack gap="small-300">
      <s-text>{label}</s-text>
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-heading accessibilityRole="presentation">{value}</s-heading>
        {tone ? <s-badge tone={tone}>{scoreLabel(tone)}</s-badge> : null}
      </s-stack>
    </s-stack>
  );
}

function MetricDivider() {
  return (
    <s-box display={METRIC_DIVIDER_DISPLAY}>
      <s-divider direction="block"></s-divider>
    </s-box>
  );
}

function Trend({ history }) {
  if (!history || history.length < 2) return <s-text color="subdued">Scan again to build a trend</s-text>;
  const last = history[history.length - 1].score;
  const prev = history[history.length - 2].score;
  const delta = last - prev;
  // Bars are on an absolute 0-100 axis, so a perfect score is the tallest bar the track allows and
  // a few points of movement still shows: 4px for 0, 40px for 100.
  const barHeight = (score) => 4 + Math.round((Math.max(0, Math.min(100, score)) / 100) * 36);
  // Bar width 12px + 4px gap, sized to the scans on record, so no bare baseline trails the bars.
  const trackWidth = history.length * 16 - 4;
  // ISO date, not toLocaleString(): the server and the browser must render the same markup.
  const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const describe = (h) => `${h.score}${h.at ? ` on ${dateOf(h.at)}` : ""}`;
  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      {/* Polaris has no sparkline/bar primitive: the bars are plain boxes on a divider baseline. */}
      <s-stack gap="small-500">
        <div aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "40px", width: `${trackWidth}px` }}>
          {history.map((h, i) => (
            <div
              key={i}
              title={describe(h)}
              style={{
                width: "12px",
                height: `${barHeight(h.score)}px`,
                borderRadius: "2px 2px 0 0",
                background: TONE_COLOR[scoreTone(h.score)],
                opacity: i === history.length - 1 ? 1 : 0.45,
              }}
            />
          ))}
        </div>
        <s-divider></s-divider>
      </s-stack>
      <s-text color="subdued">Score over the last {history.length} scans</s-text>
      {/* The same score-and-date detail the bar tooltips carry, for readers who cannot hover. */}
      <s-text accessibilityVisibility="exclusive">Scores, oldest first: {history.map(describe).join(", ")}</s-text>
      {delta !== 0 ? (
        // The direction is in the text as well as the icon and tone.
        <s-badge tone={delta > 0 ? "success" : "critical"} icon={delta > 0 ? "arrow-up" : "arrow-down"}>
          {delta > 0 ? "Up" : "Down"} {Math.abs(delta)} since last scan
        </s-badge>
      ) : null}
    </s-stack>
  );
}

// ---------- overview ----------

// A header cell of the shared overview column skeleton (see OVERVIEW_TRACKS). Numeric columns keep
// their track, and the label inside it, at the end of the cell so the header sits over the
// right-aligned numbers below it.
function ColumnHeader({ track, listSlot, format, children }) {
  const end = format === "numeric" ? "end" : undefined;
  return (
    <s-table-header listSlot={listSlot} format={format}>
      <s-grid gridTemplateColumns={OVERVIEW_TRACKS[track]} justifyContent={end} justifyItems={end}>
        {children}
      </s-grid>
    </s-table-header>
  );
}

function IssueRow({ rule, onSelect }) {
  const { main, aside } = splitLabel(rule.label);
  // The aside is context, but it is still part of the rule name for assistive tech.
  const link = (
    <s-link id={`rule-${rule.ruleId}`} onClick={() => onSelect(rule.ruleId)} accessibilityLabel={aside ? rule.label : undefined}>
      {main}
    </s-link>
  );
  return (
    <s-table-row clickDelegate={`rule-${rule.ruleId}`}>
      <s-table-cell>
        <s-text fontVariantNumeric="tabular-nums">{rule.count}</s-text>
      </s-table-cell>
      <s-table-cell>
        {aside ? (
          // An s-box carries the responsive display (s-text ignores `display` at runtime).
          <s-stack direction="inline" gap="small-200" alignItems="baseline">
            {link}
            <s-box display={LABEL_ASIDE_DISPLAY}>
              <s-text color="subdued">{aside}</s-text>
            </s-box>
          </s-stack>
        ) : (
          link
        )}
      </s-table-cell>
      <s-table-cell><s-badge tone={TONE[rule.severity]}>{rule.severity}</s-badge></s-table-cell>
      <s-table-cell>
        {/* One button of the same size in every row, so the column and the row pitch stay even.
            Bulk fixes live on the detail page, where the merchant sees what they would touch. */}
        <s-button
          variant="secondary"
          onClick={() => onSelect(rule.ruleId)}
          accessibilityLabel={`Review and edit: ${rule.label}`}
        >
          Review and edit
        </s-button>
      </s-table-cell>
    </s-table-row>
  );
}

// The checks that ran clean for one category, in a light-green row at the end of its card, so the
// merchant sees what was checked and not only what failed. Checks that need a setting that is empty
// are listed as not set up instead of passed.
function PassedChecks({ passed, skipped }) {
  return (
    <div style={{ background: PASSED_BACKGROUND, borderTop: `1px solid ${PASSED_BORDER}`, borderRadius: "0 0 12px 12px" }}>
      <s-box padding="base" paddingBlock="small">
        <s-stack gap="small-300">
          {passed.length > 0 ? (
            <s-grid gridTemplateColumns="auto auto minmax(0, 1fr)" gap="small" alignItems="baseline">
              <s-icon type="check-circle" tone="success" />
              <s-text type="strong">{passed.length === 1 ? "1 check passed" : `${passed.length} checks passed`}</s-text>
              <s-text color="subdued">{passed.map((c) => c.label).join(" · ")}</s-text>
            </s-grid>
          ) : null}
          {skipped.length > 0 ? (
            <s-text color="subdued">
              Not set up: {skipped.map((c) => c.label).join(" · ")}. <s-link href="/app/settings">Add them in Settings</s-link>.
            </s-text>
          ) : null}
        </s-stack>
      </s-box>
    </div>
  );
}

// One card per product-page section, color coded with the section's color (app/lib/categories.js).
// Every card's table uses the shared header skeleton, so Findings / Issue / Severity / Action sit at
// the same x from card to card. The visible heading names the section (no accessibilityLabel, which
// would add a second hidden heading to the outline). `checks` are this category's non-failing checks.
function CategoryCard({ cat, rules, checks, onSelect, busy }) {
  const total = rules.reduce((n, r) => n + r.count, 0);
  const passed = checks.filter((c) => c.status === "passed");
  const skipped = checks.filter((c) => c.status === "skipped");
  return (
    <s-section padding="none">
      {/* Polaris has no prop for an arbitrary accent color, so the stripe is a plain div. Its radius
          matches the card's so the stripe follows the top corners. */}
      <div style={{ borderTop: `3px solid ${cat.color}`, borderRadius: "12px 12px 0 0" }}>
        <s-box padding="base" paddingBlockEnd="small">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <Dot color={cat.color} />
              <s-heading>{cat.label}</s-heading>
            </s-stack>
            <s-text color="subdued" fontVariantNumeric="tabular-nums">{rules.length ? `${total} findings` : "No findings"}</s-text>
          </s-stack>
        </s-box>
      </div>
      {rules.length > 0 ? (
        // The query container scopes LABEL_ASIDE_DISPLAY to the table's own width.
        <s-query-container>
          <s-table loading={busy || undefined}>
            <s-table-header-row>
              <ColumnHeader track="numeric" listSlot="labeled" format="numeric">Findings</ColumnHeader>
              <ColumnHeader track="primary" listSlot="primary">Issue</ColumnHeader>
              <ColumnHeader track="inline" listSlot="inline">Severity</ColumnHeader>
              <ColumnHeader track="action" listSlot="secondary">Action</ColumnHeader>
            </s-table-header-row>
            <s-table-body>
              {rules.map((rule) => (
                <IssueRow key={rule.ruleId} rule={rule} onSelect={onSelect} />
              ))}
            </s-table-body>
          </s-table>
        </s-query-container>
      ) : null}
      {passed.length > 0 || skipped.length > 0 ? <PassedChecks passed={passed} skipped={skipped} /> : null}
    </s-section>
  );
}

function Overview({ result, history, fixes, fixedWeek, onSelect, onUndo, busy }) {
  const tone = scoreTone(result.score);
  const lastScan = `Last scan ${timeAgo(result.scannedAt)}${result.ignoredCount ? `, ${result.ignoredCount} ignored` : ""}`;

  return (
    <>
      <s-section accessibilityLabel="Catalog health">
        <s-query-container>
          <s-stack gap="base">
            <s-grid gridTemplateColumns={METRIC_COLUMNS} gap="base">
              <Metric label="Health score" value={`${result.score} / 100`} tone={tone} />
              <MetricDivider />
              <Metric label="Products scanned" value={result.total} />
              <MetricDivider />
              <Metric label="Clean products" value={result.clean} />
              <MetricDivider />
              <Metric label="Open issues" value={result.findings.length} />
              <MetricDivider />
              <Metric label="Fixed this week" value={fixedWeek} />
            </s-grid>
            <s-divider></s-divider>
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <Trend history={history} />
              <s-text color="subdued">{lastScan}</s-text>
            </s-stack>
          </s-stack>
        </s-query-container>
      </s-section>

      {result.rules.length === 0 ? (
        // The visible heading names the section; no accessibilityLabel, or the outline gets two headings.
        <s-section>
          <s-stack alignItems="center" gap="small" paddingBlock="large">
            <s-icon type="check-circle" tone="success" />
            <s-heading>Your catalog is clean</s-heading>
            <s-text color="subdued">No issues found across {result.total} products.</s-text>
          </s-stack>
        </s-section>
      ) : null}

      {/* One card per product-page section with anything to show: findings, or checks that ran
          clean. Scans saved before checks were recorded only have findings. */}
      {CATEGORIES.map((cat) => {
        const rules = result.rules.filter((r) => r.category === cat.id);
        const checks = (result.checks || []).filter((c) => c.category === cat.id && c.status !== "failed");
        if (rules.length === 0 && checks.length === 0) return null;
        return <CategoryCard key={cat.id} cat={cat} rules={rules} checks={checks} onSelect={onSelect} busy={busy} />;
      })}

      {fixes && fixes.length > 0 ? (
        // Same composition and column skeleton as the category cards, so the Changes / Fix / When /
        // Action columns sit exactly under Findings / Issue / Severity / Action.
        <s-section padding="none">
          <s-box padding="base" paddingBlockEnd="small">
            <s-heading>Recent fixes</s-heading>
          </s-box>
          <s-table loading={busy || undefined}>
            <s-table-header-row>
              <ColumnHeader track="numeric" listSlot="labeled" format="numeric">Changes</ColumnHeader>
              <ColumnHeader track="primary" listSlot="primary">Fix</ColumnHeader>
              <ColumnHeader track="inline" listSlot="inline">When</ColumnHeader>
              <ColumnHeader track="action" listSlot="secondary">Action</ColumnHeader>
            </s-table-header-row>
            <s-table-body>
              {fixes.map((f) => (
                <s-table-row key={f.batchId}>
                  <s-table-cell><s-text fontVariantNumeric="tabular-nums">{f.count}</s-text></s-table-cell>
                  <s-table-cell><s-text>{ruleLabel(f.ruleId)}</s-text></s-table-cell>
                  <s-table-cell><s-text color="subdued">{timeAgo(f.at)}</s-text></s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="secondary"
                      onClick={() => onUndo(f.batchId)}
                      disabled={busy || undefined}
                      accessibilityLabel={`Undo ${ruleLabel(f.ruleId)}, ${f.count} changes`}
                    >
                      Undo
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}
    </>
  );
}

// ---------- detail ----------

// Column plan for one rule: "Current" and "Corrected" exist only when some finding fills them,
// and their widths follow the values (a weight or price needs far less room than a sentence).
function detailColumns(findings) {
  const edits = findings.map((f) => f.edit).filter(Boolean);
  const currentLen = edits.reduce((n, e) => Math.max(n, String(e.current ?? "").length), 0);
  const numeric = edits.length > 0 && edits.every(isNumericEdit);
  return {
    current: currentLen > 0,
    corrected: edits.length > 0,
    currentTrack: currentLen > 16 ? CURRENT_TRACK : undefined,
    correctedTrack: numeric ? CORRECTED_TRACKS.numeric : CORRECTED_TRACKS.text,
  };
}

function FindingRow({ f, columns, onSave, onLearn, onIgnore, busy }) {
  const edit = f.edit;
  const [value, setValue] = useState(edit?.suggested ?? "");
  const canSave = edit && value.trim() !== "" && value !== edit.current;
  const label = f.detail && f.detail !== f.productTitle ? f.detail : "";
  const fieldLabel = `Corrected value for ${f.productTitle}`;
  const actionCount = 1 + (f.word ? 1 : 0) + 1;
  const current = edit ? (
    edit.current ? <s-text>{truncate(edit.current, edit.multiline ? 80 : 32)}</s-text> : <s-text color="subdued">(empty)</s-text>
  ) : null;

  return (
    <s-table-row>
      <s-table-cell>
        {/* The finding's detail is a secondary line under the product, so it never gets a crushed column of its own. */}
        <s-stack gap="small-500">
          <s-link
            href={adminUrl(f.productId)}
            target="_blank"
            accessibilityLabel={`${f.productTitle}, opens in Shopify admin in a new tab`}
          >
            {f.productTitle}
          </s-link>
          {label ? <s-text color="subdued">{truncate(label, 80)}</s-text> : null}
        </s-stack>
      </s-table-cell>
      {columns.current ? (
        <s-table-cell>
          {/* The one-track grid exists only when the column needs a width of its own. */}
          {current && columns.currentTrack ? <s-grid gridTemplateColumns={columns.currentTrack}>{current}</s-grid> : current}
        </s-table-cell>
      ) : null}
      {columns.corrected ? (
        <s-table-cell>
          {edit ? (
            <s-grid gridTemplateColumns={columns.correctedTrack}>
              {edit.multiline ? (
                <s-text-area
                  label={fieldLabel}
                  labelAccessibilityVisibility="exclusive"
                  rows={2}
                  placeholder={edit.hint || "Type a value"}
                  value={value}
                  onInput={(e) => setValue(e.target.value)}
                ></s-text-area>
              ) : (
                <s-text-field
                  label={fieldLabel}
                  labelAccessibilityVisibility="exclusive"
                  placeholder={edit.hint || "Type a value"}
                  value={value}
                  onInput={(e) => setValue(e.target.value)}
                ></s-text-field>
              )}
            </s-grid>
          ) : null}
        </s-table-cell>
      ) : null}
      <s-table-cell>
        <s-grid gridTemplateColumns={actionTracks(actionCount)} gap="small-200" alignItems="center" justifyContent="start">
          {edit ? (
            // Secondary, not primary: a row full of disabled primary buttons reads as broken, and the
            // page-level primary action stays the one primary button on the page.
            <s-button
              variant="secondary"
              onClick={() => onSave(edit, value)}
              disabled={!canSave || busy || undefined}
              accessibilityLabel={`Save corrected value for ${f.productTitle}`}
            >
              Save
            </s-button>
          ) : (
            // A link styled as a tertiary button (s-button with href renders an anchor), so the
            // cluster keeps the same height and gap as rows that have a Save button.
            <s-button
              variant="tertiary"
              href={adminUrl(f.productId)}
              target="_blank"
              icon="external"
              accessibilityLabel={`Open in Shopify: ${f.productTitle}, new tab`}
            >
              Open in Shopify
            </s-button>
          )}
          {f.word ? (
            <s-button variant="tertiary" onClick={() => onLearn(f.word)} disabled={busy || undefined} accessibilityLabel={`Trust word ${f.word}: add it to the dictionary`}>
              Trust word
            </s-button>
          ) : null}
          <s-button variant="tertiary" onClick={() => onIgnore(f)} disabled={busy || undefined} accessibilityLabel={`Ignore ${f.productTitle}`}>
            Ignore
          </s-button>
        </s-grid>
      </s-table-cell>
    </s-table-row>
  );
}

function Detail({ rule, findings, onSave, onLearn, onIgnore, busy }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? findings.filter((f) => f.productTitle.toLowerCase().includes(q) || (f.detail || "").toLowerCase().includes(q))
    : findings;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;
  const columns = detailColumns(findings);
  const help = columns.corrected
    ? "Edit the corrected value and save, or ignore what is intentional."
    : "Open each product in Shopify to fix it, or ignore what is intentional.";

  return (
    // The visible "N findings" heading names the section (no accessibilityLabel, which would add a
    // second hidden heading).
    <s-section padding="none">
      <s-box padding="base">
        <s-stack gap="small">
          <s-heading>{findings.length} findings</s-heading>
          <s-stack direction="inline" gap="small" alignItems="center">
            <CategoryChip id={rule.category} />
            <s-badge tone={TONE[rule.severity]}>{rule.severity} severity</s-badge>
            <s-text color="subdued">{help}</s-text>
          </s-stack>
        </s-stack>
      </s-box>
      <s-query-container>
        <s-table loading={busy || undefined}>
          {/* The header row comes first so the table finds it as soon as it upgrades; the filters
              slot is placed by its slot name, not by position. */}
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            {columns.current ? <s-table-header listSlot="labeled">Current</s-table-header> : null}
            {columns.corrected ? <s-table-header listSlot="labeled">Corrected</s-table-header> : null}
            <s-table-header listSlot="inline">Actions</s-table-header>
          </s-table-header-row>
          <s-search-field
            slot="filters"
            label="Search"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search products"
            value={query}
            onInput={(e) => setQuery(e.target.value)}
          ></s-search-field>
          <s-table-body>
            {rows.map((f, i) => (
              <FindingRow
                key={`${f.productId}-${f.variantId || ""}-${f.word || ""}-${i}`}
                f={f}
                columns={columns}
                onSave={onSave}
                onLearn={onLearn}
                onIgnore={onIgnore}
                busy={busy}
              />
            ))}
          </s-table-body>
        </s-table>
      </s-query-container>
      {rows.length === 0 ? (
        <s-box padding="base"><s-text color="subdued">No products match your search.</s-text></s-box>
      ) : null}
      {hidden > 0 ? (
        <s-box padding="base"><s-text color="subdued">Showing {rows.length} of {filtered.length}. Use search to narrow down.</s-text></s-box>
      ) : null}
    </s-section>
  );
}

// ---------- page ----------

export default function Index() {
  const initial = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  // The loader is revalidated after every action and while a background scan runs, so it is the
  // source of truth for the page; the fetcher's data only carries the action's notices.
  const { result, history, fixes, fixedWeek, job } = initial;
  const [selected, setSelected] = useState(null);
  const revalidator = useRevalidator();
  const scanning = job?.status === "running";

  useEffect(() => {
    if (!scanning) return undefined;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [scanning, revalidator]);

  useEffect(() => {
    if (result && selected && !result.rules.some((r) => r.ruleId === selected)) setSelected(null);
  }, [result, selected]);

  const submit = (payload) => fetcher.submit(payload, { method: "post" });
  const runScan = () => { setSelected(null); submit({ intent: "scan" }); };
  const runFix = (ruleId) => submit({ intent: "fix", ruleId });
  const runUndo = (batchId) => submit({ intent: "undo", batchId });
  const learnWord = (word) => submit({ intent: "learn", word });
  const ignoreFinding = (f) => submit({ intent: "ignore", finding: JSON.stringify(f) });
  const saveEdit = (edit, value) => submit({ intent: "edit", edit: JSON.stringify(edit), value });

  const rule = result && selected ? result.rules.find((r) => r.ruleId === selected) : null;

  if (rule) {
    const findings = result.findings.filter((f) => f.ruleId === rule.ruleId);
    return (
      <s-page heading={rule.label} inlineSize="large">
        <s-link slot="breadcrumb-actions" onClick={() => setSelected(null)}>Issues</s-link>
        {rule.fixable ? (
          <s-button slot="primary-action" variant="primary" onClick={() => runFix(rule.ruleId)} disabled={busy || undefined}>
            {rule.fixLabel}
          </s-button>
        ) : null}
        <Notices data={data} onUndo={runUndo} busy={busy} />
        <Detail
          rule={rule}
          findings={findings}
          onSave={saveEdit}
          onLearn={learnWord}
          onIgnore={ignoreFinding}
          busy={busy}
        />
      </s-page>
    );
  }

  return (
    <s-page heading="Catalog Lint" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={runScan} loading={busy || undefined} disabled={scanning || undefined}>
        {scanning ? "Scanning…" : result ? "Scan again" : "Run scan"}
      </s-button>
      {result ? (
        <s-button slot="secondary-actions" onClick={() => exportCsv(result)}>Export CSV</s-button>
      ) : null}

      <Notices data={data} onUndo={runUndo} busy={busy} />
      <ScanProgress job={job} />

      {!result ? (
        // The visible "Scan your catalog" heading names the section.
        <s-section>
          <s-stack alignItems="center" gap="small" paddingBlock="large">
            <s-icon type="search" />
            <s-heading>Scan your catalog</s-heading>
            {/* Polaris has no text-align prop, so the wrapping copy is centered by a plain div. */}
            <div style={{ textAlign: "center", maxWidth: "480px" }}>
              <s-paragraph color="subdued">
                Finds missing images, descriptions, SKUs, weights, misspellings, duplicate SKUs, and
                inconsistent vendors. Nothing changes until you choose to.
              </s-paragraph>
            </div>
            <s-button variant="primary" onClick={runScan} loading={busy || undefined} disabled={scanning || undefined}>
              {scanning ? "Scanning…" : "Run first scan"}
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <Overview
          result={result}
          history={history}
          fixes={fixes}
          fixedWeek={fixedWeek}
          onSelect={setSelected}
          onUndo={runUndo}
          busy={busy}
        />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
