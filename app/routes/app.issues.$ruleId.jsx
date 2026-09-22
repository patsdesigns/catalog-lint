import { useState } from "react";
import { redirect, useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { refreshAfter } from "../lib/rescan.server";
import { applyFix, undoFix } from "../lib/fixes.server";
import { latestScan } from "../lib/scans.server";
import { addWord } from "../lib/dictionary.server";
import { addIgnore, ignoreKey } from "../lib/ignores.server";
import { applyEdit } from "../lib/edits.server";
import { ignoreCheck } from "../lib/checks.server";
import { RULE_CATALOG } from "../lib/rules.server";
import { getSettings } from "../lib/settings.server";
import { currentPlan } from "../lib/billing.server";
import { planFor, areaLocked, allAreasPlan } from "../lib/plans";
import { categoryOf } from "../lib/categories";
import { adminUrl, truncate } from "../lib/format";
import { TONE, CategoryChip, Notices, passesWhen } from "../lib/ui";

// One check's findings: the products it flagged, each correctable in place, with Refresh to
// re-check them. Its own route, so the home page never carries every finding of every check.

export async function loader({ request, params }) {
  const { session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const [result, settings] = await Promise.all([latestScan(session.shop), getSettings(session.shop)]);
  const rule = result?.rules.find((r) => r.ruleId === params.ruleId) || null;
  const known = RULE_CATALOG.find((r) => r.id === params.ruleId) || null;
  // A check in an area the plan does not cover has no page: Plans explains what covers it.
  const category = rule?.category || known?.category;
  if (category && areaLocked(plan, category)) throw redirect("/app/plans");
  const findings = rule ? result.findings.filter((f) => f.ruleId === rule.ruleId) : [];
  const label = rule?.label || known?.label || "Check";
  // Tracked metafields show as columns on every check.
  const tracked = (settings.trackedMetafields || []).map((t) => ({ key: t.fullKey, name: t.name }));
  return { rule, findings, plan, label, tracked };
}

export async function action({ request, params }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const form = await request.formData();
  const intent = form.get("intent");
  const ruleId = params.ruleId;
  // Features the plan does not include are refused here as well as hidden in the page.
  const gate = { edit: ["inlineEdits", "Inline edits are"], learn: ["dictionary", "The spelling dictionary is"], ignore: ["ignores", "Ignoring findings is"] }[intent];
  if (gate && !plan.features[gate[0]]) {
    return { ok: false, error: `${gate[1]} part of the ${planFor(gate[0]).name} plan and up. Upgrade in Plans.` };
  }
  // Fixes and edits in an area the plan does not cover are refused here as well.
  const category = RULE_CATALOG.find((r) => r.id === ruleId)?.category;
  if ((intent === "fix" || intent === "edit") && category && areaLocked(plan, category)) {
    return { ok: false, error: `${categoryOf(category).label} findings are part of the ${allAreasPlan().name} plan. Compare plans to unlock them.` };
  }

  try {
    let fix = null;
    let undo = null;
    let edit = null;
    let refresh = null;
    // What changed, so the stored scan can be refreshed without re-reading the catalog.
    let change = null;
    if (intent === "disableRule") {
      // Ignoring a whole check turns it off in Settings, where its switch shows unchecked, and
      // drops its findings. Turning the switch back on brings it back on the next scan.
      await ignoreCheck(admin.graphql, session.shop, ruleId, plan.productLimit);
      return { ok: true, disabledRule: ruleId };
    }
    if (intent === "fix") {
      const latest = await latestScan(session.shop);
      fix = { ruleId, ...(await applyFix(admin.graphql, session.shop, ruleId, latest?.findings || [])) };
      change = { kind: "products", ids: fix.productIds, ruleId };
    }
    if (intent === "undo") {
      undo = await undoFix(admin.graphql, session.shop, form.get("batchId"));
      // Undoing a saved row only clears its mark; undoing a bulk fix re-checks the products.
      const finding = form.get("finding") ? JSON.parse(form.get("finding")) : null;
      change = finding ? { kind: "unsaved", key: ignoreKey(finding) } : { kind: "products", ids: undo.productIds, full: true };
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
      change = edit.ok && finding ? { kind: "saved", key: ignoreKey(finding), batchId: edit.batchId, value: form.get("value"), quick: form.get("quick") === "1" } : null;
    }
    if (intent === "refresh") {
      // Re-check every product this check lists (a full rescan on a small catalog).
      const latest = await latestScan(session.shop);
      const before = (latest?.findings || []).filter((f) => f.ruleId === ruleId);
      const ids = [...new Set(before.map((f) => f.productId))];
      if (ids.length) await refreshAfter(admin.graphql, session.shop, { kind: "products", ids, full: true }, plan.productLimit);
      const after = ((await latestScan(session.shop))?.findings || []).filter((f) => f.ruleId === ruleId).length;
      refresh = { ruleId, products: ids.length, before: before.length, after };
    }
    if (change) await refreshAfter(admin.graphql, session.shop, change, plan.productLimit);
    return { ok: true, fix, undo, edit, refresh };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------- layout ----------

const MAX_ROWS = 100;

// Polaris sizes table columns from their content and a bare text field has almost no intrinsic
// width, so the correction field sits in a one-track grid whose track has a real width: wide enough
// for ~30 characters of text, narrower only for numeric values (a price or a weight). (Sizing props
// such as minInlineSize do not accept the @container syntax at runtime; grid tracks do.)
const CORRECTED_TRACKS = {
  text: "@container (inline-size > 1100px) 320px, (inline-size > 900px) and (inline-size <= 1100px) 260px, 160px",
  numeric: "@container (inline-size > 900px) 120px, 96px",
};
const NUMERIC_FIELDS = new Set(["price", "compareAt"]);
function isNumericEdit(e) {
  return e.kind === "weight" || e.kind === "cost" || e.kind === "inventory" || (e.kind === "variant" && NUMERIC_FIELDS.has(e.field));
}
// The Current value column keeps a track of its own so a value and its note wrap as a block.
const CURRENT_TRACK = "@container (inline-size > 1100px) 200px, (inline-size > 900px) and (inline-size <= 1100px) 160px, 140px";
// Row actions sit in one auto track each at every width: auto tracks never shrink, so the table
// cannot wrap a button mid-row; the flexible Product column yields instead.
function actionTracks(count) {
  return Array(count).fill("auto").join(" ");
}
// The Fix cell grid: the input track followed by one auto track per button, at every width. The
// input track is a responsive list, so the button tracks go on each of its alternatives.
function fixTracks(track, actionCount) {
  const actions = actionTracks(actionCount);
  return track.split(",").map((part) => `${part.trim()} ${actions}`).join(", ");
}

// Column plan for one rule. The SKU column exists once findings record SKUs (scans saved before
// that have none); the Fix column exists when some finding can be corrected here and the plan
// allows it, and its input track follows the values.
function detailColumns(findings, features) {
  const edits = findings.map((f) => f.edit).filter(Boolean);
  const numeric = edits.length > 0 && edits.every(isNumericEdit);
  return {
    sku: findings.some((f) => f.sku !== undefined || f.variantCount !== undefined),
    fix: features.inlineEdits && edits.length > 0,
    fixTrack: numeric ? CORRECTED_TRACKS.numeric : CORRECTED_TRACKS.text,
  };
}

// What a row is about right now: the edit's current value, or the finding's own current text, or
// its detail, with the detail as a note when it says more. Empty means the field really is empty.
function currentValue(f) {
  let detail = f.detail && f.detail !== f.productTitle ? f.detail : "";
  // Variant details start with the variant title, which the Product column already shows.
  if (f.variantTitle && detail.startsWith(f.variantTitle)) detail = detail.slice(f.variantTitle.length).replace(/^:\s*/, "");
  const source = f.edit ? f.edit.current : f.current;
  if (source === undefined || source === null) return { value: detail, note: "", empty: false };
  const raw = String(source);
  // A bare weight gets its unit; a weight that already names one keeps it.
  const unit = f.edit?.kind === "weight" && /^[\d.]+$/.test(raw) ? ` ${(f.edit.unit || "").toLowerCase()}` : "";
  const value = `${truncate(raw, f.edit?.multiline ? 80 : 60)}${unit}`;
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

// The controls of a row: an input when a value can be typed, Quick apply when a safe suggestion
// exists, a small select for rows with alternatives, or View Product when nothing can be edited
// here; then Trust word and Ignore when the plan includes them.
function FindingRow({ f, columns, tracked, features, onSave, onLearn, onIgnore, onUndo, busy }) {
  const edit = f.edit;
  const [value, setValue] = useState(edit?.suggested ?? "");
  const [choice, setChoice] = useState(0);
  const current = currentValue(f);
  const fieldLabel = `Corrected value for ${f.productTitle}`;
  const variant = f.variantTitle && f.variantTitle !== "Default Title" ? f.variantTitle : "";
  const canEdit = Boolean(edit) && features.inlineEdits;
  const isChoice = canEdit && edit.kind === "choice";
  const hasInput = canEdit && !isChoice && !edit.noInput;
  const applyValue = edit?.applyValue !== undefined ? edit.applyValue : edit?.suggested;
  const canApply = canEdit && !isChoice && Boolean(edit.apply) && applyValue !== undefined;
  const raw = String(edit?.raw ?? edit?.current ?? "");
  const canSave = hasInput && value.trim() !== "" && value !== raw;
  const viewOnly = !hasInput && !canApply && !isChoice;
  // Auto tracks after the input: the select and Apply, Quick apply, Save, or View Product, then
  // Trust word and Ignore when the plan includes them, and the upgrade link for a locked edit.
  const actions =
    (isChoice ? 2 : 0) + (canApply ? 1 : 0) + (hasInput ? 1 : 0) + (viewOnly ? 1 : 0) + (edit && !canEdit ? 1 : 0) + (f.word && features.dictionary ? 1 : 0) + (features.ignores ? 1 : 0);
  const currentCell = (
    <s-stack gap="small-500">
      {current.empty ? <s-text color="subdued">Empty</s-text> : current.value ? <s-text>{current.value}</s-text> : null}
      {current.note ? <s-text color="subdued">{truncate(current.note, 80)}</s-text> : null}
    </s-stack>
  );
  // A choice is an edit of its own; it borrows the row's rule, product and title for the log.
  const pick = (i) => ({ ...edit.choices[i], ruleId: edit.ruleId, productId: edit.productId, title: edit.title });

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
      {tracked.map((t) => (
        // The tracked metafields, so a merchant fixing one thing sees the others at a glance.
        <s-table-cell key={t.key}>
          {/* A track of its own, like the SKU, so a code does not wrap at its hyphens. */}
          <s-grid gridTemplateColumns="minmax(96px, max-content)">
            {f.meta?.[t.key] ? <s-text>{truncate(f.meta[t.key], 40)}</s-text> : <s-text color="subdued">Empty</s-text>}
          </s-grid>
        </s-table-cell>
      ))}
      <s-table-cell>
        <s-grid gridTemplateColumns={CURRENT_TRACK}>{currentCell}</s-grid>
      </s-table-cell>
      <s-table-cell>
        {f.saved ? (
          // Saved or applied from this page: the row stays so the change can be undone here; Refresh re-checks it.
          <s-stack gap="small-500">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type="check-circle" tone="success" />
              <s-text>{f.saved.quick ? "Applied" : "Saved"}</s-text>
              <s-button variant="tertiary" onClick={() => onUndo(f.saved.batchId, f)} disabled={busy || undefined} accessibilityLabel={`Undo the ${f.saved.quick ? "applied" : "saved"} change to ${f.productTitle}`}>
                Undo
              </s-button>
            </s-stack>
            {f.saved.value ? <s-text color="subdued">{truncate(f.saved.value, 60)}</s-text> : null}
          </s-stack>
        ) : (
          <s-grid gridTemplateColumns={hasInput ? fixTracks(columns.fixTrack, actions) : actionTracks(actions)} gap="small-200" alignItems="center" justifyContent="start">
            {edit && !canEdit ? (
              // The correction field is part of a paid plan; the row can still be fixed in Shopify.
              <s-link href="/app/plans">Upgrade to {planFor("inlineEdits").name}</s-link>
            ) : null}
            {hasInput ? (
              edit.multiline ? (
                <s-text-area
                  label={fieldLabel}
                  labelAccessibilityVisibility="exclusive"
                  rows={edit.field === "descriptionHtml" ? 5 : 2}
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
            {isChoice ? (
              <s-select
                label={`Fix for ${f.productTitle}`}
                labelAccessibilityVisibility="exclusive"
                value={String(choice)}
                onInput={(e) => setChoice(Number(e.target.value))}
                onChange={(e) => setChoice(Number(e.target.value))}
              >
                {edit.choices.map((c, i) => (
                  <s-option key={c.label} value={String(i)}>{c.label}</s-option>
                ))}
              </s-select>
            ) : null}
            {isChoice ? (
              <s-button
                variant="secondary"
                onClick={() => onSave(pick(choice), edit.choices[choice].value, f, true)}
                disabled={busy || undefined}
                accessibilityLabel={`Apply ${edit.choices[choice].label} to ${f.productTitle}`}
              >
                Apply
              </s-button>
            ) : null}
            {canApply ? (
              // Saves the suggestion as it is, in one click.
              <s-button
                variant="secondary"
                onClick={() => onSave(edit, applyValue, f, true)}
                disabled={busy || undefined}
                accessibilityLabel={`${edit.applyLabel || "Quick apply"} for ${f.productTitle}${applyValue ? `: ${applyValue}` : ""}`}
              >
                {edit.applyLabel || "Quick apply"}
              </s-button>
            ) : null}
            {hasInput ? (
              // Secondary, not primary: a row full of disabled primary buttons reads as broken, and
              // the page-level primary action stays the one primary button on the page.
              <s-button
                variant="secondary"
                onClick={() => onSave(edit, value, f, false)}
                disabled={!canSave || busy || undefined}
                accessibilityLabel={`${edit.kind === "word" ? "Replace the word for" : "Save corrected value for"} ${f.productTitle}`}
              >
                {edit.kind === "word" ? "Replace" : "Save"}
              </s-button>
            ) : null}
            {viewOnly ? (
              // A link styled as a tertiary button (s-button with href renders an anchor), so the
              // cluster keeps the same height and gap as rows that have a Save button.
              <s-button
                variant="tertiary"
                href={adminUrl(f.productId)}
                target="_blank"
                icon="external"
                accessibilityLabel={`View product: ${f.productTitle}, opens in Shopify admin in a new tab`}
              >
                View Product
              </s-button>
            ) : null}
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

function Detail({ rule, findings, tracked, features, onSave, onLearn, onIgnore, onUndo, onBack, busy }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? findings.filter((f) => f.productTitle.toLowerCase().includes(q) || (f.sku || "").toLowerCase().includes(q) || (f.detail || "").toLowerCase().includes(q))
    : findings;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;
  const columns = detailColumns(findings, features);
  const help = !features.inlineEdits
    ? `View each product to fix it in Shopify. Inline edits are part of the ${planFor("inlineEdits").name} plan.`
    : columns.fix
      ? "Check the current value, then Quick apply the suggestion, type a correction and save, or ignore what is intentional. Changes stay listed until you refresh."
      : "View each product to fix it in Shopify, or ignore what is intentional.";

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
            {tracked.map((t) => (
              <s-table-header key={t.key} listSlot="labeled">{t.name}</s-table-header>
            ))}
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
                tracked={tracked}
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

// Nothing open for this check: every product passes it, or its findings were ignored or fixed.
function AllClear({ onBack }) {
  return (
    <s-section>
      <s-stack alignItems="center" gap="small" paddingBlock="large">
        <s-icon type="check-circle" tone="success" />
        <s-heading>Nothing open for this check</s-heading>
        <s-text color="subdued">Every product passes it, or its findings were fixed or ignored.</s-text>
        <s-button variant="tertiary" icon="arrow-left" onClick={onBack}>Back to issues</s-button>
      </s-stack>
    </s-section>
  );
}

// ---------- page ----------

export default function IssuePage() {
  const { rule, findings, plan, label, tracked } = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  const submit = (payload) => fetcher.submit(payload, { method: "post" });
  const back = () => navigate("/app");
  const runFix = () => submit({ intent: "fix" });
  const runUndo = (batchId, finding) => submit(finding ? { intent: "undo", batchId, finding: JSON.stringify(finding) } : { intent: "undo", batchId });
  const learnWord = (word) => submit({ intent: "learn", word });
  const ignoreFinding = (f) => submit({ intent: "ignore", finding: JSON.stringify(f) });
  const saveEdit = (edit, value, finding, quick = false) => submit({ intent: "edit", edit: JSON.stringify(edit), value, finding: JSON.stringify(finding), quick: quick ? "1" : "0" });
  const runRefresh = () => submit({ intent: "refresh" });
  const ignoreCheck = () => submit({ intent: "disableRule" });
  const refreshing = busy && fetcher.formData?.get("intent") === "refresh";

  return (
    <s-page heading={label} inlineSize="large">
      {/* The breadcrumb is the standard way back; the button makes it obvious. */}
      <s-link slot="breadcrumb-actions" href="/app">Issues</s-link>
      <s-button slot="secondary-actions" onClick={back}>Back to issues</s-button>
      {rule ? (
        <s-button slot="secondary-actions" onClick={runRefresh} loading={refreshing || undefined} disabled={busy || undefined}>
          Refresh
        </s-button>
      ) : null}
      {rule ? (
        <s-button slot="secondary-actions" onClick={ignoreCheck} disabled={busy || undefined} accessibilityLabel={`Ignore this check: turn ${label} off in Settings`}>
          Ignore this check
        </s-button>
      ) : null}
      {rule?.fixable ? (
        <s-button slot="primary-action" variant="primary" onClick={runFix} disabled={busy || undefined}>
          {rule.fixLabel}
        </s-button>
      ) : null}
      <Notices data={data} onUndo={runUndo} busy={busy} />
      {data?.ok && data.disabledRule ? (
        <s-banner tone="success" heading="Check turned off">
          <s-paragraph>
            Its findings are gone and it stays off until you turn it back on in <s-link href="/app/settings">Settings</s-link>.
          </s-paragraph>
        </s-banner>
      ) : null}
      {rule ? (
        <Detail
          rule={rule}
          findings={findings}
          tracked={tracked || []}
          onSave={saveEdit}
          onLearn={learnWord}
          onIgnore={ignoreFinding}
          onBack={back}
          onUndo={runUndo}
          features={plan.features}
          busy={busy}
        />
      ) : (
        <AllClear onBack={back} />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
