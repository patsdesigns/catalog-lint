import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

// The one page outside the admin: a shop domain form that starts the install. Merchants normally
// arrive from the App Store or the admin, which carry the shop, so this is rarely seen. It renders
// no App Bridge and no Polaris (both belong to embedded pages), only plain HTML.

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <main style={{ maxWidth: "420px", margin: "48px auto", padding: "0 16px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>Log in to TidyUp</h1>
      <p>Enter your store domain to open the app in your Shopify admin.</p>
      <Form method="post">
        <label htmlFor="shop">Shop domain</label>
        <div>
          <input
            id="shop"
            name="shop"
            type="text"
            value={shop}
            onChange={(e) => setShop(e.currentTarget.value)}
            autoComplete="on"
            placeholder="example.myshopify.com"
            aria-describedby={errors.shop ? "shop-error" : undefined}
            aria-invalid={errors.shop ? "true" : undefined}
          />
        </div>
        {errors.shop ? (
          <p id="shop-error" role="alert">
            {errors.shop}
          </p>
        ) : null}
        <button type="submit">Log in</button>
      </Form>
    </main>
  );
}
