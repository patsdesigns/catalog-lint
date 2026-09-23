import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listWords, removeWord, addWord } from "../lib/dictionary.server";
import { currentPlan, PLAN_UNKNOWN } from "../lib/billing.server";
import { describeError } from "../lib/graphql.server";
import { planFor } from "../lib/plans";
import { PlanUnknown } from "../lib/ui";

// The spelling dictionary: words the spelling check never flags. Its own page, so a long list does
// not crowd Settings.

export async function loader({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, session.shop);
  // The words are only sent to a plan that includes them.
  const words = !planUnknown && plan.features.dictionary ? await listWords(session.shop) : [];
  return { words, plan, planUnknown };
}

export async function action({ request }) {
  const { session, billing } = await authenticate.admin(request);
  const { plan, planUnknown } = await currentPlan(billing, session.shop);
  if (planUnknown) return { ok: false, error: PLAN_UNKNOWN };
  if (!plan.features.dictionary) {
    return { ok: false, error: `The spelling dictionary is part of the ${planFor("dictionary").name} plan and up.` };
  }
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "addWord") {
      const word = String(form.get("word") || "").trim().slice(0, 100);
      if (!word) return { ok: false, error: "Enter a word to add." };
      await addWord(session.shop, word);
    }
    if (intent === "removeWord") {
      const id = Number(form.get("id"));
      if (!Number.isInteger(id)) return { ok: false, error: "That word was not understood. Reload the page and try again." };
      await removeWord(session.shop, id);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

const MAX_ROWS = 200;

export default function DictionaryPage() {
  const { words, plan, planUnknown } = useLoaderData();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const outcome = fetcher.data;
  const [word, setWord] = useState("");
  const [query, setQuery] = useState("");
  const submit = (payload) => fetcher.submit(payload, { method: "post" });

  function add() {
    const clean = word.trim();
    if (!clean) return;
    submit({ intent: "addWord", word: clean });
    setWord("");
  }

  if (planUnknown) return <PlanUnknown heading="Dictionary" />;
  if (!plan.features.dictionary) {
    const needed = planFor("dictionary");
    return (
      <s-page heading="Dictionary">
        <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
        <s-section heading="Dictionary">
          <s-paragraph>
            The spelling dictionary is part of the {needed.name} plan and up. <s-link href="/app/plans">Upgrade to {needed.name}</s-link>
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = (q ? words.filter((w) => w.word.includes(q)) : words).slice(0, MAX_ROWS);

  return (
    <s-page heading="Dictionary">
      <s-link slot="breadcrumb-actions" href="/app/settings">Settings</s-link>
      {outcome && !outcome.ok ? (
        <s-banner tone="critical" heading="Not included in your plan">
          <s-paragraph>{outcome.error}</s-paragraph>
        </s-banner>
      ) : null}
      <s-section heading={`Words (${words.length})`}>
        <s-stack gap="base">
          <s-paragraph>
            Words here are never flagged as misspellings. Brand names, part codes and jargon belong here. Trust word on
            a spelling finding adds to this list too.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="end">
            <s-text-field
              label="Add a word"
              placeholder="e.g. turbo, ceramic, hoodie"
              value={word}
              onInput={(e) => setWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            ></s-text-field>
            <s-button variant="primary" onClick={add} disabled={busy || !word.trim() || undefined}>
              Add
            </s-button>
          </s-stack>
          {words.length > 20 ? (
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search words"
              value={query}
              onInput={(e) => setQuery(e.target.value)}
            ></s-search-field>
          ) : null}
          <s-stack direction="inline" gap="small">
            {shown.map((w) => (
              <s-box key={w.id} padding="small" border="base" borderRadius="base">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text>{w.word}</s-text>
                  <s-button
                    variant="tertiary"
                    onClick={() => submit({ intent: "removeWord", id: w.id })}
                    disabled={busy || undefined}
                    accessibilityLabel={`Remove ${w.word} from the dictionary`}
                  >
                    Remove
                  </s-button>
                </s-stack>
              </s-box>
            ))}
            {words.length === 0 ? <s-text color="subdued">No words yet.</s-text> : null}
            {words.length > 0 && shown.length === 0 ? <s-text color="subdued">No words match your search.</s-text> : null}
          </s-stack>
          {shown.length === MAX_ROWS && words.length > MAX_ROWS ? (
            <s-text color="subdued">Showing {MAX_ROWS} of {words.length}. Use search to narrow down.</s-text>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
