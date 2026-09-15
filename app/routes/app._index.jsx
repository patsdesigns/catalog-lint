import { useState, useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { scanCatalog } from "../lib/scan.server";
import { applyFix, undoFix, recentFixes, fixedCount } from "../lib/fixes.server";
import { saveScan, latestScan, scanHistory } from "../lib/scans.server";
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
  const { session } = await authenticate.admin(request);
  return loadState(session.shop);
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") || "scan";

  try {
    let fix = null;
    let undo = null;
    let edit = null;
    if (intent === "fix") {
      const ruleId = form.get("ruleId");
      fix = { ruleId, ...(await applyFix(admin.graphql, session.shop, ruleId)) };
    }
    if (intent === "undo") undo = await undoFix(admin.graphql, session.shop, form.get("batchId"));
    if (intent === "learn") await addWord(session.shop, form.get("word"));
    if (intent === "ignore") await addIgnore(session.shop, JSON.parse(form.get("finding")));
    if (intent === "edit") {
      edit = await applyEdit(admin.graphql, session.shop, JSON.parse(form.get("edit")), form.get("value"));
    }
    const fresh = await scanCatalog(admin.graphql, session.shop);
    await saveScan(session.shop, fresh);
    const state = await loadState(session.shop);
    return { ok: true, ...state, fix, undo, edit };
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

function ruleLabel(id) {
  return RULE_LABELS[id] || id.replace(/_/g, " ");
}
function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}
function truncate(text, n = 48) {
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
const TONE_COLOR = { success: "#29845a", warning: "#b98900", critical: "#e51c00" };

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
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: "6px", padding: "2px 10px", borderRadius: "999px",
        background: `${cat.color}1a`, color: cat.color, fontSize: "12px", fontWeight: 600, lineHeight: "20px",
      }}
    >
      <Dot color={cat.color} size={8} />
      {cat.label}
    </span>
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

function Stat({ label, value, tone, accent }) {
  const color = tone ? TONE_COLOR[tone] : accent;
  return (
    <div style={{ borderLeft: color ? `4px solid ${color}` : undefined, borderRadius: "8px" }}>
    <s-box padding="base" border="base" borderRadius="base" background="subdued">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        {tone ? (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-heading>{value}</s-heading>
            <s-badge tone={tone}>{tone === "success" ? "Good" : tone === "warning" ? "Needs work" : "Poor"}</s-badge>
          </s-stack>
        ) : (
          <s-heading>{value}</s-heading>
        )}
      </s-stack>
    </s-box>
    </div>
  );
}

function Trend({ history }) {
  if (!history || history.length < 2) return <s-text color="subdued">Scan again to build a trend</s-text>;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "32px" }}>
      {history.map((h, i) => (
        <div
          key={i}
          title={`${h.score} on ${new Date(h.at).toLocaleString()}`}
          style={{
            width: "10px",
            height: `${Math.max(3, h.score * 0.32)}px`,
            borderRadius: "3px",
            background: h.score >= 90 ? "#29845a" : h.score >= 70 ? "#b98900" : "#e51c00",
            opacity: i === history.length - 1 ? 1 : 0.45,
          }}
        />
      ))}
    </div>
  );
}

// ---------- overview ----------

function Overview({ result, history, fixes, fixedWeek, onSelect, onFix, onUndo, busy }) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of result.rules) counts[r.severity] += r.count;

  return (
    <>
      <s-section>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
          <Stat label="Health score" value={`${result.score} / 100`} tone={scoreTone(result.score)} />
          <Stat label="Products scanned" value={result.total} />
          <Stat label="Clean products" value={result.clean} />
          <Stat label="Open issues" value={result.findings.length} />
          <Stat label="Fixed this week" value={fixedWeek} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
          <Trend history={history} />
          <s-text color="subdued">
            Last scan {timeAgo(result.scannedAt)}
            {result.ignoredCount ? `, ${result.ignoredCount} ignored` : ""}
          </s-text>
        </div>
      </s-section>

      {result.rules.length === 0 ? (
        <s-section>
          <s-stack alignItems="center" gap="small">
            <s-icon type="check-circle" tone="success" size="large" />
            <s-heading>Your catalog is clean</s-heading>
            <s-text color="subdued">No issues found across {result.total} products.</s-text>
          </s-stack>
        </s-section>
      ) : (
        CATEGORIES.map((cat) => {
          const rules = result.rules.filter((r) => r.category === cat.id);
          if (rules.length === 0) return null;
          const total = rules.reduce((n, r) => n + r.count, 0);
          return (
            <s-section key={cat.id} padding="none">
              <div style={{ padding: "16px 16px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `3px solid ${cat.color}`, borderRadius: "8px 8px 0 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <Dot color={cat.color} />
                  <s-heading>{cat.label}</s-heading>
                </div>
                <s-text color="subdued">{total} findings</s-text>
              </div>
              <s-table loading={busy || undefined}>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Issue</s-table-header>
                  <s-table-header listSlot="inline">Severity</s-table-header>
                  <s-table-header listSlot="labeled" format="numeric">Findings</s-table-header>
                  <s-table-header listSlot="secondary">Action</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rules.map((rule) => (
                    <s-table-row key={rule.ruleId} clickDelegate={`rule-${rule.ruleId}`}>
                      <s-table-cell>
                        <s-link id={`rule-${rule.ruleId}`} onClick={() => onSelect(rule.ruleId)}>{rule.label}</s-link>
                      </s-table-cell>
                      <s-table-cell><s-badge tone={TONE[rule.severity]}>{rule.severity}</s-badge></s-table-cell>
                      <s-table-cell>{rule.count}</s-table-cell>
                      <s-table-cell>
                        {rule.fixable ? (
                          <s-button variant="secondary" onClick={() => onFix(rule.ruleId)} disabled={busy || undefined}>{rule.fixLabel}</s-button>
                        ) : (
                          <s-text color="subdued">Review and edit</s-text>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-section>
          );
        })
      )}

      {fixes && fixes.length > 0 ? (
        <s-section padding="none">
          <div style={{ padding: "16px 16px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
            <Dot color="#8a8f98" />
            <s-heading>Recent fixes</s-heading>
          </div>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Fix</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Changes</s-table-header>
              <s-table-header listSlot="secondary">When</s-table-header>
              <s-table-header listSlot="inline">Undo</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {fixes.map((f) => (
                <s-table-row key={f.batchId}>
                  <s-table-cell>{ruleLabel(f.ruleId)}</s-table-cell>
                  <s-table-cell>{f.count}</s-table-cell>
                  <s-table-cell>{timeAgo(f.at)}</s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" onClick={() => onUndo(f.batchId)} disabled={busy || undefined}>Undo</s-button>
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

function FindingRow({ f, onSave, onLearn, onIgnore, busy }) {
  const edit = f.edit;
  const [value, setValue] = useState(edit?.suggested ?? "");
  const canSave = edit && value.trim() !== "" && value !== edit.current;
  const rowLabel = f.detail && f.detail !== f.productTitle ? f.detail : "";

  return (
    <s-table-row>
      <s-table-cell>
        <s-link href={adminUrl(f.productId)} target="_blank">{f.productTitle}</s-link>
      </s-table-cell>
      <s-table-cell><s-text color="subdued">{truncate(rowLabel, 40)}</s-text></s-table-cell>
      <s-table-cell>
        {edit ? <s-text>{edit.current ? truncate(edit.current, edit.multiline ? 80 : 32) : "(empty)"}</s-text> : null}
      </s-table-cell>
      <s-table-cell>
        {edit ? (
          edit.multiline ? (
            <s-text-area
              label="Corrected value"
              labelAccessibilityVisibility="exclusive"
              rows={2}
              value={value}
              onInput={(e) => setValue(e.target.value)}
            ></s-text-area>
          ) : (
            <s-text-field
              label="Corrected value"
              labelAccessibilityVisibility="exclusive"
              placeholder={edit.hint || "Type a value"}
              value={value}
              onInput={(e) => setValue(e.target.value)}
            ></s-text-field>
          )
        ) : (
          <s-link href={adminUrl(f.productId)} target="_blank">Open in Shopify</s-link>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {edit ? (
            <s-button variant="primary" onClick={() => onSave(edit, value)} disabled={!canSave || busy || undefined}>
              Save
            </s-button>
          ) : null}
          {f.word ? (
            <s-button variant="tertiary" onClick={() => onLearn(f.word)} disabled={busy || undefined} accessibilityLabel={`Add ${f.word} to dictionary`}>
              Trust word
            </s-button>
          ) : null}
          <s-button variant="tertiary" onClick={() => onIgnore(f)} disabled={busy || undefined}>Ignore</s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

function Detail({ rule, findings, onBack, onFix, onSave, onLearn, onIgnore, busy }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? findings.filter((f) => f.productTitle.toLowerCase().includes(q) || (f.detail || "").toLowerCase().includes(q))
    : findings;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;

  return (
    <s-section padding="none">
      <div style={{ padding: "16px 16px 8px" }}>
        <s-heading>{rule.count} findings</s-heading>
      </div>
      <s-table loading={busy || undefined}>
        <s-search-field
          slot="filters"
          label="Search"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search products"
          value={query}
          onInput={(e) => setQuery(e.target.value)}
        ></s-search-field>
        <s-table-header-row>
          <s-table-header listSlot="primary">Product</s-table-header>
          <s-table-header listSlot="secondary">Detail</s-table-header>
          <s-table-header listSlot="labeled">Current</s-table-header>
          <s-table-header listSlot="labeled">Corrected</s-table-header>
          <s-table-header listSlot="inline">Actions</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((f, i) => (
            <FindingRow
              key={`${f.productId}-${f.variantId || ""}-${f.word || ""}-${i}`}
              f={f}
              onSave={onSave}
              onLearn={onLearn}
              onIgnore={onIgnore}
              busy={busy}
            />
          ))}
        </s-table-body>
      </s-table>
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
  const state = data?.ok ? data : initial;
  const { result, history, fixes, fixedWeek } = state;
  const [selected, setSelected] = useState(null);

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
        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            <CategoryChip id={rule.category} />
            <s-badge tone={TONE[rule.severity]}>{rule.severity} severity</s-badge>
            <s-text color="subdued">{findings.length} findings. Edit the corrected value and save, or ignore what is intentional.</s-text>
          </s-stack>
        </s-section>
        <Detail
          rule={rule}
          findings={findings}
          onBack={() => setSelected(null)}
          onFix={runFix}
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
      <s-button slot="primary-action" variant="primary" onClick={runScan} loading={busy || undefined}>
        {result ? "Scan again" : "Run scan"}
      </s-button>
      {result ? (
        <s-button slot="secondary-actions" onClick={() => exportCsv(result)}>Export CSV</s-button>
      ) : null}

      <Notices data={data} onUndo={runUndo} busy={busy} />

      {!result ? (
        <s-section>
          <s-stack alignItems="center" gap="small">
            <s-icon type="search" size="large" />
            <s-heading>Scan your catalog</s-heading>
            <s-text color="subdued">
              Finds missing images, descriptions, SKUs, weights, misspellings, duplicate SKUs, and
              inconsistent vendors. Nothing changes until you choose to.
            </s-text>
            <s-button variant="primary" onClick={runScan} loading={busy || undefined}>Run first scan</s-button>
          </s-stack>
        </s-section>
      ) : (
        <Overview
          result={result}
          history={history}
          fixes={fixes}
          fixedWeek={fixedWeek}
          onSelect={setSelected}
          onFix={runFix}
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
