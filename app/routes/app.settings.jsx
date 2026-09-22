import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listWords } from "../lib/dictionary.server";
import { getIgnores } from "../lib/ignores.server";
import { getSettings, saveSettings } from "../lib/settings.server";
import { ruleCatalog } from "../lib/rules.server";
import { refreshAfter } from "../lib/rescan.server";
import { PASS_LABELS } from "../lib/checkLabels";
import { FAMILIES, TIERS } from "../lib/checkGroups";
import { currentPlan } from "../lib/billing.server";
import { getDigestSettings, saveDigestSettings, sendDigest } from "../lib/digest.server";
import { planFor } from "../lib/plans";

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const { plan } = await currentPlan(billing);
  const [words, ignores, settings, digest] = await Promise.all([
    listWords(session.shop),
    getIgnores(session.shop),
    getSettings(session.shop),
    getDigestSettings(session.shop),
  ]);
  // Only counts: the ignored findings and the tracked metafields have pages of their own
  // (app.ignored.jsx, app.tracked.jsx). The checks list includes the checks of the tracked metafields.
  return { words, ignoreCount: ignores.length, trackedCount: settings.trackedMetafields.length, settings, rules: ruleCatalog(settings), plan, digest };
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
  const { words, ignoreCount, trackedCount, settings, rules: checks, plan, digest } = useLoaderData();
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
      <s-section slot="aside" heading={`Tracked Metafields (${trackedCount})`}>
        <s-stack gap="small">
          <s-paragraph>
            Product metafields read with every product and checked like any other field, with a column on every issue
            page. The list lives on its own page.
          </s-paragraph>
          <s-stack direction="inline" gap="small">
            <s-button href="/app/tracked">Manage tracked metafields</s-button>
          </s-stack>
        </s-stack>
      </s-section>
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
