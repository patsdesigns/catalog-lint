import { login } from "../../shopify.server";

// The one page outside the admin, shown when someone opens the app's address directly. TidyUp is
// installed from the Shopify App Store (Shopify managed installation) and opened from the admin, so
// this page never asks for a store address: Shopify's review rules forbid that. A link that names
// the store with ?shop= still goes straight to the install. It renders no App Bridge and no Polaris
// (both belong to embedded pages), only plain HTML.

export const meta = () => [{ title: "TidyUp: Product Data Cleanup" }];

export const loader = async ({ request }) => {
  // Redirects to the install when the request names a valid store; otherwise there is nothing to do.
  await login(request);
  return null;
};

export default function Auth() {
  return (
    <main style={{ maxWidth: "480px", margin: "48px auto", padding: "0 16px", fontFamily: "Inter, system-ui, sans-serif", lineHeight: 1.5 }}>
      <h1>TidyUp: Product Data Cleanup</h1>
      <p>TidyUp runs inside your Shopify admin. To open it, go to Apps in your Shopify admin and choose TidyUp.</p>
      <p>
        Not installed yet? Find TidyUp in the <a href="https://apps.shopify.com">Shopify App Store</a>.
      </p>
    </main>
  );
}
