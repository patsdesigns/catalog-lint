import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listWords } from "../lib/dictionary.server";
import { getIgnores } from "../lib/ignores.server";
import { getSettings, saveSettings } from "../lib/settings.server";
import { ruleCatalog } from "../lib/rules.server";
import { trackMetafield, updateTracked, untrackMetafield, fetchDefinitions } from "../lib/metafields.server";
import { refreshAfter } from "../lib/rescan.server";
import { PASS_LABELS } from "../lib/checkLabels";
import { FAMILIES, TIERS } from "../lib/checkGroups";
import { currentPlan } from "../lib/billing.server";
import { getDigestSettings, saveDigestSettings, sendDigest } from "../lib/digest.server";
import { planFor } from "../lib/plans";

export async function loader({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const [words, ignores, settings, digest, definitions] = await Promise.all([
    listWords(session.shop),
    getIgnores(session.shop),
    getSettings(session.shop),
    getDigestSettings(session.shop),
    // The store's product metafield definitions, for the Tracked metafields dropdown.
    plan.features.customRules ? fetchDefinitions(admin.graphql).catch(() => []) : [],
  ]);
  // Only the count: the ignored findings have their own page (app.ignored.jsx). The checks list
  // includes the checks of the tracked metafields.
  return { words, ignoreCount: ignores.length, settings, rules: ruleCatalog(settings), plan, digest, tracked: settings.trackedMetafields, definitions };
}

export async function action({ request }) {
  const { admin, session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const allowed = plan.features;
  const form = await request.formData();
  const intent = form.get("intent");
  // Settings the plan does not include are refused here as well as hidden in the page. The
  // dictionary and the ignored findings have pages of their own (app.dictionary.jsx, app.ignored.jsx).
  if (intent === "saveDigest" || intent === "sendTestDigest") {
    if (!allowed.weeklyDigest) return { ok: false, error: `The weekly email is part of the ${planFor("weeklyDigest").name} plan and up.` };
    const email = String(form.get("email") || "").trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (intent === "saveDigest") {
      const enabled = form.get("enabled") === "true";
      if (enabled && !valid) return { ok: false, digest: "save", error: "Enter an email address to turn the weekly email on." };
      await saveDigestSettings(session.shop, { enabled, email });
      return { ok: true, digestSaved: true };
    }
    if (!valid) return { ok: false, digest: "test", error: "Enter an email address to send the test to." };
    try {
      await sendDigest(session.shop, email);
      return { ok: true, testSent: email };
    } catch (err) {
      // Reported inside the Weekly Email card, where the button is, not in the page banner.
      return { ok: false, digest: "test", error: err.message || String(err) };
    }
  }
  if (intent === "trackMetafield" || intent === "updateTracked" || intent === "untrackMetafield") {
    if (!allowed.customRules) return { ok: false, error: `Tracked metafields are part of the ${planFor("customRules").name} plan and up.` };
    try {
      if (intent === "trackMetafield") await trackMetafield(session.shop, { namespace: form.get("namespace"), key: form.get("key"), name: form.get("name"), type: form.get("type") });
      if (intent === "updateTracked") await updateTracked(session.shop, form.get("id"), { required: form.get("required") === "true", unique: form.get("unique") === "true", pattern: form.get("pattern"), productType: form.get("productType") });
      if (intent === "untrackMetafield") await untrackMetafield(session.shop, form.get("id"));
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
    // Checks that no longer exist (a metafield untracked, a setting turned off) lose their findings now.
    await refreshAfter(admin.graphql, session.shop, { kind: "settings" });
    return { ok: true };
  }
  if (intent === "saveSettings") {
    const current = await getSettings(session.shop);
    const next = { ...current };
    if (form.has("vendorWhitelist") && allowed.vendorWhitelist) {
      next.vendorWhitelist = String(form.get("vendorWhitelist")).split("\n").map((v) => v.trim()).filter(Boolean);
    }
    if (form.has("preset")) next.preset = form.get("preset");
    // Flipping any single check means the merchant has their own list.
    if (form.has("disabledRules")) {
      next.customDisabled = JSON.parse(form.get("disabledRules"));
      next.preset = "custom";
    }
    await saveSettings(session.shop, next);
    // Findings of checks that were just turned off disappear from the stored scan right away.
    if (form.has("preset") || form.has("disabledRules")) await refreshAfter(admin.graphql, session.shop, { kind: "settings" });
  }
  return { ok: true };
}

const FAMILY_COLUMNS = "@container (inline-size > 720px) 1fr 1fr, 1fr";

// One tracked metafield: its settings, saved together, and Remove.
function TrackedRow({ t, busy, onSave, onRemove }) {
  const [form, setForm] = useState({ required: t.required, unique: t.unique, pattern: t.pattern, productType: t.productType });
  const changed = form.required !== t.required || form.unique !== t.unique || form.pattern !== t.pattern || form.productType !== t.productType;
  const set = (patch) => setForm({ ...form, ...patch });
  return (
    <s-box padding="small" paddingInline="base" border="base" borderRadius="base">
      <s-stack gap="small">
        <s-stack gap="none">
          <s-text type="strong">{t.name}</s-text>
          <s-text color="subdued">{t.fullKey} · {t.type}</s-text>
        </s-stack>
        <s-switch label="Required" details="Flag products where it is empty." checked={form.required || undefined} onInput={(e) => set({ required: e.target.checked })}></s-switch>
        <s-switch label="Unique across products" details="Flag a value that more than one product has." checked={form.unique || undefined} onInput={(e) => set({ unique: e.target.checked })}></s-switch>
        <s-text-field label="Value pattern" details={"Optional. A regular expression the value must match, for example ^[A-Z]{3}-\\d{4}$."} placeholder="Any value" value={form.pattern} onInput={(e) => set({ pattern: e.target.value })}></s-text-field>
        <s-text-field label="Only for product type" details="Leave empty to check every product." placeholder="Wheels" value={form.productType} onInput={(e) => set({ productType: e.target.value })}></s-text-field>
        <s-stack direction="inline" gap="small">
          <s-button variant="primary" onClick={() => onSave(t.id, form)} disabled={!changed || busy || undefined}>Save</s-button>
          <s-button variant="tertiary" onClick={() => onRemove(t.id)} disabled={busy || undefined} accessibilityLabel={`Stop tracking ${t.name}`}>Remove</s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

// The Tracked metafields card: a dropdown of the store's product metafield definitions not yet
// tracked, and the tracked ones with their settings.
function TrackedMetafields({ tracked, definitions, busy, submit }) {
  const available = definitions.filter((d) => !tracked.some((t) => t.namespace === d.namespace && t.key === d.key));
  const [pick, setPick] = useState("");
  const chosen = available.find((d) => d.id === pick) || available[0] || null;
  const add = () => {
    if (!chosen) return;
    submit({ intent: "trackMetafield", namespace: chosen.namespace, key: chosen.key, name: chosen.name, type: chosen.type });
    setPick("");
  };
  return (
    <s-section slot="aside" heading={`Tracked Metafields (${tracked.length})`}>
      <s-stack gap="base">
        <s-paragraph>
          Product metafields read with every product and checked like any other field: missing, duplicated, misspelled, a
          placeholder, too long or with stray spaces. Each also shows as a column on every issue page.
        </s-paragraph>
        {available.length ? (
          <s-stack gap="small">
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
            <s-stack direction="inline" gap="small">
              <s-button variant="primary" onClick={add} disabled={busy || !chosen || undefined}>Add</s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-text color="subdued">
            {definitions.length ? "Every product metafield definition is tracked." : "No product metafield definitions yet. Create one in Shopify under Settings, Custom data, Products."}
          </s-text>
        )}
        {tracked.map((t) => (
          <TrackedRow
            key={t.id}
            t={t}
            busy={busy}
            onSave={(id, form) => submit({ intent: "updateTracked", id: String(id), required: String(form.required), unique: String(form.unique), pattern: form.pattern, productType: form.productType })}
            onRemove={(id) => submit({ intent: "untrackMetafield", id: String(id) })}
          />
        ))}
        {tracked.length === 0 ? <s-text color="subdued">Nothing tracked yet.</s-text> : null}
        {tracked.length ? <s-text color="subdued">A newly tracked metafield is read on the next scan.</s-text> : null}
      </s-stack>
    </s-section>
  );
}

// Stands in for a section the plan does not include. `what` names the feature with its verb.
function UpgradeSection({ heading, feature, what, slot }) {
  const plan = planFor(feature);
  return (
    <s-section slot={slot} heading={heading}>
      <s-paragraph>
        {what} part of the {plan.name} plan and up. <s-link href="/app/plans">Upgrade to {plan.name}</s-link>
      </s-paragraph>
    </s-section>
  );
}

export default function Settings() {
  const { words, ignoreCount, settings, rules: checks, plan, digest, tracked, definitions } = useLoaderData();
  const features = plan.features;
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  function submit(payload) {
    fetcher.submit(payload, { method: "post" });
  }

  // Which checks run. `off` is the set of disabled ids; kept locally so switches respond at once,
  // and every change is saved.
  const [off, setOff] = useState(() => new Set(settings.disabledRules || []));
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (r) => !q || r.label.toLowerCase().includes(q) || (r.passLabel || PASS_LABELS[r.id] || "").toLowerCase().includes(q);
  const visibleCount = checks.filter(matches).length;

  function saveOff(next) {
    setOff(next);
    submit({ intent: "saveSettings", disabledRules: JSON.stringify([...next]) });
  }
  function toggleCheck(id, on) {
    const next = new Set(off);
    if (on) next.delete(id);
    else next.add(id);
    saveOff(next);
  }
  function setMany(list, on) {
    const next = new Set(off);
    for (const r of list) if (on) next.delete(r.id); else next.add(r.id);
    saveOff(next);
  }
  function toggleExpanded(id) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }
  const runningCount = checks.length - off.size;

  const [whitelist, setWhitelist] = useState(settings.vendorWhitelist.join("\n"));
  const [digestEnabled, setDigestEnabled] = useState(digest.enabled);
  const [digestEmail, setDigestEmail] = useState(digest.email);

  function saveWhitelist() {
    submit({ intent: "saveSettings", vendorWhitelist: whitelist });
  }

  return (
    <s-page heading="Settings">
      {fetcher.data && !fetcher.data.ok && !fetcher.data.digest ? (
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-banner>
      ) : null}
      <s-section heading={`Checks (${runningCount} of ${checks.length} running)`}>
        <s-stack gap="large">
          <s-paragraph>
            Turn off any check you do not want. Turning a check off removes its findings right away; turning one back
            on takes effect on the next scan.
          </s-paragraph>

          <s-stack gap="small">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text type="strong">Checks by family</s-text>
            </s-stack>
            <s-search-field
              label="Filter checks"
              labelAccessibilityVisibility="exclusive"
              placeholder="Filter checks, for example barcode or alt text"
              value={query}
              onInput={(e) => setQuery(e.target.value)}
            ></s-search-field>
            {q && visibleCount === 0 ? <s-text color="subdued">{`No checks match "${query.trim()}".`}</s-text> : null}
            {FAMILIES.map((fam) => {
              const all = checks.filter((r) => r.family === fam.id);
              const list = all.filter(matches);
              if (!all.length || (q && !list.length)) return null;
              const onCount = all.filter((r) => !off.has(r.id)).length;
              const open = Boolean(q) || expanded.has(fam.id);
              return (
                <s-box key={fam.id} padding="small" paddingInline="base" border="base" borderRadius="base">
                  <s-stack gap="small">
                    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                      {/* The family switch is on when any of its checks run; turning it off turns them all off. */}
                      <s-switch
                        label={fam.label}
                        details={onCount === all.length ? `All ${all.length} on` : onCount === 0 ? `All ${all.length} off` : `${onCount} of ${all.length} on`}
                        checked={onCount > 0 || undefined}
                        onInput={(e) => setMany(all, e.target.checked)}
                      ></s-switch>
                      <s-button
                        variant="tertiary"
                        icon={open ? "chevron-up" : "chevron-down"}
                        onClick={() => toggleExpanded(fam.id)}
                        accessibilityLabel={`${open ? "Hide" : "Show"} the ${all.length} ${fam.label} checks`}
                      >
                        {open ? "Hide" : `Show ${all.length}`}
                      </s-button>
                    </s-stack>
                    {open ? (
                      // Two columns when the section is wide enough; each switch's details line is its tier and passing state.
                      <s-query-container>
                        <s-grid gridTemplateColumns={FAMILY_COLUMNS} gap="small">
                          {list.map((r) => (
                            <s-switch
                              key={r.id}
                              label={r.label}
                              details={`${TIERS[r.tier]?.label || "Recommended"} · ${r.passLabel || PASS_LABELS[r.id] || ""}`}
                              checked={!off.has(r.id) || undefined}
                              onInput={(e) => toggleCheck(r.id, e.target.checked)}
                            ></s-switch>
                          ))}
                        </s-grid>
                      </s-query-container>
                    ) : null}
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        </s-stack>
      </s-section>

      {features.vendorWhitelist ? (
      <s-section slot="aside" heading="Approved Vendors">
        <s-stack gap="base">
          <s-paragraph>
            One vendor per line. Leave empty to skip this check. Products whose vendor is not on this list get flagged under Organization.
          </s-paragraph>
          <s-text-area
            label="Vendors"
            labelAccessibilityVisibility="exclusive"
            rows={5}
            placeholder={"Porsche\nBosch\nBilstein"}
            value={whitelist}
            onInput={(e) => setWhitelist(e.target.value)}
          ></s-text-area>
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" onClick={saveWhitelist} disabled={busy || undefined}>Save vendors</s-button>
          </s-stack>
        </s-stack>
      </s-section>
      ) : (
        <UpgradeSection slot="aside" heading="Approved Vendors" feature="vendorWhitelist" what="Approved vendor lists are" />
      )}

      {features.customRules ? (
        <TrackedMetafields tracked={tracked} definitions={definitions} busy={busy} submit={submit} />
      ) : (
        <UpgradeSection slot="aside" heading="Tracked Metafields" feature="customRules" what="Tracked metafields are" />
      )}

      {features.dictionary ? (
      <s-section slot="aside" heading={`Dictionary (${words.length})`}>
        <s-stack gap="small">
          <s-paragraph>
            Words that are never flagged as misspellings: brand names, part codes and jargon. The list lives on its own
            page.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/dictionary">Manage dictionary</s-button>
          </s-stack>
        </s-stack>
      </s-section>
      ) : (
        <UpgradeSection slot="aside" heading="Dictionary" feature="dictionary" what="The spelling dictionary is" />
      )}

      {features.ignores ? (
      <s-section slot="aside" heading={`Ignored Findings (${ignoreCount})`}>
        <s-stack gap="small">
          <s-paragraph>
            Single findings hidden with Ignore on an issue page. They stay hidden until you restore them. The list lives
            on its own page.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/ignored">Manage ignored findings</s-button>
          </s-stack>
        </s-stack>
      </s-section>
      ) : (
        <UpgradeSection slot="aside" heading="Ignored Findings" feature="ignores" what="Ignoring findings is" />
      )}

      {features.weeklyDigest ? (
      <s-section slot="aside" heading="Weekly Email">
        <s-stack gap="base">
          <s-paragraph>
            A summary every week: potential problems, the change since last week and the five issues to start with.
          </s-paragraph>
          <s-switch label="Send the weekly email" checked={digestEnabled || undefined} onInput={(e) => setDigestEnabled(e.target.checked)}></s-switch>
          <s-text-field label="Email address" type="email" placeholder="you@example.com" value={digestEmail} onInput={(e) => setDigestEmail(e.target.value)}></s-text-field>
          <s-stack direction="inline" gap="small">
            <s-button variant="primary" onClick={() => submit({ intent: "saveDigest", enabled: String(digestEnabled), email: digestEmail })} disabled={busy || undefined}>
              Save
            </s-button>
            <s-button onClick={() => submit({ intent: "sendTestDigest", email: digestEmail })} disabled={busy || !digestEmail.trim() || undefined}>
              Send test email
            </s-button>
          </s-stack>
          {fetcher.data && !fetcher.data.ok && fetcher.data.digest ? (
            <s-banner tone="critical" heading={fetcher.data.digest === "test" ? "The test email was not sent" : "Not saved"}>
              <s-paragraph>{fetcher.data.error}</s-paragraph>
            </s-banner>
          ) : null}
          {fetcher.data?.ok && fetcher.data.testSent ? <s-text color="subdued">Test email sent to {fetcher.data.testSent}.</s-text> : null}
          {fetcher.data?.ok && fetcher.data.digestSaved ? <s-text color="subdued">Saved.</s-text> : null}
        </s-stack>
      </s-section>
      ) : (
        <UpgradeSection slot="aside" heading="Weekly Email" feature="weeklyDigest" what="The weekly email is" />
      )}

    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
