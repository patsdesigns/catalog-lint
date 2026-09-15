import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { scanCatalog } from "../lib/scan.server";

export async function loader({ request }) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  try {
    const result = await scanCatalog(admin.graphql);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const TONE = { high: "critical", medium: "warning", low: "neutral" };
const MAX_ROWS_PER_RULE = 25;

function adminUrl(gid) {
  return `shopify://admin/products/${gid.split("/").pop()}`;
}

function ScoreCard({ result }) {
  const tone =
    result.score >= 90 ? "success" : result.score >= 70 ? "warning" : "critical";
  return (
    <s-section heading="Catalog health">
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-heading>{result.score} / 100</s-heading>
        <s-badge tone={tone}>
          {result.clean} of {result.total} products clean
        </s-badge>
        <s-text color="subdued">
          {result.findings.length} findings in {Math.round(result.durationMs / 100) / 10}s
        </s-text>
      </s-stack>
    </s-section>
  );
}

function RuleSection({ rule, findings }) {
  const rows = findings.slice(0, MAX_ROWS_PER_RULE);
  const hidden = findings.length - rows.length;

  return (
    <s-section heading={`${rule.label} (${rule.count})`}>
      <s-stack gap="small">
        <s-badge tone={TONE[rule.severity]}>{rule.severity}</s-badge>
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
        {hidden > 0 ? (
          <s-text color="subdued">and {hidden} more</s-text>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export default function Index() {
  const fetcher = useFetcher();
  const loading = fetcher.state !== "idle";
  const data = fetcher.data;
  const result = data?.ok ? data.result : null;

  function runScan() {
    fetcher.submit({}, { method: "post" });
  }

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
        <s-banner tone="critical" heading="Scan failed">
          <s-paragraph>{data.error}</s-paragraph>
        </s-banner>
      ) : null}

      {!result && !loading ? (
        <s-section heading="Scan your catalog">
          <s-paragraph>
            Checks every product for missing images, descriptions, SKUs,
            weights, placeholder text, duplicate SKUs, and inconsistent vendor
            names. Nothing is changed until you choose a fix.
          </s-paragraph>
        </s-section>
      ) : null}

      {loading ? (
        <s-section>
          <s-paragraph>Scanning products, this takes a few seconds per 500 products.</s-paragraph>
        </s-section>
      ) : null}

      {result ? (
        <>
          <ScoreCard result={result} />
          {result.rules.length === 0 ? (
            <s-section heading="All clear">
              <s-paragraph>No issues found. Your catalog is clean.</s-paragraph>
            </s-section>
          ) : (
            result.rules.map((rule) => (
              <RuleSection
                key={rule.ruleId}
                rule={rule}
                findings={result.findings.filter((f) => f.ruleId === rule.ruleId)}
              />
            ))
          )}
        </>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
