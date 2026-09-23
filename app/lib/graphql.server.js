// One door for every Admin API call. The client the library hands a route (admin.graphql) throws
// on a throttled answer (a GraphQL THROTTLED error, or HTTP 429 as a thrown Response) and never
// retries unless asked, so every caller here gets the same care: the request waits until the cost
// bucket can take it (Shopify refuses a query whose requested cost exceeds the points available),
// a throttled answer is retried with backoff, and an error reaches the merchant as a plain sentence.

const DEFAULT_TRIES = 3;
// Requested cost assumed for a request whose cost is not known yet: the catalog page query is the
// most expensive one the app sends.
const ASSUMED_COST = 800;
const MAX_WAIT_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The last known state of the cost bucket, per client (one client per request or webhook).
const buckets = new WeakMap();

function remember(graphql, cost) {
  const status = cost?.throttleStatus;
  if (!status) return;
  buckets.set(graphql, {
    available: Number(status.currentlyAvailable),
    restoreRate: Number(status.restoreRate) || 50,
    maximum: Number(status.maximumAvailable) || 1000,
    requested: Number(cost.requestedQueryCost) || ASSUMED_COST,
    at: Date.now(),
  });
}

// Waits until the bucket holds what the next request is likely to ask for.
async function pace(graphql) {
  const bucket = buckets.get(graphql);
  if (!bucket) return;
  const restored = Math.min(bucket.maximum, bucket.available + ((Date.now() - bucket.at) / 1000) * bucket.restoreRate);
  const needed = Math.min(bucket.maximum, Math.max(bucket.requested, ASSUMED_COST));
  if (restored >= needed) return;
  const ms = Math.min(MAX_WAIT_MS, Math.ceil(((needed - restored) / bucket.restoreRate) * 1000));
  await sleep(ms);
}

function graphQLErrors(err) {
  const list = err?.body?.errors?.graphQLErrors || err?.body?.errors;
  return Array.isArray(list) ? list : [];
}

// How long to wait before retrying, or null when the error is not a throttle.
function throttleWait(err, attempt) {
  const backoff = 1000 * attempt;
  if (err instanceof Response) return err.status === 429 || err.status === 503 ? backoff : null;
  if (err?.name === "HttpMaxRetriesError" || err?.response?.code === 429) return backoff;
  const throttled = graphQLErrors(err).some((e) => e?.extensions?.code === "THROTTLED");
  if (!throttled) return null;
  const status = err?.body?.extensions?.cost?.throttleStatus;
  const requested = Number(err?.body?.extensions?.cost?.requestedQueryCost) || ASSUMED_COST;
  if (status && Number(status.restoreRate) > 0) {
    const ms = Math.ceil(((requested - Number(status.currentlyAvailable)) / Number(status.restoreRate)) * 1000);
    return Math.min(MAX_WAIT_MS, Math.max(backoff, ms));
  }
  return backoff;
}

// The error as a sentence a merchant can read.
export function describeError(err) {
  if (err instanceof Response) {
    if (err.status === 429) return "Shopify is rate limiting the app right now. Try again in a moment.";
    return `Shopify answered ${err.status}${err.statusText ? ` ${err.statusText}` : ""}. Try again in a moment.`;
  }
  const messages = graphQLErrors(err).map((e) => (typeof e === "string" ? e : e?.message)).filter(Boolean);
  if (messages.length) return messages.join("; ");
  if (err?.name === "HttpMaxRetriesError") return "Shopify is rate limiting the app right now. Try again in a moment.";
  if (err?.name === "PrismaClientKnownRequestError" || err?.name === "PrismaClientValidationError") return "The app database could not save that. Try again.";
  if (err instanceof SyntaxError) return "The request was not understood. Reload the page and try again.";
  return err?.message || String(err);
}

// Runs one operation and returns its data. Throws an Error with a plain message when Shopify
// answers with errors, or when a throttle does not clear within `tries` attempts.
export async function request(graphql, query, variables, options = {}) {
  const tries = options.tries || DEFAULT_TRIES;
  for (let attempt = 1; ; attempt++) {
    await pace(graphql);
    try {
      const response = await graphql(query, { variables, tries });
      const body = await response.json();
      remember(graphql, body.extensions?.cost);
      // The installed client throws before a body with errors gets here; older or other clients may not.
      if (body.errors) {
        const list = Array.isArray(body.errors) ? body.errors : [body.errors];
        const err = new Error(list.map((e) => e?.message).filter(Boolean).join("; ") || "Shopify returned an error");
        err.body = { errors: { graphQLErrors: list }, extensions: body.extensions };
        throw err;
      }
      return body.data;
    } catch (err) {
      const wait = throttleWait(err, attempt);
      if (wait !== null && attempt < tries) {
        await sleep(wait);
        continue;
      }
      const friendly = new Error(describeError(err));
      friendly.cause = err;
      friendly.throttled = wait !== null;
      throw friendly;
    }
  }
}
