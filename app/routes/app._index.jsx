import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { startScan, advanceJob, refreshAfter } from "../lib/rescan.server";
import { countProducts, createdSince, scanNewProducts } from "../lib/scan.server";
import { pendingCount, scanPendingProducts } from "../lib/events.server";
import { cleanStreak } from "../lib/snapshots.server";
import { undoFix, fixedCount } from "../lib/fixes.server";
import { latestScan, scanHistory, saveScan } from "../lib/scans.server";
import { currentPlan } from "../lib/billing.server";
import { planFor, lockedAreas, allAreasPlan } from "../lib/plans";
import { RULE_CATALOG } from "../lib/rules.server";
import { CATEGORIES, categoryOf } from "../lib/categories";
import { PASS_LABELS, SETUP_LABELS } from "../lib/checkLabels";
import { timeAgo } from "../lib/format";
import { TONE, Dot, Notices } from "../lib/ui";

// ---------- server ----------

async function loadState(shop) {
  const [result, history, fixedWeek, fixedTotal] = await Promise.all([
    latestScan(shop),
    scanHistory(shop),
    fixedCount(shop, 7),
    fixedCount(shop),
  ]);
  // The home page shows counts, never findings: those can run to megabytes on a big catalog and
  // belong to the issue pages. checkCount is for the first-run page before any scan is stored.
  const summary = result
    ? { ...result, findings: undefined, productIds: undefined, open: result.findings.length, high: result.findings.filter((f) => f.severity === "high").length }
    : null;
  return { result: summary, history, fixedWeek, fixedTotal, checkCount: RULE_CATALOG.length };
}

export async function loader({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  // Moves a background scan along (and finishes it) every time the page loads or polls.
  const job = await advanceJob(admin.graphql, session.shop, plan.productLimit);
  const state = await loadState(session.shop);
  // Products added since the catalog was last read, for the Scan New Products button and its hint.
  const newProducts = state.result && !job ? await countNewProducts(admin.graphql, state.result.readAt) : 0;
  // Products webhooks queued (Dust Off), and the clean streak when nothing high is open.
  const pending = state.result ? await pendingCount(session.shop) : 0;
  const streak = state.result && state.result.high === 0 ? await cleanStreak(session.shop) : 0;
  // Areas the plan does not cover: their counts stay real, their findings stay behind the plan.
  const locked = lockedAreas(plan);
  return { ...state, job, plan, newProducts, pending, streak, locked };
}

async function countNewProducts(graphql, since) {
  try {
    return since ? await countProducts(graphql, createdSince(since)) : 0;
  } catch {
    return 0; // a count that fails only hides the hint
  }
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const form = await request.formData();
  const intent = form.get("intent") || "scan";

  try {
    let undo = null;
    let job = null;
    let scanNew = null;
    if (intent === "scan") {
      job = await startScan(admin.graphql, session.shop, plan.productLimit);
    }
    if (intent === "scanNew") {
      const latest = await latestScan(session.shop);
      if (!latest) {
        scanNew = { added: 0, findings: 0 };
      } else if (plan.features.newProductScans) {
        // Paid plans: anything a webhook queued, then everything added since the catalog was last read.
        const queued = await scanPendingProducts(admin.graphql, session.shop, latest, plan);
        const next = await scanNewProducts(admin.graphql, session.shop, queued?.next || latest);
        if (next) await saveScan(session.shop, next);
        scanNew = { added: (next?.added || 0) + (queued?.scanned || 0), findings: next?.addedFindings || 0 };
      } else {
        // Dust Off: only the products webhooks queued, within the product limit.
        const queued = await scanPendingProducts(admin.graphql, session.shop, latest, plan);
        scanNew = { added: queued?.scanned || 0, findings: 0, held: queued?.held || 0, queued: true };
      }
    }
    if (intent === "undo") {
      undo = await undoFix(admin.graphql, session.shop, form.get("batchId"));
      // A full rescan on a small catalog brings catalog-wide findings back for the reverted products.
      await refreshAfter(admin.graphql, session.shop, { kind: "products", ids: undo.productIds, full: true }, plan.productLimit);
    }
    const state = await loadState(session.shop);
    return { ok: true, ...state, undo, scanNew, job, plan };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------- helpers ----------

const SEVERITY_WEIGHT = { high: 3, medium: 1.5, low: 0.5 }; // how Start here weighs a check's findings
const START_HERE_ROWS = 5;

// Overview tables. Polaris has no column-width API: the browser sizes each <s-table> from its own
// content, so separate tables never share boundaries on their own. Every overview table (Start
// here, one card per category) therefore uses one header skeleton whose header cells
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

// "Description has junk (raw URL, empty tags, spam phrases)" -> the label and its aside, so the aside
// can sit on its own line. Labels without a trailing parenthetical have no aside.
function splitLabel(label) {
  const m = /^(.*\S)\s+(\([^()]*\))$/.exec(label);
  return m ? { main: m[1], aside: m[2] } : { main: label, aside: "" };
}
const BAR_COLOR = "#616161"; // the trend bars
// Light tints for the side panels. Polaris has no tinted-background prop, so they are inline styles.
const PASSED_BACKGROUND = "rgba(41, 132, 90, 0.08)";
const NOTE_BACKGROUND = "rgba(0, 0, 0, 0.035)";

// ---------- shared pieces ----------

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
function Summary({ result, history, fixedWeek, fixedTotal, checksOn, checksTotal, newProducts, streak, locked }) {
  const open = result.open || 0;
  const lockedFindings = result.rules.filter((r) => locked.includes(r.category)).reduce((sum, r) => sum + r.count, 0);
  const previous = history && history.length >= 2 ? history[history.length - 2].open : null;
  const delta = previous == null ? 0 : open - previous;
  const affected = Math.max(0, result.total - result.clean);
  const n = (v) => (v || 0).toLocaleString("en-US");
  const products = `${n(result.total)} ${result.total === 1 ? "product" : "products"}`;
  const lastScan = `Last scan ${timeAgo(result.scannedAt)} · ${products}${result.ignoredCount ? ` · ${n(result.ignoredCount)} ignored` : ""}${newProducts ? ` · ${n(newProducts)} added since` : ""}`;
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
              {lockedFindings > 0 ? <s-text color="subdued">{n(lockedFindings)} in {allAreasPlan().name} areas</s-text> : null}
              {result.high === 0 ? (
                // The clean streak: consecutive daily snapshots with nothing high open.
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-icon type="check-circle" tone="success" />
                  <s-text color="subdued">
                    {streak > 0 ? `No high severity problems for ${streak} ${streak === 1 ? "day" : "days"}` : "No high severity problems"}
                  </s-text>
                </s-stack>
              ) : null}
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
              <s-text color="subdued">
                <s-link href="/app/fixes">Recent fixes</s-link>
                {fixedTotal ? " · every fix can be undone there" : ""}
              </s-text>
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
function StartHere({ result, locked, onSelect, busy, showPanel }) {
  const ranked = result.rules
    .filter((r) => !locked.includes(r.category))
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
function CategoryFilter({ result, locked, filter, onChange }) {
  const cards = CATEGORIES.map((cat) => {
    const count = result.rules.filter((r) => r.category === cat.id).reduce((n, r) => n + r.count, 0);
    const hasChecks = (result.checks || []).some((c) => c.category === cat.id);
    return { cat, count, show: count > 0 || hasChecks };
  }).filter((c) => c.show);
  if (cards.length < 2) return null;
  const total = result.open || 0;
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
          accessibilityLabel={`Show ${cat.label}, ${count} findings${locked.includes(cat.id) ? `, part of ${allAreasPlan().name}` : ""}`}
        >
          {locked.includes(cat.id) ? <s-icon slot="graphic" type="lock" /> : null}
          {cat.label} · {count}
          {locked.includes(cat.id) ? ` · ${allAreasPlan().name}` : ""}
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
function CategoryCard({ cat, rules, checks, showChecks, showPassed, locked, onSelect, busy }) {
  const total = rules.reduce((n, r) => n + r.count, 0);
  if (locked) {
    // Behind the plan: the heading and the real count, one line, and a way to compare plans.
    const fullPlan = allAreasPlan().name;
    return (
      <s-section padding="none">
        <div style={{ borderTop: `3px solid ${cat.color}`, borderRadius: "12px 12px 0 0" }}>
          <CardHeader
            color={cat.color}
            heading={cat.label}
            badges={<s-badge size="small" icon="lock">{fullPlan}</s-badge>}
            aside={<s-text color="subdued" fontVariantNumeric="tabular-nums">{rules.length ? `${total} findings` : "No findings"}</s-text>}
          />
        </div>
        <s-box padding="base" paddingBlockStart="none">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-text color="subdued">These findings are part of {fullPlan}</s-text>
            <s-button href="/app/plans">Compare plans</s-button>
          </s-stack>
        </s-box>
      </s-section>
    );
  }
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

// Remembered per browser: whether the cards list every passed check or just the count.
const SHOW_PASSED_KEY = "catalog-lint:show-passed";

function Overview({ result, history, fixedWeek, fixedTotal, plan, newProducts, streak, locked, onSelect, busy }) {
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
      <Summary result={result} history={history} fixedWeek={fixedWeek} fixedTotal={fixedTotal} checksOn={checksOn} checksTotal={checks.length} newProducts={newProducts} streak={streak} locked={locked} />

      {newProducts > 0 && !plan.features.newProductScans ? (
        // The free plan can only run a full scan; the paid plans get a Scan New Products button.
        <s-banner tone="info" heading={`${newProducts.toLocaleString("en-US")} ${newProducts === 1 ? "product" : "products"} added since your last scan`}>
          <s-paragraph>
            Scanning only what is new is part of the {planFor("newProductScans").name} plan. <s-link href="/app/plans">Upgrade</s-link>, or run
            a full scan.
          </s-paragraph>
        </s-banner>
      ) : null}

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
        <StartHere result={result} locked={locked} onSelect={onSelect} busy={busy} showPanel={showChecks} />
      )}

      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <CategoryFilter result={result} locked={locked} filter={filter} onChange={setFilter} />
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
        return <CategoryCard key={cat.id} cat={cat} rules={rules} checks={catChecks} showChecks={showChecks} showPassed={showPassed} locked={locked.includes(cat.id)} onSelect={onSelect} busy={busy} />;
      })}
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
              {scanning ? "Scanning…" : "Run Full Scan"}
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

// ---------- page ----------

export default function Index() {
  const initial = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  // The loader is revalidated after every action and while a background scan runs, so it is the
  // source of truth for the page; the fetcher's data only carries the action's notices.
  const { result, history, fixedWeek, fixedTotal, job, checkCount, plan, newProducts, pending, streak, locked } = initial;
  const revalidator = useRevalidator();
  const scanning = job?.status === "running";

  useEffect(() => {
    if (!scanning) return undefined;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [scanning, revalidator]);

  const submit = (payload) => fetcher.submit(payload, { method: "post" });
  const runScan = () => submit({ intent: "scan" });
  const runUndo = (batchId) => submit({ intent: "undo", batchId });
  const runScanNew = () => submit({ intent: "scanNew" });
  const scanningNew = busy && fetcher.formData?.get("intent") === "scanNew";
  // Each check has a page of its own (app.issues.$ruleId.jsx) with the products it flagged.
  const openIssue = (ruleId) => navigate(`/app/issues/${ruleId}`);

  return (
    <s-page heading="TidyUp: Product Data Cleanup" inlineSize="large">
      <s-button slot="primary-action" variant="primary" onClick={runScan} loading={busy || undefined} disabled={scanning || undefined}>
        {scanning ? "Scanning…" : result ? "Scan Again" : "Run Full Scan"}
      </s-button>
      {result && (plan.features.newProductScans || pending > 0) ? (
        // Paid plans: the products added since the last read (webhooks handle changes as they happen).
        // Dust Off: the products webhooks queued, once there are any.
        <s-button
          slot="secondary-actions"
          onClick={runScanNew}
          loading={scanningNew || undefined}
          disabled={busy || scanning || undefined}
          accessibilityLabel={plan.features.newProductScans ? (newProducts ? `Scan ${newProducts} new products` : "No new products to scan") : `Re-check ${pending} changed products`}
        >
          {plan.features.newProductScans
            ? newProducts
              ? `Scan New Products (${newProducts})`
              : "Scan New Products"
            : `Scan Changed Products (${pending})`}
        </s-button>
      ) : null}

      <Notices data={data} onUndo={runUndo} busy={busy} />
      <ScanProgress job={job} />

      {!result ? (
        <Welcome checkCount={checkCount} onScan={runScan} busy={busy} scanning={scanning} />
      ) : (
        <Overview
          result={result}
          history={history}
          fixedWeek={fixedWeek}
          fixedTotal={fixedTotal}
          plan={plan}
          newProducts={newProducts}
          streak={streak}
          locked={locked}
          onSelect={openIssue}
          busy={busy}
        />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
