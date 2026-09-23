import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useLoaderData } from "react-router";
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
import { currentPlan, PLAN_UNKNOWN } from "../lib/billing.server";
import { withShopLock } from "../lib/lock.server";
import { findingKey } from "../lib/validate.server";
import { planFor, areaLocked, allAreasPlan } from "../lib/plans";
import { categoryOf } from "../lib/categories";
import { shopInfo } from "../lib/shop.server";
import { adminUrl, truncate } from "../lib/format";
import { TONE, CategoryChip, Notices, passesWhen } from "../lib/ui";

// One check's findings: the products it flagged, each correctable in place, with Refresh to
// re-check them. Its own route, so the home page never carries every finding of every check.

export async function loader({ request, params }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, session.shop);
  const [result, settings, info] = await Promise.all([latestScan(session.shop), getSettings(session.shop), shopInfo(admin.graphql, session.shop)]);
  const rule = result?.rules.find((r) => r.ruleId === params.ruleId) || null;
  const known = RULE_CATALOG.find((r) => r.id === params.ruleId) || null;
  // A check in an area the plan does not cover has no page: Plans explains what covers it.
  const category = rule?.category || known?.category;
  if (category && areaLocked(plan, category)) throw redirect("/app/plans");
  const findings = rule ? result.findings.filter((f) => f.ruleId === rule.ruleId) : [];
  const label = rule?.label || known?.label || "Check";
  // Tracked metafields show as columns on every check.
  const tracked = (settings.trackedMetafields || []).map((t) => ({ key: t.fullKey, name: t.name }));
  return { rule, findings, plan, planUnknown, label, tracked, locale: info.locale };
}

// The browser names a finding by its key (rule, product, variant, word, field); everything else
// about it, above all the edit descriptor that says what to write where, comes from the stored scan.
const NOT_UNDERSTOOD = "That finding was not understood. Reload the page and try again.";
const NOT_LISTED = "That finding is no longer in the list. Refresh the list and try again.";
// Intents that write to Shopify run one at a time per shop, so a double click or a second tab
// cannot write twice.
const WRITES = new Set(["fix", "undo", "edit"]);

function parseKey(raw) {
  try {
    return raw ? findingKey(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function action({ request, params }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, session.shop);
  const form = await request.formData();
  const intent = form.get("intent");
  const ruleId = params.ruleId;
  const shop = session.shop;
  // Every intent here writes, gates on the plan, or re-reads the catalog: none runs on a plan
  // Shopify did not confirm.
  if (planUnknown) return { ok: false, error: PLAN_UNKNOWN };
  // Features the plan does not include are refused here as well as hidden in the page.
  const gate = { edit: ["inlineEdits", "Inline edits are"], learn: ["dictionary", "The spelling dictionary is"], ignore: ["ignores", "Ignoring findings is"] }[intent];
  if (gate && !plan.features[gate[0]]) {
    return { ok: false, error: `${gate[1]} part of the ${planFor(gate[0]).name} plan and up. Upgrade in Plans.` };
  }
  // Fixes, edits, ignores and refreshes in an area the plan does not cover are refused here as well.
  const category = RULE_CATALOG.find((r) => r.id === ruleId)?.category;
  if (["fix", "edit", "ignore", "refresh"].includes(intent) && category && areaLocked(plan, category)) {
    return { ok: false, error: `${categoryOf(category).label} findings are part of the ${allAreasPlan().name} plan. Compare plans to unlock them.` };
  }

  // The stored finding a key names, in the latest scan.
  const locate = async (key) => {
    const latest = await latestScan(shop);
    const wanted = ignoreKey(key);
    return (latest?.findings || []).find((f) => ignoreKey(f) === wanted) || null;
  };

  const run = async () => {
    let fix = null;
    let undo = null;
    let edit = null;
    let refresh = null;
    // What changed, so the stored scan can be refreshed without re-reading the catalog.
    let change = null;
    if (intent === "disableRule") {
      // Ignoring a whole check turns it off in Settings, where its switch shows unchecked, and
      // drops its findings. Turning the switch back on brings it back on the next scan.
      await ignoreCheck(admin.graphql, shop, ruleId, plan.productLimit);
      return { ok: true, disabledRule: ruleId };
    }
    if (intent === "fix") {
      const latest = await latestScan(shop);
      fix = { ruleId, ...(await applyFix(admin.graphql, shop, ruleId, latest?.findings || [])) };
      change = { kind: "products", ids: fix.productIds, ruleId };
    }
    if (intent === "undo") {
      undo = await undoFix(admin.graphql, shop, form.get("batchId"));
      // Undoing a saved row only clears its mark; undoing a bulk fix re-checks the products it changed.
      const key = parseKey(form.get("finding"));
      if (key) change = { kind: "unsaved", key: ignoreKey(key) };
      else if (undo.productIds.length) change = { kind: "products", ids: undo.productIds, full: true };
    }
    if (intent === "learn") {
      const word = String(form.get("word") || "").trim().slice(0, 100);
      if (!word) return { ok: false, error: NOT_UNDERSTOOD };
      await addWord(shop, word);
      change = { kind: "learn", word };
    }
    if (intent === "ignore") {
      const key = parseKey(form.get("finding"));
      if (!key) return { ok: false, error: NOT_UNDERSTOOD };
      const finding = (await locate(key)) || key;
      await addIgnore(shop, finding);
      change = { kind: "ignore", finding };
    }
    if (intent === "edit") {
      const key = parseKey(form.get("finding"));
      if (!key) return { ok: false, error: NOT_UNDERSTOOD };
      const finding = await locate(key);
      if (!finding?.edit) return { ok: false, error: NOT_LISTED };
      const quick = form.get("quick") === "1";
      let descriptor = finding.edit;
      let value = String(form.get("value") ?? "");
      if (descriptor.kind === "choice") {
        // A choice is an edit of its own; it borrows the row's rule, product and title for the log.
        const choice = descriptor.choices?.[Number(form.get("choice"))];
        if (!choice) return { ok: false, error: NOT_UNDERSTOOD };
        descriptor = { ...choice, ruleId: descriptor.ruleId, productId: descriptor.productId, title: descriptor.title };
        value = choice.value;
      } else if (quick) {
        value = String(descriptor.applyValue ?? descriptor.suggested ?? "");
      }
      edit = await applyEdit(admin.graphql, shop, descriptor, value, { quick });
      // The row stays, marked saved, so the change can be undone in place; Refresh re-checks it.
      change = edit.ok ? { kind: "saved", key: ignoreKey(key), batchId: edit.batchId, value, quick } : null;
    }
    if (intent === "refresh") {
      // Re-check every product this check lists (a full rescan on a small catalog).
      const latest = await latestScan(shop);
      const before = (latest?.findings || []).filter((f) => f.ruleId === ruleId);
      const ids = [...new Set(before.map((f) => f.productId))];
      if (ids.length) await refreshAfter(admin.graphql, shop, { kind: "products", ids, full: true }, plan.productLimit);
      const after = ((await latestScan(shop))?.findings || []).filter((f) => f.ruleId === ruleId).length;
      refresh = { ruleId, products: ids.length, before: before.length, after };
    }
    if (change) await refreshAfter(admin.graphql, shop, change, plan.productLimit);
    return { ok: true, fix, undo, edit, refresh };
  };

  try {
    return WRITES.has(intent) ? await withShopLock(shop, run) : await run();
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
// Below 600px the field takes the whole cell and the buttons go under it (see fixTracks), so a
// phone-width list item does not overflow.
const CORRECTED_TRACKS = {
  text: "@container (inline-size > 1100px) 320px, (inline-size > 900px) and (inline-size <= 1100px) 260px, (inline-size > 600px) and (inline-size <= 900px) 160px, 1fr",
  numeric: "@container (inline-size > 900px) 120px, (inline-size > 600px) and (inline-size <= 900px) 96px, 1fr",
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
// The Fix cell grid: the input track followed by one auto track per button. The input track is a
// responsive list, so the button tracks go on each of its alternatives except the last (the
// narrowest), where the cell is a single column and the buttons stack under the field.
function fixTracks(track, actionCount) {
  const actions = actionTracks(actionCount);
  const parts = track.split(",").map((part) => part.trim());
  return parts.map((part, i) => (i === parts.length - 1 ? part : `${part} ${actions}`)).join(", ");
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
  // The field starts with the suggestion, or with the stored value when the suggestion is only that.
  const [value, setValue] = useState(edit?.suggested ?? edit?.raw ?? "");
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
                onClick={() => onSave(f, edit.choices[choice].value, { quick: true, choice })}
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
                onClick={() => onSave(f, applyValue, { quick: true })}
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
                onClick={() => onSave(f, value, {})}
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
                View product
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

function Detail({ rule, findings, tracked, features, locale, onSave, onLearn, onIgnore, onUndo, busy }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? findings.filter((f) => f.productTitle.toLowerCase().includes(q) || (f.sku || "").toLowerCase().includes(q) || (f.detail || "").toLowerCase().includes(q))
    : findings;
  const rows = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - rows.length;
  const columns = detailColumns(findings, features);
  const help = !features.inlineEdits
    ? `View each product to fix it in Shopify. Inline edits are part of the ${planFor("inlineEdits").name} plan and up.`
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
            {rows.map((f) => (
              <FindingRow
                key={`${f.productId}-${f.variantId || ""}-${f.word || ""}-${f.field || ""}`}
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
      {/* A second way back under the list, for readers who scrolled past the breadcrumb. */}
      <s-box padding="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-link href="/app">Back to issues</s-link>
          {hidden > 0 ? (
            <s-text color="subdued">Showing {rows.length} of {filtered.length}. Use search to narrow down.</s-text>
          ) : rule.count > findings.length ? (
            // The stored list is capped per check; the count is not.
            <s-text color="subdued">Showing the first {findings.length.toLocaleString(locale)} of {rule.count.toLocaleString(locale)}. Fix some and scan again for the rest.</s-text>
          ) : null}
        </s-stack>
      </s-box>
    </s-section>
  );
}

// Nothing open for this check: every product passes it, or its findings were ignored or fixed.
function AllClear() {
  return (
    <s-section>
      <s-stack alignItems="center" gap="small" paddingBlock="large">
        <s-icon type="check-circle" tone="success" />
        <s-heading>Nothing open for this check</s-heading>
        <s-text color="subdued">Every product passes it, or its findings were fixed or ignored.</s-text>
        <s-link href="/app">Back to issues</s-link>
      </s-stack>
    </s-section>
  );
}

// ---------- page ----------

// What names a finding to the server (see ignoreKey): nothing else about it is sent.
const keyOf = (f) => ({ ruleId: f.ruleId, productId: f.productId, variantId: f.variantId || "", word: f.word || "", field: f.field || "" });

export default function IssuePage() {
  const { rule, findings, plan, planUnknown, label, tracked, locale } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  // One submission at a time: a second click before the busy state renders is ignored.
  const pending = useRef(false);
  useEffect(() => {
    if (fetcher.state === "idle") pending.current = false;
  }, [fetcher.state]);
  const submit = (payload) => {
    if (pending.current) return;
    pending.current = true;
    fetcher.submit(payload, { method: "post" });
  };
  const runFix = () => submit({ intent: "fix" });
  const runUndo = (batchId, finding) => submit(finding ? { intent: "undo", batchId, finding: JSON.stringify(keyOf(finding)) } : { intent: "undo", batchId });
  const learnWord = (word) => submit({ intent: "learn", word });
  const ignoreFinding = (f) => submit({ intent: "ignore", finding: JSON.stringify(keyOf(f)) });
  // The server looks the finding up and applies its own edit descriptor; the value travels for
  // typed corrections, the choice index for rows with alternatives.
  const saveEdit = (finding, value, { quick = false, choice } = {}) =>
    submit({ intent: "edit", finding: JSON.stringify(keyOf(finding)), value: value ?? "", quick: quick ? "1" : "0", choice: choice === undefined ? "" : String(choice) });
  const runRefresh = () => submit({ intent: "refresh" });
  const ignoreCheck = () => submit({ intent: "disableRule" });
  const refreshing = busy && fetcher.formData?.get("intent") === "refresh";
  const fixing = busy && fetcher.formData?.get("intent") === "fix";

  return (
    <s-page heading={label} inlineSize="large">
      {/* The breadcrumb is the standard way back; the button makes it obvious. */}
      <s-link slot="breadcrumb-actions" href="/app">Issues</s-link>
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
        <s-button slot="primary-action" variant="primary" onClick={runFix} loading={fixing || undefined} disabled={busy || undefined}>
          {rule.fixLabel}
        </s-button>
      ) : null}
      <Notices data={data} onUndo={runUndo} busy={busy} />
      {planUnknown ? (
        <s-banner tone="warning" heading="Could not confirm your plan">
          <s-paragraph>Shopify did not answer the plan check. The free plan features show for now; reload in a moment.</s-paragraph>
        </s-banner>
      ) : null}
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
          locale={locale}
          onSave={saveEdit}
          onLearn={learnWord}
          onIgnore={ignoreFinding}
          onUndo={runUndo}
          features={plan.features}
          busy={busy}
        />
      ) : (
        <AllClear />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
