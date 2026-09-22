import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { startScan, advanceJob, refreshAfter } from "../lib/rescan.server";
import { applyFix, undoFix, recentFixes, fixedCount } from "../lib/fixes.server";
import { latestScan, scanHistory } from "../lib/scans.server";
import { addWord } from "../lib/dictionary.server";
import { addIgnore, ignoreKey } from "../lib/ignores.server";
import { currentPlan } from "../lib/billing.server";
import { planFor } from "../lib/plans";
import { applyEdit } from "../lib/edits.server";
import { RULE_CATALOG } from "../lib/rules.server";
import { CATEGORIES, categoryOf } from "../lib/categories";
import { PASS_LABELS, SETUP_LABELS } from "../lib/checkLabels";
import { timeAgo, adminUrl, truncate } from "../lib/format";

// ---------- server ----------

async function loadState(shop) {
  const [result, history, fixes, fixedWeek, fixedTotal] = await Promise.all([
    latestScan(shop),
    scanHistory(shop),
    recentFixes(shop),
    fixedCount(shop, 7),
    fixedCount(shop),
  ]);
  // checkCount: how many checks exist, for the first-run page before any scan is stored.
  return { result, history, fixes, fixedWeek, fixedTotal, checkCount: RULE_CATALOG.length };
}

export async function loader({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  // Moves a background scan along (and finishes it) every time the page loads or polls.
  const job = await advanceJob(admin.graphql, session.shop, plan.productLimit);
  return { ...(await loadState(session.shop)), job, plan };
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const form = await request.formData();
  const intent = form.get("intent") || "scan";
  // Features the plan does not include are refused here as well as hidden in the page.
  const gate = { edit: ["inlineEdits", "Inline edits are"], learn: ["dictionary", "The spelling dictionary is"], ignore: ["ignores", "Ignoring findings is"] }[intent];
  if (gate && !plan.features[gate[0]]) {
    return { ok: false, error: `${gate[1]} part of the ${planFor(gate[0]).name} plan and up. Upgrade in Plans.` };
  }

  try {
    let fix = null;
    let undo = null;
    let edit = null;
    let job = null;
    let refresh = null;
    if (intent === "scan") {
      job = await startScan(admin.graphql, session.shop, plan.productLimit);
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
        // From an issue page the undo only clears the row's saved mark; from the home page it re-checks.
        const finding = form.get("finding") ? JSON.parse(form.get("finding")) : null;
        change = finding ? { kind: "unsaved", key: ignoreKey(finding) } : { kind: "products", ids: undo.productIds };
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
        // The row stays, marked saved, so the change can be undone in place; Refresh re-checks it.
        const finding = form.get("finding") ? JSON.parse(form.get("finding")) : null;
        change = edit.ok && finding ? { kind: "saved", key: ignoreKey(finding), batchId: edit.batchId, value: form.get("value") } : null;
      }
      if (intent === "refresh") {
        // Re-check every product this issue lists (a full rescan on a small catalog).
        const ruleId = form.get("ruleId");
        const latest = await latestScan(session.shop);
        const before = (latest?.findings || []).filter((f) => f.ruleId === ruleId);
        const ids = [...new Set(before.map((f) => f.productId))];
        if (ids.length) await refreshAfter(admin.graphql, session.shop, { kind: "products", ids }, plan.productLimit);
        const after = ((await latestScan(session.shop))?.findings || []).filter((f) => f.ruleId === ruleId).length;
        refresh = { ruleId, products: ids.length, before: before.length, after };
      }
      if (change) await refreshAfter(admin.graphql, session.shop, change, plan.productLimit);
    }
    const state = await loadState(session.shop);
    return { ok: true, ...state, fix, undo, edit, refresh, job, plan };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------- helpers ----------

const TONE = { high: "critical", medium: "warning", low: "neutral" };
const SEVERITY_WEIGHT = { high: 3, medium: 1.5, low: 0.5 }; // how Start here weighs a check's findings
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
const START_HERE_ROWS = 5;

// Overview tables. Polaris has no column-width API: the browser sizes each <s-table> from its own
// content, so separate tables never share boundaries on their own. Every overview table (Start
// here, one card per category, Recent fixes) therefore uses one header skeleton whose header cells
// carry a grid with a fixed track. The tracks set each column's intrinsic minimum and maximum,
// identical in every table, so the table algorithm puts every column boundary in the same place no
// matter what the rows contain. The primary track has a range rather than one size, so the text
// column is the one that takes the slack. The action track fits the Review and edit button.
const OVERVIEW_TRACKS = {
  primary: "minmax(240px, 640px)",
  inline: "72px",
  numeric: "56px",
  action: "160px",
};
// Each card splits into its table (about three quarters) and a side panel. Below ~1000px of card
// width the panel moves under the table. (Unquoted minmax() breaks Polaris's responsive parser,
// since parentheses and commas are delimiters there, so these lists use fr units only.)
const CARD_COLUMNS = "@container (inline-size <= 1000px) 1fr, 3fr 1fr";
// Summary: two figures (potential problems, problems fixed) either side of a divider.
const HERO_COLUMNS = "@container (inline-size <= 640px) 1fr, 1fr auto 1fr";
const HERO_DIVIDER_DISPLAY = "@container (inline-size <= 640px) none, auto";
const BLURB_COLUMNS = "@container (inline-size <= 700px) 1fr, 1fr 1fr 1fr";

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
// can sit on its own line. Labels without a trailing parenthetical have no aside.
function splitLabel(label) {
  const m = /^(.*\S)\s+(\([^()]*\))$/.exec(label);
  return m ? { main: m[1], aside: m[2] } : { main: label, aside: "" };
}
// Passing-state sentence for a rule: "Passes when every product has a description."
function passesWhen(ruleId, fallback) {
  const label = PASS_LABELS[ruleId] || fallback;
  // The first letter is lowercased unless the label opens with an acronym (SKUs, SEO, URL).
  return `Passes when ${/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}.`;
}
const BAR_COLOR = "#616161"; // the trend bars
// Light tints for the side panels. Polaris has no tinted-background prop, so they are inline styles.
const PASSED_BACKGROUND = "rgba(41, 132, 90, 0.08)";
const NOTE_BACKGROUND = "rgba(0, 0, 0, 0.035)";

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

function CategoryChip({ id, color = "base" }) {
  const cat = categoryOf(id);
  return (
    <s-grid gridTemplateColumns="auto auto" gap="small-200" alignItems="center">
      <Dot color={cat.color} size={8} />
      <s-text color={color}>{cat.label}</s-text>
    </s-grid>
  );
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
  const { fix, undo, edit, refresh } = data;
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
      {refresh ? (
        <s-banner tone="success" heading={refresh.products ? `Re-checked ${refresh.products} ${refresh.products === 1 ? "product" : "products"}` : "Nothing to re-check"}>
          <s-paragraph>
            {refresh.before > refresh.after
              ? `${refresh.before - refresh.after} ${refresh.before - refresh.after === 1 ? "finding" : "findings"} resolved, ${refresh.after} still open.`
              : refresh.after
                ? `${refresh.after} still open.`
                : "All clear."}
          </s-paragraph>
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

// A card header: colored dot, heading, optional badges on the left; anything on the right.
function CardHeader({ color, heading, badges, aside }) {
  return (
    <s-box padding="base" paddingBlockEnd="small">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="small" alignItems="center">
          {color ? <Dot color={color} /> : null}
          <s-heading>{heading}</s-heading>
          {badges}
        </s-stack>
        {aside}
      </s-stack>
    </s-box>
  );
}

// ---------- summary ----------

// A headline figure: label, display-size number with an optional badge beside it, a hint, and any
// extra content under it. Polaris has no display-size text, so the number is a styled span.
const FIGURE_STYLE = { fontSize: "40px", lineHeight: 1, fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" };
function Figure({ label, value, badge, hint, children }) {
  return (
    <s-stack gap="small">
      <s-text color="subdued">{label}</s-text>
      <s-stack direction="inline" gap="small" alignItems="center">
        <span style={FIGURE_STYLE}>{(value || 0).toLocaleString("en-US")}</span>
        {badge}
      </s-stack>
      {hint ? <s-text color="subdued">{hint}</s-text> : null}
      {children}
    </s-stack>
  );
}

// Open problems per saved result as bars. The tallest bar is the most any of them found, so the
// direction shows even when the counts are close: 4px for none, 40px for the most.
function Trend({ history }) {
  if (!history || history.length < 2) return <s-text color="subdued">Scan again to start a trend.</s-text>;
  const most = history.reduce((m, h) => Math.max(m, h.open || 0), 0);
  const barHeight = (open) => 4 + (most ? Math.round(((open || 0) / most) * 36) : 0);
  // Bar width 12px + 4px gap, sized to the results on record, so no bare baseline trails the bars.
  const trackWidth = history.length * 16 - 4;
  // ISO date, not toLocaleString(): the server and the browser must render the same markup.
  const dateOf = (iso) => (iso ? String(iso).slice(0, 10) : "");
  const describe = (h) => `${(h.open || 0).toLocaleString("en-US")}${h.at ? ` on ${dateOf(h.at)}` : ""}`;
  return (
    <s-stack direction="inline" gap="small" alignItems="end">
      {/* Polaris has no sparkline/bar primitive: the bars are plain boxes on a divider baseline. */}
      <s-stack gap="small-500">
        <div aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "40px", width: `${trackWidth}px` }}>
          {history.map((h, i) => (
            <div
              key={i}
              title={describe(h)}
              style={{
                width: "12px",
                height: `${barHeight(h.open)}px`,
                borderRadius: "2px 2px 0 0",
                background: BAR_COLOR,
                opacity: i === history.length - 1 ? 1 : 0.4,
              }}
            />
          ))}
        </div>
        <s-divider></s-divider>
      </s-stack>
      <s-text color="subdued">Last {history.length} scans</s-text>
      {/* The same count-and-date detail the bar tooltips carry, for readers who cannot hover. */}
      <s-text accessibilityVisibility="exclusive">Problems per scan, oldest first: {history.map(describe).join(", ")}</s-text>
    </s-stack>
  );
}

// The summary: how many potential problems the last scan left and how many problems the app has
// fixed, either side of a divider. Below 640px of card width the two stack.
function Summary({ result, history, fixedWeek, fixedTotal, checksOn, checksTotal }) {
  const open = result.findings.length;
  const previous = history && history.length >= 2 ? history[history.length - 2].open : null;
  const delta = previous == null ? 0 : open - previous;
  const affected = Math.max(0, result.total - result.clean);
  const n = (v) => (v || 0).toLocaleString("en-US");
  const products = `${n(result.total)} ${result.total === 1 ? "product" : "products"}`;
  const lastScan = `Last scan ${timeAgo(result.scannedAt)} · ${products}${result.ignoredCount ? ` · ${n(result.ignoredCount)} ignored` : ""}`;
  return (
    <s-section accessibilityLabel="Catalog summary">
      <s-query-container>
        <s-stack gap="base">
          <s-grid gridTemplateColumns={HERO_COLUMNS} gap="large">
            <Figure
              label="Potential problems"
              value={open}
              badge={
                delta !== 0 ? (
                  // Fewer is better: the direction is in the text as well as the icon and tone.
                  <s-badge tone={delta < 0 ? "success" : "critical"} icon={delta < 0 ? "arrow-down" : "arrow-up"}>
                    {delta < 0 ? "Down" : "Up"} {n(Math.abs(delta))}
                  </s-badge>
                ) : null
              }
              hint={open ? `In ${n(affected)} of ${products}, from ${n(result.rules.length)} ${result.rules.length === 1 ? "check" : "checks"}` : "Nothing to fix"}
            >
              <Trend history={history} />
            </Figure>
            <s-box display={HERO_DIVIDER_DISPLAY}>
              <s-divider direction="block"></s-divider>
            </s-box>
            <Figure
              label="Problems fixed"
              value={fixedTotal}
              hint={fixedWeek ? `${n(fixedWeek)} this week` : fixedTotal ? "None this week" : "Fixes you apply or save are counted here"}
            >
              {fixedTotal ? <s-text color="subdued">Every fix can be undone from Recent fixes.</s-text> : null}
            </Figure>
          </s-grid>
          <s-divider></s-divider>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-text color="subdued">{lastScan}</s-text>
            <s-text color="subdued">
              {checksTotal ? `${checksOn} of ${checksTotal} checks running · ` : ""}
              <s-link href="/app/settings">Settings</s-link>
            </s-text>
          </s-stack>
        </s-stack>
      </s-query-container>
    </s-section>
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

function IssueHeaderRow() {
  return (
    <s-table-header-row>
      <ColumnHeader track="numeric" listSlot="labeled" format="numeric">Findings</ColumnHeader>
      <ColumnHeader track="primary" listSlot="primary">Issue</ColumnHeader>
      <ColumnHeader track="inline" listSlot="inline">Severity</ColumnHeader>
      <ColumnHeader track="action" listSlot="secondary">Action</ColumnHeader>
    </s-table-header-row>
  );
}

// One failing check. `showCategory` adds the section name under the label (for cross-section lists).
function IssueRow({ rule, onSelect, showCategory }) {
  const { main, aside } = splitLabel(rule.label);
  const sub = aside || (showCategory ? categoryOf(rule.category).label : "");
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
        {sub ? (
          // A second line rather than a wrapped label: the parenthetical that explains the rule, or the section it belongs to.
          <s-stack gap="small-500">
            {link}
            <s-text color="subdued">{sub}</s-text>
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

// Small badges with the number of high / medium / low findings in a set of rules.
function SeverityBadges({ rules }) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of rules) counts[r.severity] += r.count;
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {["high", "medium", "low"].filter((s) => counts[s] > 0).map((s) => (
        <s-badge key={s} tone={TONE[s]} size="small">
          {counts[s]} {s}
        </s-badge>
      ))}
    </s-stack>
  );
}

// The checks that ran clean for one category, in a tinted panel beside its table, so the merchant
// sees what was checked and not only what failed. Checks that need a setting that is empty are
// listed as not set up instead of passed.
function PassedChecks({ passed, skipped, off, failing, expanded }) {
  const total = passed.length + failing;
  return (
    // Polaris has no tinted-background prop, so the tint is an inline style; the card grid stretches
    // the panel to the full height of the card body.
    <div style={{ background: PASSED_BACKGROUND }}>
      <s-box padding="base">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type="check-circle" tone="success" />
            <s-text type="strong">
              {total === 0 ? "No checks running" : `${passed.length} of ${total} ${total === 1 ? "check" : "checks"} passed`}
            </s-text>
          </s-stack>
          {expanded && passed.length > 0 ? (
            // Numbered, with each check's wording when it passes ("Every product has an image"),
            // not the problem it looks for. Collapsed to the count unless the merchant asks to see them.
            <s-ordered-list>
              {passed.map((c) => (
                <s-list-item key={c.ruleId}>
                  <s-text color="subdued">{PASS_LABELS[c.ruleId] || c.label}</s-text>
                </s-list-item>
              ))}
            </s-ordered-list>
          ) : null}
          {skipped.length > 0 ? (
            <s-text color="subdued">
              Needs {skipped.map((c) => SETUP_LABELS[c.ruleId] || c.label).join(" and ")} to run.{" "}
              <s-link href="/app/settings">Set up in Settings</s-link>.
            </s-text>
          ) : null}
          {off.length > 0 ? (
            <s-text color="subdued">
              {off.length} {off.length === 1 ? "check" : "checks"} turned off. <s-link href="/app/settings">Settings</s-link>
            </s-text>
          ) : null}
        </s-stack>
      </s-box>
    </div>
  );
}

// The card body: a table on the left and a panel on the right, or the table alone.
function CardBody({ table, panel }) {
  return (
    // The query container scopes CARD_COLUMNS to the card's own width.
    <s-query-container>
      {panel ? (
        <s-grid gridTemplateColumns={CARD_COLUMNS}>
          <div>{table}</div>
          {panel}
        </s-grid>
      ) : (
        table
      )}
    </s-query-container>
  );
}

// The failing checks with the most weight across every section, so a merchant knows where to
// begin: findings count times severity.
function StartHere({ result, onSelect, busy, showPanel }) {
  const ranked = [...result.rules]
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] * b.count - SEVERITY_WEIGHT[a.severity] * a.count || b.count - a.count)
    .slice(0, START_HERE_ROWS);
  if (ranked.length === 0) return null;
  const table = (
    <s-table loading={busy || undefined}>
      <IssueHeaderRow />
      <s-table-body>
        {ranked.map((rule) => (
          <IssueRow key={rule.ruleId} rule={rule} onSelect={onSelect} showCategory />
        ))}
      </s-table-body>
    </s-table>
  );
  const panel = showPanel ? (
    <div style={{ background: NOTE_BACKGROUND }}>
      <s-box padding="base">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type="flag" />
            <s-text type="strong">Why these first</s-text>
          </s-stack>
          <s-text color="subdued">Ranked by how many findings each check has, weighted by how serious they are.</s-text>
          <s-text color="subdued">
            High severity can stop a product from selling or being found, medium costs search traffic or margin, low is
            housekeeping.
          </s-text>
        </s-stack>
      </s-box>
    </div>
  ) : null;
  return (
    <s-section padding="none">
      <CardHeader heading="Start Here" badges={<s-badge tone="warning" size="small">Highest impact</s-badge>} aside={<s-text color="subdued">Most findings, weighted by severity</s-text>} />
      <CardBody table={table} panel={panel} />
    </s-section>
  );
}

// Chips that narrow the cards below to one section.
function CategoryFilter({ result, filter, onChange }) {
  const cards = CATEGORIES.map((cat) => {
    const count = result.rules.filter((r) => r.category === cat.id).reduce((n, r) => n + r.count, 0);
    const hasChecks = (result.checks || []).some((c) => c.category === cat.id);
    return { cat, count, show: count > 0 || hasChecks };
  }).filter((c) => c.show);
  if (cards.length < 2) return null;
  const total = result.findings.length;
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-clickable-chip color={filter ? "base" : "strong"} onClick={() => onChange(null)} accessibilityLabel={`Show all areas, ${total} findings`}>
        All Areas · {total}
      </s-clickable-chip>
      {cards.map(({ cat, count }) => (
        <s-clickable-chip
          key={cat.id}
          color={filter === cat.id ? "strong" : "base"}
          onClick={() => onChange(filter === cat.id ? null : cat.id)}
          accessibilityLabel={`Show ${cat.label}, ${count} findings`}
        >
          {cat.label} · {count}
        </s-clickable-chip>
      ))}
    </s-stack>
  );
}

// One card per product-page section, color coded with the section's color (app/lib/categories.js).
// Every card's table uses the shared header skeleton and the same card grid, so Findings / Issue /
// Severity / Action sit at the same x from card to card. The visible heading names the section (no
// accessibilityLabel, which would add a second hidden heading to the outline). `checks` are this
// category's non-failing checks; `showChecks` is false for scans saved before checks were recorded.
function CategoryCard({ cat, rules, checks, showChecks, showPassed, onSelect, busy }) {
  const total = rules.reduce((n, r) => n + r.count, 0);
  const passed = checks.filter((c) => c.status === "passed");
  const skipped = checks.filter((c) => c.status === "skipped");
  const off = checks.filter((c) => c.status === "off");
  const table =
    rules.length > 0 ? (
      <s-table loading={busy || undefined}>
        <IssueHeaderRow />
        <s-table-body>
          {rules.map((rule) => (
            <IssueRow key={rule.ruleId} rule={rule} onSelect={onSelect} />
          ))}
        </s-table-body>
      </s-table>
    ) : (
      <s-box padding="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="check-circle" tone="success" />
          <s-text color="subdued">No open issues in this section.</s-text>
        </s-stack>
      </s-box>
    );
  return (
    <s-section padding="none">
      {/* Polaris has no prop for an arbitrary accent color, so the stripe is a plain div. Its radius
          matches the card's so the stripe follows the top corners. */}
      <div style={{ borderTop: `3px solid ${cat.color}`, borderRadius: "12px 12px 0 0" }}>
        <CardHeader
          color={cat.color}
          heading={cat.label}
          badges={rules.length ? <SeverityBadges rules={rules} /> : null}
          aside={<s-text color="subdued" fontVariantNumeric="tabular-nums">{rules.length ? `${total} findings` : "No findings"}</s-text>}
        />
      </div>
      <CardBody table={table} panel={showChecks ? <PassedChecks passed={passed} skipped={skipped} off={off} failing={rules.length} expanded={showPassed} /> : null} />
    </s-section>
  );
}

function RecentFixes({ fixes, onUndo, busy, showPanel }) {
  if (!fixes || fixes.length === 0) return null;
  const table = (
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
            <s-table-cell>
              {/* One product: its name. Several: a link to the batch page, where each can be undone alone. */}
              <s-stack gap="small-500">
                <s-text>{f.label || ruleLabel(f.ruleId)}</s-text>
                {f.productCount === 1 ? (
                  <s-text color="subdued">{truncate(f.productTitle, 70)}</s-text>
                ) : f.productCount > 1 ? (
                  <s-link href={`/app/fixes/${f.batchId}`}>{f.productCount} products</s-link>
                ) : null}
              </s-stack>
            </s-table-cell>
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
  );
  // Same composition, column skeleton and card grid as the category cards, so the Changes / Fix /
  // When / Action columns sit exactly under Findings / Issue / Severity / Action.
  return (
    <s-section padding="none">
      <CardHeader heading="Recent Fixes" aside={<s-text color="subdued">Every fix can be undone</s-text>} />
      <CardBody table={table} panel={showPanel ? <div /> : null} />
    </s-section>
  );
}

// Remembered per browser: whether the cards list every passed check or just the count.
const SHOW_PASSED_KEY = "catalog-lint:show-passed";

function Overview({ result, history, fixes, fixedWeek, fixedTotal, plan, onSelect, onUndo, busy }) {
  const [filter, setFilter] = useState(null);
  const [showPassed, setShowPassed] = useState(false);
  const checks = result.checks || [];
  const showChecks = checks.length > 0;
  const checksOn = checks.filter((c) => c.status !== "off").length;

  useEffect(() => {
    try {
      setShowPassed(window.localStorage.getItem(SHOW_PASSED_KEY) === "1");
    } catch {
      // Storage can be unavailable; the default (collapsed) is fine.
    }
  }, []);
  function toggleShowPassed(on) {
    setShowPassed(on);
    try {
      window.localStorage.setItem(SHOW_PASSED_KEY, on ? "1" : "0");
    } catch {
      // Same: a preference that cannot be stored just lasts the page view.
    }
  }

  return (
    <>
      <Summary result={result} history={history} fixedWeek={fixedWeek} fixedTotal={fixedTotal} checksOn={checksOn} checksTotal={checks.length} />

      {result.truncated ? (
        // The plan's product limit left products out of the scan.
        <s-banner tone="warning" heading={`Scanned ${result.total.toLocaleString("en-US")} of ${result.catalogTotal.toLocaleString("en-US")} products`}>
          <s-paragraph>
            {plan.productLimit ? `The ${plan.name} plan scans up to ${plan.productLimit.toLocaleString("en-US")} products. ` : "Scan again to include every product. "}
            <s-link href="/app/plans">Upgrade to scan everything.</s-link>
          </s-paragraph>
        </s-banner>
      ) : null}

      {result.rules.length === 0 ? (
        // The visible heading names the section; no accessibilityLabel, or the outline gets two headings.
        <s-section>
          <s-stack alignItems="center" gap="small" paddingBlock="large">
            <s-icon type="check-circle" tone="success" />
            <s-heading>Your catalog is clean</s-heading>
            <s-text color="subdued">No issues found across {result.total} products.</s-text>
          </s-stack>
        </s-section>
      ) : (
        <StartHere result={result} onSelect={onSelect} busy={busy} showPanel={showChecks} />
      )}

      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <CategoryFilter result={result} filter={filter} onChange={setFilter} />
        {showChecks ? (
          <s-switch label="Show passed checks" checked={showPassed || undefined} onInput={(e) => toggleShowPassed(e.target.checked)}></s-switch>
        ) : null}
      </s-stack>

      {/* One card per product-page section with anything to show: findings, or checks that ran
          clean. Scans saved before checks were recorded only have findings. */}
      {CATEGORIES.map((cat) => {
        if (filter && cat.id !== filter) return null;
        const rules = result.rules.filter((r) => r.category === cat.id);
        const catChecks = checks.filter((c) => c.category === cat.id && c.status !== "failed");
        if (rules.length === 0 && catChecks.length === 0) return null;
        return <CategoryCard key={cat.id} cat={cat} rules={rules} checks={catChecks} showChecks={showChecks} showPassed={showPassed} onSelect={onSelect} busy={busy} />;
      })}

      {filter ? null : <RecentFixes fixes={fixes} onUndo={onUndo} busy={busy} showPanel={showChecks} />}
    </>
  );
}

// ---------- first run ----------

function Welcome({ checkCount, onScan, busy, scanning }) {
  const blurbs = [
    { icon: "search", title: "Find", text: "Missing images, SKUs and weights, misspellings, duplicate SKUs, SEO gaps, pricing slips and more, grouped the way the product page is." },
    { icon: "wand", title: "Fix safely", text: "Review each suggestion and save it, or apply a fix to many products at once. Every change is logged and can be undone." },
    { icon: "chart-histogram-growth", title: "Track", text: "See how many potential problems are left after each scan, what has been fixed, and which checks pass on every product." },
  ];
  return (
    <s-section>
      <s-query-container>
        <s-stack gap="large">
          <s-stack alignItems="center" gap="small" paddingBlock="large">
            <s-icon type="gauge" />
            <s-heading>Scan your catalog</s-heading>
            {/* Polaris has no text-align prop, so the wrapping copy is centered by a plain div. */}
            <div style={{ textAlign: "center", maxWidth: "560px" }}>
              <s-paragraph color="subdued">
                TidyUp runs {checkCount || "dozens of"} checks across every section of the product page and shows what to fix, one card
                per section. Nothing changes until you choose to.
              </s-paragraph>
            </div>
            <s-button variant="primary" onClick={onScan} loading={busy || undefined} disabled={scanning || undefined}>
              {scanning ? "Scanning…" : "Run first scan"}
            </s-button>
          </s-stack>
          <s-divider></s-divider>
          <s-grid gridTemplateColumns={BLURB_COLUMNS} gap="large">
            {blurbs.map((b) => (
              <s-stack key={b.title} gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-icon type={b.icon} />
                  <s-text type="strong">{b.title}</s-text>
                </s-stack>
                <s-text color="subdued">{b.text}</s-text>
              </s-stack>
            ))}
          </s-grid>
        </s-stack>
      </s-query-container>
    </s-section>
  );
}

// ---------- detail ----------

// Column plan for one rule. The SKU column exists once findings record SKUs (scans saved before
// that have none); the Fix column exists when some finding can be corrected here, and its input
// track follows the values (a price or a weight needs far less room than a sentence). The Current
// value column keeps a track of its own (CURRENT_TRACK) so a value and its note wrap as a block
// instead of one word per line.
function detailColumns(findings, features) {
  const edits = findings.map((f) => f.edit).filter(Boolean);
  const numeric = edits.length > 0 && edits.every(isNumericEdit);
  return {
    sku: findings.some((f) => f.sku !== undefined || f.variantCount !== undefined),
    fix: features.inlineEdits && edits.length > 0,
    fixTrack: numeric ? CORRECTED_TRACKS.numeric : CORRECTED_TRACKS.text,
  };
}

// The Fix cell grid: the input track followed by one auto track per button, at every width. The
// input track is a responsive list, so the button tracks go on each of its alternatives.
function fixTracks(track, actionCount) {
  const actions = actionTracks(actionCount);
  return track.split(",").map((part) => `${part.trim()} ${actions}`).join(", ");
}

// What a row is about right now: the value a correction would replace, with the finding's detail
// as a note when it says more, or the detail itself when nothing can be edited in place.
function currentValue(f) {
  let detail = f.detail && f.detail !== f.productTitle ? f.detail : "";
  // Variant details start with the variant title, which the Product column already shows.
  if (f.variantTitle && detail.startsWith(f.variantTitle)) detail = detail.slice(f.variantTitle.length).replace(/^:\s*/, "");
  if (!f.edit) return { value: detail, note: "", empty: false };
  const edit = f.edit;
  const raw = String(edit.current ?? "");
  const value = edit.kind === "weight" && raw ? `${raw} ${(edit.unit || "").toLowerCase()}` : truncate(raw, edit.multiline ? 80 : 40);
  // A misspelling's detail repeats the word; keep the part that says where it is.
  const note = f.word ? detail.replace(/^"[^"]*"\s*/, "") : detail && detail !== raw ? detail : "";
  return { value, note, empty: raw === "" };
}

function SkuCell({ f }) {
  if (f.sku) return <s-text>{f.sku}</s-text>;
  if (f.sku === "") return <s-text color="subdued">None</s-text>;
  if (f.variantCount > 1) return <s-text color="subdued">{f.variantCount} variants</s-text>;
  return null;
}

function FindingRow({ f, columns, features, onSave, onLearn, onIgnore, onUndo, busy }) {
  const edit = f.edit;
  const [value, setValue] = useState(edit?.suggested ?? "");
  const canSave = edit && value.trim() !== "" && value !== edit.current;
  const current = currentValue(f);
  const fieldLabel = `Corrected value for ${f.productTitle}`;
  const variant = f.variantTitle && f.variantTitle !== "Default Title" ? f.variantTitle : "";
  const canEdit = Boolean(edit) && features.inlineEdits;
  // Save or Open in Shopify, then Trust word and Ignore when the plan includes them.
  const buttons = 1 + (f.word && features.dictionary ? 1 : 0) + (features.ignores ? 1 : 0);
  const currentCell = (
    <s-stack gap="small-500">
      {current.empty ? <s-text color="subdued">(empty)</s-text> : current.value ? <s-text>{current.value}</s-text> : null}
      {current.note ? <s-text color="subdued">{truncate(current.note, 80)}</s-text> : null}
    </s-stack>
  );

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-500">
          <s-link
            href={adminUrl(f.productId)}
            target="_blank"
            accessibilityLabel={`${f.productTitle}, opens in Shopify admin in a new tab`}
          >
            {f.productTitle}
          </s-link>
          {variant ? <s-text color="subdued">{truncate(variant, 60)}</s-text> : null}
        </s-stack>
      </s-table-cell>
      {columns.sku ? (
        <s-table-cell>
          {/* A track of its own, so SKUs and "N variants" do not wrap at the hyphen or the space. */}
          <s-grid gridTemplateColumns="minmax(96px, max-content)"><SkuCell f={f} /></s-grid>
        </s-table-cell>
      ) : null}
      <s-table-cell>
        <s-grid gridTemplateColumns={CURRENT_TRACK}>{currentCell}</s-grid>
      </s-table-cell>
      <s-table-cell>
        {f.saved ? (
          // Saved from this page: the row stays so the change can be undone here; Refresh re-checks it.
          <s-stack gap="small-500">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type="check-circle" tone="success" />
              <s-text>Saved</s-text>
              <s-button variant="tertiary" onClick={() => onUndo(f.saved.batchId, f)} disabled={busy || undefined} accessibilityLabel={`Undo the saved change to ${f.productTitle}`}>
                Undo
              </s-button>
            </s-stack>
            {f.saved.value ? <s-text color="subdued">{truncate(f.saved.value, 60)}</s-text> : null}
          </s-stack>
        ) : (
        <s-grid gridTemplateColumns={canEdit ? fixTracks(columns.fixTrack, buttons) : actionTracks(buttons + (edit ? 1 : 0))} gap="small-200" alignItems="center" justifyContent="start">
          {edit && !canEdit ? (
            // The correction field is part of a paid plan; the row can still be fixed in Shopify.
            <s-link href="/app/plans">Upgrade to {planFor("inlineEdits").name}</s-link>
          ) : null}
          {canEdit ? (
            edit.multiline ? (
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
            )
          ) : null}
          {canEdit ? (
            // Secondary, not primary: a row full of disabled primary buttons reads as broken, and the
            // page-level primary action stays the one primary button on the page.
            <s-button
              variant="secondary"
              onClick={() => onSave(edit, value, f)}
              disabled={!canSave || busy || undefined}
              accessibilityLabel={`${edit.kind === "word" ? "Replace the word for" : "Save corrected value for"} ${f.productTitle}`}
            >
              {edit.kind === "word" ? "Replace" : "Save"}
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
          {f.word && features.dictionary ? (
            <s-button variant="tertiary" onClick={() => onLearn(f.word)} disabled={busy || undefined} accessibilityLabel={`Trust word ${f.word}: add it to the dictionary`}>
              Trust word
            </s-button>
          ) : null}
          {features.ignores ? (
            <s-button variant="tertiary" onClick={() => onIgnore(f)} disabled={busy || undefined} accessibilityLabel={`Ignore ${f.productTitle}`}>
              Ignore
            </s-button>
          ) : null}
        </s-grid>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

function Detail({ rule, findings, features, onSave, onLearn, onIgnore, onUndo, onBack, busy }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? findings.filter((f) => f.productTitle.toLowerCase().includes(q) || (f.sku || "").toLowerCase().includes(q) || (f.detail || "").toLowerCase().includes(q))
    : findings;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;
  const columns = detailColumns(findings, features);
  const help = !features.inlineEdits
    ? `Open each product in Shopify to fix it. Inline edits are part of the ${planFor("inlineEdits").name} plan.`
    : columns.fix
      ? "Check the current value, type the correction and save, or ignore what is intentional. Saved changes stay listed until you refresh."
      : "Open each product in Shopify to fix it, or ignore what is intentional.";

  return (
    // The visible "N findings" heading names the section (no accessibilityLabel, which would add a
    // second hidden heading).
    <s-section padding="none">
      <s-box padding="base">
        <s-stack gap="small">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{findings.length} {findings.length === 1 ? "finding" : "findings"}</s-heading>
            <s-badge tone={TONE[rule.severity]}>{rule.severity} severity</s-badge>
            <CategoryChip id={rule.category} color="subdued" />
          </s-stack>
          <s-text color="subdued">{passesWhen(rule.ruleId, rule.label)} {help}</s-text>
        </s-stack>
      </s-box>
      <s-query-container>
        <s-table loading={busy || undefined}>
          {/* The header row comes first so the table finds it as soon as it upgrades; the filters
              slot is placed by its slot name, not by position. */}
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            {columns.sku ? <s-table-header listSlot="labeled">SKU</s-table-header> : null}
            <s-table-header listSlot="labeled">Current value</s-table-header>
            <s-table-header listSlot="labeled">{columns.fix ? "Fix" : "Actions"}</s-table-header>
          </s-table-header-row>
          <s-search-field
            slot="filters"
            label="Search"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search products and SKUs"
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
                onUndo={onUndo}
                features={features}
                busy={busy}
              />
            ))}
          </s-table-body>
        </s-table>
      </s-query-container>
      {rows.length === 0 ? (
        <s-box padding="base"><s-text color="subdued">No products match your search.</s-text></s-box>
      ) : null}
      {/* A second way back under the list, for readers who scrolled past the header. */}
      <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-button variant="tertiary" icon="arrow-left" onClick={onBack}>Back to issues</s-button>
          {hidden > 0 ? <s-text color="subdued">Showing {rows.length} of {filtered.length}. Use search to narrow down.</s-text> : null}
        </s-stack>
      </s-box>
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
  const { result, history, fixes, fixedWeek, fixedTotal, job, checkCount, plan } = initial;
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
  const back = () => setSelected(null);
  const runScan = () => { setSelected(null); submit({ intent: "scan" }); };
  const runFix = (ruleId) => submit({ intent: "fix", ruleId });
  const runUndo = (batchId, finding) => submit(finding ? { intent: "undo", batchId, finding: JSON.stringify(finding) } : { intent: "undo", batchId });
  const learnWord = (word) => submit({ intent: "learn", word });
  const ignoreFinding = (f) => submit({ intent: "ignore", finding: JSON.stringify(f) });
  const saveEdit = (edit, value, finding) => submit({ intent: "edit", edit: JSON.stringify(edit), value, finding: JSON.stringify(finding) });
  const runRefresh = (ruleId) => submit({ intent: "refresh", ruleId });
  const refreshing = busy && fetcher.formData?.get("intent") === "refresh";

  const rule = result && selected ? result.rules.find((r) => r.ruleId === selected) : null;

  if (rule) {
    const findings = result.findings.filter((f) => f.ruleId === rule.ruleId);
    return (
      <s-page heading={rule.label} inlineSize="large">
        {/* The breadcrumb is the standard way back; the button makes it obvious. */}
        <s-link slot="breadcrumb-actions" onClick={back}>Issues</s-link>
        <s-button slot="secondary-actions" onClick={back}>Back to issues</s-button>
        <s-button slot="secondary-actions" onClick={() => runRefresh(rule.ruleId)} loading={refreshing || undefined} disabled={busy || undefined}>
          Refresh
        </s-button>
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
          onBack={back}
          onUndo={runUndo}
          features={plan.features}
          busy={busy}
        />
      </s-page>
    );
  }

  return (
    <s-page heading="TidyUp: Product Data Cleanup" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={runScan} loading={busy || undefined} disabled={scanning || undefined}>
        {scanning ? "Scanning…" : result ? "Scan Again" : "Run Full Scan"}
      </s-button>

      <Notices data={data} onUndo={runUndo} busy={busy} />
      <ScanProgress job={job} />

      {!result ? (
        <Welcome checkCount={checkCount} onScan={runScan} busy={busy} scanning={scanning} />
      ) : (
        <Overview
          result={result}
          history={history}
          fixes={fixes}
          fixedWeek={fixedWeek}
          fixedTotal={fixedTotal}
          plan={plan}
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
