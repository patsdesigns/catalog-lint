import { useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listWords, removeWord, addWord } from "../lib/dictionary.server";
import { getIgnores, removeIgnore } from "../lib/ignores.server";
import { getSettings, saveSettings } from "../lib/settings.server";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const [words, ignores, settings] = await Promise.all([
    listWords(session.shop),
    getIgnores(session.shop),
    getSettings(session.shop),
  ]);
  return { words, ignores: ignores.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })), settings };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
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
    await saveSettings(session.shop, next);
  }
  return { ok: true };
}

export default function Settings() {
  const { words, ignores, settings } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const inputRef = useRef(null);

  function submit(payload) {
    fetcher.submit(payload, { method: "post" });
  }

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

      <s-section heading={`Dictionary (${words.length})`}>
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

      <s-section heading={`Ignored findings (${ignores.length})`}>
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
