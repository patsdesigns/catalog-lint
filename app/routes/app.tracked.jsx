import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listTracked, trackMetafield, updateTrackedMany, untrackMetafield, fetchDefinitions, MAX_TRACKED } from "../lib/metafields.server";
import { refreshAfter } from "../lib/rescan.server";
import { currentPlan, PLAN_UNKNOWN } from "../lib/billing.server";
import { describeError } from "../lib/graphql.server";
import { planFor } from "../lib/plans";
import { PlanUnknown } from "../lib/ui";

// Tracked metafields: product metafield definitions read with every product and covered by the
// Required metafield missing and Metafield does not match pattern checks. Its own page, so the list
// and its settings do not crowd Settings.

export async function loader({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, admin.graphql, session.shop);
  if (planUnknown || !plan.features.customRules) return { tracked: [], definitions: [], definitionsError: null, plan, planUnknown, max: MAX_TRACKED };
  const tracked = await listTracked(session.shop);
  // The dropdown needs the store's definitions; when Shopify cannot answer, the page says so.
  let definitions = [];
  let definitionsError = null;
  try {
    definitions = await fetchDefinitions(admin.graphql);
  } catch (err) {
    definitionsError = err.message || String(err);
  }
  return { tracked, definitions, definitionsError, plan, planUnknown, max: MAX_TRACKED };
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, admin.graphql, session.shop);
  if (planUnknown) return { ok: false, error: PLAN_UNKNOWN };
  if (!plan.features.customRules) {
    return { ok: false, error: `Tracked metafields are part of the ${planFor("customRules").name} plan and up.` };
  }
  const form = await request.formData();
  const intent = form.get("intent");
  let name = "";
  try {
    if (intent === "track") {
      const t = await trackMetafield(session.shop, { namespace: form.get("namespace"), key: form.get("key"), name: form.get("name"), type: form.get("type") });
      name = t.name;
    }
    if (intent === "update") {
      let changes;
      try {
        changes = JSON.parse(String(form.get("changes") || "[]"));
      } catch {
        changes = null;
      }
      if (!Array.isArray(changes)) throw new Error("The changes were not understood. Reload the page and try again.");
      await updateTrackedMany(session.shop, changes);
    }
    if (intent === "untrack") await untrackMetafield(session.shop, form.get("id"));
    // Checks that no longer exist (a metafield untracked, a setting turned off) lose their findings now.
    await refreshAfter(admin.graphql, session.shop, { kind: "settings" });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  return { ok: true, done: intent, name };
}

const TWO_COLUMNS = "@container (inline-size <= 760px) 1fr, 1fr 1fr";
const ADD_COLUMNS = "@container (inline-size <= 560px) 1fr, 1fr auto";

const SAVE_BAR_ID = "tracked-metafields-save-bar";

function settingsOf(t) {
  return { required: t.required, pattern: t.pattern, productType: t.productType };
}
function differs(a, b) {
  return a.required !== b.required || a.pattern !== b.pattern || a.productType !== b.productType;
}

// One tracked metafield: its settings, kept by the page until the save bar saves them, and Remove.
function TrackedRow({ t, form, busy, removing, onChange, onRemove }) {
  const set = (patch) => onChange({ ...form, ...patch });
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small">
        <s-stack gap="none">
          <s-text type="strong">{t.name}</s-text>
          <s-text color="subdued">{t.fullKey} · {t.type}</s-text>
        </s-stack>
        <s-switch label="Required" details="Flag products where it is empty." checked={form.required || undefined} onInput={(e) => set({ required: e.target.checked })}></s-switch>
        <s-text-field
          label="Value pattern"
          details={"Optional. A regular expression the value must match, for example ^[A-Z]{3}-\\d{4}$."}
          placeholder="Any value"
          value={form.pattern}
          onInput={(e) => set({ pattern: e.target.value })}
        ></s-text-field>
        <s-text-field
          label="Only for product type"
          details="Leave empty to check every product."
          placeholder="Wheels"
          value={form.productType}
          onInput={(e) => set({ productType: e.target.value })}
        ></s-text-field>
        <s-stack direction="inline" gap="small">
          <s-button variant="tertiary" onClick={() => onRemove(t.id)} disabled={busy || undefined} loading={removing || undefined} accessibilityLabel={`Stop tracking ${t.name}`}>
            Remove
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export default function TrackedPage() {
  const { tracked, definitions, definitionsError, plan, planUnknown, max } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  // What is being saved right now, so the pressed button shows it.
  const active = busy ? fetcher.formData?.get("intent") : null;
  const activeId = busy ? fetcher.formData?.get("id") : null;
  const submit = (payload) => fetcher.submit(payload, { method: "post" });
  const available = definitions.filter((d) => !tracked.some((t) => t.namespace === d.namespace && t.key === d.key));
  const [pick, setPick] = useState("");
  // Unsaved settings by metafield id. Any change opens Shopify's save bar; Save sends every changed
  // row in one request and Discard puts them back.
  const [edits, setEdits] = useState({});
  // Discard redraws the rows: a Polaris text field keeps what was typed even when its value
  // attribute changes back, so the rows start over from the saved values instead.
  const [round, setRound] = useState(0);
  const changed = tracked.filter((t) => edits[t.id] && differs(edits[t.id], settingsOf(t)));
  const dirty = changed.length > 0;
  const saving = active === "update";
  const saveAll = () => {
    if (!dirty || busy) return;
    const changes = changed.map((t) => ({ id: t.id, ...edits[t.id] }));
    submit({ intent: "update", changes: JSON.stringify(changes) });
  };
  const discard = () => {
    setEdits({});
    setRound((r) => r + 1);
  };
  // A save that went through clears the edits: the reloaded rows hold the saved values.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.done === "update") setEdits({});
  }, [fetcher.state, fetcher.data]);
  const chosen = available.find((d) => d.id === pick) || available[0] || null;
  const add = () => {
    if (!chosen) return;
    submit({ intent: "track", namespace: chosen.namespace, key: chosen.key, name: chosen.name, type: chosen.type });
    setPick("");
  };

  if (planUnknown) return <PlanUnknown heading="Tracked metafields" />;
  if (!plan.features.customRules) {
    const needed = planFor("customRules");
    return (
      <s-page heading="Tracked metafields">
        <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
        <s-section heading="Not included in your plan">
          <s-paragraph>
            Tracked metafields are part of the {needed.name} plan and up. <s-link href="/app/plans">Upgrade to {needed.name}</s-link>
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Tracked metafields" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
      <SaveBar id={SAVE_BAR_ID} open={dirty}>
        <button variant="primary" onClick={saveAll} loading={saving ? "" : undefined} disabled={busy ? "" : undefined}>
          Save
        </button>
        <button onClick={discard} disabled={busy ? "" : undefined}>
          Discard
        </button>
      </SaveBar>
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      {outcome?.ok && outcome.done === "track" ? (
        <s-banner tone="success" heading={`Now tracking ${outcome.name}`}>
          <s-paragraph>Its values are read on the next scan; the Metafields checks cover it from then on.</s-paragraph>
        </s-banner>
      ) : null}
      {outcome?.ok && outcome.done === "update" ? (
        <s-banner tone="success" heading="Saved">
          <s-paragraph>The setting applies from the next scan; findings it no longer covers are gone now.</s-paragraph>
        </s-banner>
      ) : null}
      {outcome?.ok && outcome.done === "untrack" ? (
        <s-banner tone="success" heading="No longer tracked">
          <s-paragraph>Its findings are gone and its column leaves the issue pages on the next scan.</s-paragraph>
        </s-banner>
      ) : null}
      {definitionsError ? (
        <s-banner tone="warning" heading="Could not load the metafield definitions">
          <s-paragraph>{definitionsError} Reload the page to try again.</s-paragraph>
        </s-banner>
      ) : null}
      <s-section heading="Add a metafield">
        <s-stack gap="base">
          <s-paragraph>
            A tracked metafield is read with every product. Required metafield missing flags products where it is empty,
            and Metafield does not match pattern flags values that fail its pattern. It also shows as a column on every
            issue page. You can track up to {max}.
          </s-paragraph>
          {tracked.length >= max ? (
            <s-text color="subdued">The limit of {max} tracked metafields is reached. Remove one to add another.</s-text>
          ) : available.length ? (
            // The select beside the button, under it when the section is narrow (a phone).
            <s-query-container>
              <s-grid gridTemplateColumns={ADD_COLUMNS} gap="small" alignItems="end">
                <s-select
                  label="Product metafield"
                  value={chosen ? chosen.id : ""}
                  onInput={(e) => setPick(e.target.value)}
                  onChange={(e) => setPick(e.target.value)}
                >
                  {available.map((d) => (
                    <s-option key={d.id} value={d.id}>
                      {d.name} · {d.namespace}.{d.key} · {d.type}
                    </s-option>
                  ))}
                </s-select>
                <s-button variant="primary" onClick={add} disabled={busy || !chosen || undefined} loading={active === "track" || undefined}>
                  Add
                </s-button>
              </s-grid>
            </s-query-container>
          ) : (
            <s-text color="subdued">
              {definitions.length
                ? "Every product metafield definition is tracked."
                : "No product metafield definitions yet. Create one in Shopify under Settings > Custom data > Products."}
            </s-text>
          )}
        </s-stack>
      </s-section>
      <s-section heading={`Tracked (${tracked.length})`}>
        {tracked.length === 0 ? (
          <s-text color="subdued">Nothing tracked yet.</s-text>
        ) : (
          <s-query-container>
            <s-grid gridTemplateColumns={TWO_COLUMNS} gap="base">
              {tracked.map((t) => (
                <TrackedRow
                  key={`${t.id}-${round}`}
                  t={t}
                  form={edits[t.id] || settingsOf(t)}
                  busy={busy}
                  removing={active === "untrack" && activeId === String(t.id)}
                  onChange={(form) => setEdits((all) => ({ ...all, [t.id]: form }))}
                  onRemove={(id) => {
                    setEdits((all) => {
                      const rest = { ...all };
                      delete rest[id];
                      return rest;
                    });
                    submit({ intent: "untrack", id: String(id) });
                  }}
                />
              ))}
            </s-grid>
          </s-query-container>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
