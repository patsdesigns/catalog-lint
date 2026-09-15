import { useState, useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { scanCatalog } from "../lib/scan.server";
import { applyFix } from "../lib/fixes.server";
import { saveScan, latestScan, scanHistory } from "../lib/scans.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const [result, history] = await Promise.all([
    latestScan(session.shop),
    scanHistory(session.shop),
  ]);
  return { result, history };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent") || "scan";

  try {
    let fix = null;
    if (intent === "fix") {
      const ruleId = form.get("ruleId");
      fix = { ruleId, ...(await applyFix(admin.graphql, ruleId)) };
    }
    const fresh = await scanCatalog(admin.graphql);
    const result = await saveScan(session.shop, fresh);
    const history = await scanHistory(session.shop);
    return { ok: true, result, history, fix };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function Trend({ history }) {
  if (!history || history.length < 2) return null;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "28px" }}>
      {history.map((h, i) => (
        <div
          key={i}
          title={`${h.score} on ${new Date(h.at).toLocaleString()}`}
          style={{
            width: "8px",
            height: `${Math.max(2, h.score * 0.28)}px`,
            borderRadius: "2px",
            background:
              h.score >= 90 ? "#29845a" : h.score >= 70 ? "#b98900" : "#e51c00",
            opacity: i === history.length - 1 ? 1 : 0.5,
          }}
        />
      ))}
    </div>
  );
}

const TONE = { high: "critical", medium: "warning", low: "neutral" };
const MAX_ROWS = 50;

function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}

function ScoreBar({ result, history }) {
  const tone =
    result.score >= 90 ? "success" : result.score >= 70 ? "warning" : "critical";
  return (
    <s-section>
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-heading>Health {result.score} / 100</s-heading>
          <s-badge tone={tone}>{result.clean} of {result.total} products clean</s-badge>
          <Trend history={history} />
        </s-stack>
        <s-text color="subdued">
          {result.findings.length} findings, scanned {timeAgo(result.scannedAt)}
        </s-text>
      </s-stack>
    </s-section>
  );
}

function FixSummary({ fix, rules }) {
  const label = rules.find((r) => r.ruleId === fix.ruleId)?.label || fix.ruleId;
  const tone = fix.errors.length ? "warning" : "success";
  const parts = [];
  if (fix.skipped > 0) parts.push(`${fix.skipped} skipped, no safe value to use`);
  if (fix.errors.length > 0) parts.push(`${fix.errors.length} failed: ${fix.errors.slice(0, 3).join("; ")}`);
  if (parts.length === 0) parts.push("Catalog rescanned.");
  return (
    <s-banner tone={tone} heading={`${label}: ${fix.fixed} fixed`}>
      <s-paragraph>{parts.join(". ")}</s-paragraph>
    </s-banner>
  );
}

function Overview({ result, onSelect }) {
  if (result.rules.length === 0) {
    return (
      <s-section heading="All clear">
        <s-paragraph>No issues found. Your catalog is clean.</s-paragraph>
      </s-section>
    );
  }
  return (
    <s-section heading="Issues">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "12px",
        }}
      >
        {result.rules.map((rule) => (
          <s-clickable
            key={rule.ruleId}
            onClick={() => onSelect(rule.ruleId)}
            borderRadius="base"
            accessibilityLabel={`View ${rule.label}`}
          >
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack gap="small">
                <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                  <s-heading>{rule.count}</s-heading>
                  <s-badge tone={TONE[rule.severity]}>{rule.severity}</s-badge>
                </s-stack>
                <s-text>{rule.label}</s-text>
                {rule.fixable ? (
                  <s-text color="subdued">One click fix available</s-text>
                ) : null}
              </s-stack>
            </s-box>
          </s-clickable>
        ))}
      </div>
    </s-section>
  );
}

function RuleDetail({ rule, findings, onBack, onFix, busy }) {
  const rows = findings.slice(0, MAX_ROWS);
  const hidden = findings.length - rows.length;
  return (
    <s-section heading={`${rule.label} (${rule.count})`}>
      <s-stack gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button variant="tertiary" onClick={onBack}>Back to all issues</s-button>
            <s-badge tone={TONE[rule.severity]}>{rule.severity}</s-badge>
          </s-stack>
          {rule.fixable ? (
            <s-button
              variant="primary"
              onClick={() => onFix(rule.ruleId)}
              disabled={busy || undefined}
            >
              {rule.fixLabel}
            </s-button>
          ) : null}
        </s-stack>
        <s-stack gap="small">
          {rows.map((f, i) => (
            <s-box
              key={`${f.productId}-${f.variantId || ""}-${i}`}
              padding="small"
              border="base"
              borderRadius="base"
            >
              <s-stack direction="inline" gap="base" justifyContent="space-between">
                <s-link href={adminUrl(f.productId)} target="_blank">
                  {f.productTitle}
                </s-link>
                {f.detail ? <s-text color="subdued">{f.detail}</s-text> : null}
              </s-stack>
            </s-box>
          ))}
          {hidden > 0 ? <s-text color="subdued">and {hidden} more</s-text> : null}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function Index() {
  const initial = useLoaderData();
  const fetcher = useFetcher();
  const loading = fetcher.state !== "idle";
  const data = fetcher.data;
  const result = data?.ok ? data.result : initial.result;
  const history = data?.ok ? data.history : initial.history;
  const fix = data?.ok ? data.fix : null;
  const [selected, setSelected] = useState(null);

  // If a fix clears every finding for the open rule, go back to the overview.
  useEffect(() => {
    if (result && selected && !result.rules.some((r) => r.ruleId === selected)) {
      setSelected(null);
    }
  }, [result, selected]);

  function runScan() {
    setSelected(null);
    fetcher.submit({ intent: "scan" }, { method: "post" });
  }

  function runFix(ruleId) {
    fetcher.submit({ intent: "fix", ruleId }, { method: "post" });
  }

  const rule = result && selected ? result.rules.find((r) => r.ruleId === selected) : null;

  return (
    <s-page heading="Catalog Lint">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={runScan}
        loading={loading || undefined}
      >
        {result ? "Scan again" : "Run scan"}
      </s-button>

      {data && !data.ok ? (
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>{data.error}</s-paragraph>
        </s-banner>
      ) : null}

      {fix && result ? <FixSummary fix={fix} rules={result.rules} /> : null}

      {!result && !loading ? (
        <s-section heading="Scan your catalog">
          <s-paragraph>
            Checks every product for missing images, descriptions, SKUs,
            weights, placeholder text, duplicate SKUs, and inconsistent vendor
            names. Nothing is changed until you choose a fix.
          </s-paragraph>
        </s-section>
      ) : null}

      {loading && !result ? (
        <s-section>
          <s-paragraph>Scanning. This takes a few seconds.</s-paragraph>
        </s-section>
      ) : null}

      {result ? (
        <>
          <ScoreBar result={result} history={history} />
          {rule ? (
            <RuleDetail
              rule={rule}
              findings={result.findings.filter((f) => f.ruleId === rule.ruleId)}
              onBack={() => setSelected(null)}
              onFix={runFix}
              busy={loading}
            />
          ) : (
            <Overview result={result} onSelect={setSelected} />
          )}
        </>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
