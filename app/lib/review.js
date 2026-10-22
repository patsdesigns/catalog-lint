// Shopify's own review prompt (the App Bridge Reviews API), asked for at the end of a piece of work:
// a Fix all that fixed everything it touched, or an issue page with nothing left open after the
// merchant's fixes. Never when the app opens or in the middle of a list, per Shopify's guidance.
// Shopify decides whether the prompt shows: not in the first day after install, at most once in 60
// days and three times a year, not on mobile, and never once the store has reviewed the app.
// TidyUp adds no wording of its own and offers nothing for a review. Client-only: call it from an
// effect. It asks once per visit; Shopify's limits cover every visit after that.

let asked = false;

export function askForReview() {
  if (asked || typeof window === "undefined") return;
  asked = true;
  // A moment after the page shows the result, so the prompt never lands on the click itself.
  window.setTimeout(() => {
    try {
      Promise.resolve(window.shopify?.reviews?.request?.()).catch(() => {});
    } catch {
      // App Bridge missing or too old: there is no prompt, and nothing else changes.
    }
  }, 1500);
}
