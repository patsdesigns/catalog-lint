import { useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listWords, removeWord, addWord } from "../lib/dictionary.server";
import { getIgnores, removeIgnore } from "../lib/ignores.server";
import { getSettings, saveSettings } from "../lib/settings.server";
import { RULE_CATALOG } from "../lib/rules.server";
import { refreshAfter } from "../lib/rescan.server";
import { PASS_LABELS } from "../lib/checkLabels";
import { FAMILIES, TIERS, PRESETS, disabledForPreset } from "../lib/checkGroups";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const [words, ignores, settings] = await Promise.all([
    listWords(session.shop),
    getIgnores(session.shop),
    getSettings(session.shop),
  ]);
  return { words, ignores: ignores.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })), settings, rules: RULE_CATALOG };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "removeWord") await removeWord(session.shop, form.get("id"));
  if (intent === "addWord") await addWord(session.shop, form.get("word"));
  if (intent === "removeIgnore") await removeIgnore(session.shop, form.get("id"));
  if (intent === "saveSettings") {
    const current = await getSettings(session.shop);
    const next = { ...current };
    if (form.has("vendorWhitelist")) {
      next.vendorWhitelist = String(form.get("vendorWhitelist")).split("\n").map((v) => v.trim()).filter(Boolean);
    }
    if (form.has("metafieldRules")) next.metafieldRules = JSON.parse(form.get("metafieldRules"));
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

export default function Settings() {
  const { words, ignores, settings, rules: checks } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const inputRef = useRef(null);

  function submit(payload) {
    fetcher.submit(payload, { method: "post" });
  }

  // Which checks run. `off` is the effective set of disabled ids; kept locally so switches respond
  // at once, and every change is saved. Flipping one switch turns the preset into Custom.
  const [preset, setPreset] = useState(settings.preset);
  const [off, setOff] = useState(() => new Set(settings.disabledRules || []));
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (r) => !q || r.label.toLowerCase().includes(q) || (PASS_LABELS[r.id] || "").toLowerCase().includes(q);
  const visibleCount = checks.filter(matches).length;

  function choosePreset(id) {
    if (!id || id === preset) return;
    setPreset(id);
    if (id === "custom") {
      // Custom starts from whatever runs today, so nothing changes until a switch is flipped.
      submit({ intent: "saveSettings", preset: "custom", disabledRules: JSON.stringify([...off]) });
      return;
    }
    setOff(new Set(disabledForPreset(id)));
    submit({ intent: "saveSettings", preset: id });
  }
  function saveOff(next) {
    setOff(next);
    setPreset("custom");
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
  const presetCount = (id) => (id === "custom" ? runningCount : checks.length - disabledForPreset(id).length);

  const [whitelist, setWhitelist] = useState(settings.vendorWhitelist.join("\n"));
  const [rules, setRules] = useState(settings.metafieldRules);
  const [draft, setDraft] = useState({ key: "", productType: "", pattern: "" });

  function saveWhitelist() {
    submit({ intent: "saveSettings", vendorWhitelist: whitelist });
  }
  function saveRules(next) {
    setRules(next);
    submit({ intent: "saveSettings", metafieldRules: JSON.stringify(next) });
  }
  function addRule() {
    if (!draft.key.trim()) return;
    saveRules([...rules, { key: draft.key.trim(), productType: draft.productType.trim(), pattern: draft.pattern.trim() }]);
    setDraft({ key: "", productType: "", pattern: "" });
  }

  function handleAdd() {
    const input = inputRef.current;
    const word = (input?.value || "").trim();
    if (word) {
      submit({ intent: "addWord", word });
      input.value = "";
    }
  }

  return (
    <s-page heading="Settings">
      <s-section heading={`Checks (${runningCount} of ${checks.length} running)`}>
        <s-stack gap="large">
          <s-stack gap="small">
            <s-paragraph>
              Pick how much to check. Turning a check off removes its findings right away; turning one back on takes
              effect on the next scan.
            </s-paragraph>
            {/* Each choice's `selected` is a boolean attribute, so a false value is left off entirely. */}
            <s-choice-list label="Preset" labelAccessibilityVisibility="exclusive" onInput={(e) => choosePreset(e.target.values?.[0] ?? e.target.value)}>
              {PRESETS.map((p) => (
                <s-choice key={p.id} value={p.id} selected={p.id === preset || undefined} details={`${p.description} ${presetCount(p.id)} checks.`}>
                  {p.label}
                </s-choice>
              ))}
            </s-choice-list>
          </s-stack>

          <s-stack gap="small">
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text type="strong">Checks by family</s-text>
              {preset !== "custom" ? <s-text color="subdued">Flipping any switch turns the preset into Custom.</s-text> : null}
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
                              details={`${TIERS[r.tier]?.label || "Recommended"} · ${PASS_LABELS[r.id] || ""}`}
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

      <s-section heading="Approved vendors">
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

      <s-section heading={`Metafield rules (${rules.length})`}>
        <s-stack gap="base">
          <s-paragraph>
            Require a metafield, optionally only for one product type, and optionally check its value against a pattern.
            Key is namespace.key, for example custom.fitment. Pattern is a regular expression, for example ^\d{3}-\d{3}-\d{3}-\d{2}$.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field label="Metafield key" placeholder="custom.fitment" value={draft.key} onInput={(e) => setDraft({ ...draft, key: e.target.value })}></s-text-field>
            <s-text-field label="Only for product type" placeholder="optional" value={draft.productType} onInput={(e) => setDraft({ ...draft, productType: e.target.value })}></s-text-field>
            <s-text-field label="Pattern" placeholder="optional regex" value={draft.pattern} onInput={(e) => setDraft({ ...draft, pattern: e.target.value })}></s-text-field>
            <s-button variant="primary" onClick={addRule} disabled={busy || !draft.key.trim() || undefined}>Add rule</s-button>
          </s-stack>
          {rules.map((r, i) => (
            <s-box key={`${r.key}-${i}`} padding="small" border="base" borderRadius="base">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-text>
                  <strong>{r.key}</strong>
                  {r.productType ? ` for type "${r.productType}"` : " for all products"}
                  {r.pattern ? `, must match ${r.pattern}` : ""}
                </s-text>
                <s-button variant="tertiary" onClick={() => saveRules(rules.filter((_, j) => j !== i))} disabled={busy || undefined}>Remove</s-button>
              </s-stack>
            </s-box>
          ))}
          {rules.length === 0 ? <s-text color="subdued">No rules yet.</s-text> : null}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading={`Dictionary (${words.length})`}>
        <s-stack gap="base">
          <s-paragraph>
            Words here are never flagged as misspellings. Brand names, part codes, and
            jargon belong here.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field ref={inputRef} label="Add a word" placeholder="e.g. turbo, ceramic, hoodie"></s-text-field>
            <s-button variant="primary" onClick={handleAdd} disabled={busy || undefined}>Add</s-button>
          </s-stack>
          <s-stack direction="inline" gap="small">
            {words.map((w) => (
              <s-box key={w.id} padding="small" border="base" borderRadius="base">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text>{w.word}</s-text>
                  <s-button
                    variant="tertiary"
                    onClick={() => submit({ intent: "removeWord", id: w.id })}
                    disabled={busy || undefined}
                  >
                    Remove
                  </s-button>
                </s-stack>
              </s-box>
            ))}
            {words.length === 0 ? <s-text color="subdued">No words yet.</s-text> : null}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading={`Ignored findings (${ignores.length})`}>
        <s-stack gap="small">
          <s-paragraph>Findings you chose to ignore. Restore one to see it again on the next scan.</s-paragraph>
          {ignores.map((i) => (
            <s-box key={i.id} padding="small" border="base" borderRadius="base">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack gap="none">
                  <s-text>{i.title}</s-text>
                  <s-text color="subdued">{i.ruleId.replace(/_/g, " ")}{i.detail ? `, ${i.detail}` : ""}</s-text>
                </s-stack>
                <s-button
                  variant="tertiary"
                  onClick={() => submit({ intent: "removeIgnore", id: i.id })}
                  disabled={busy || undefined}
                >
                  Restore
                </s-button>
              </s-stack>
            </s-box>
          ))}
          {ignores.length === 0 ? <s-text color="subdued">Nothing ignored.</s-text> : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
