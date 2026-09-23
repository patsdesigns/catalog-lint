import { Outlet, isRouteErrorResponse, useLoaderData, useRouteError, useRouteLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link rel="home" href="/app">Home</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plans">Plans</s-link>
        <s-link href="/app/support">Support</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in
// the response. Any other error keeps the app shell and says so in plain words; the details go to
// the server log, never to the page.
export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData("routes/app");
  if (isRouteErrorResponse(error)) return boundary.error(error);
  console.error("Unhandled error in the app:", error);
  return (
    <AppProvider embedded apiKey={data?.apiKey || ""}>
      <s-app-nav>
        <s-link rel="home" href="/app">Home</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plans">Plans</s-link>
        <s-link href="/app/support">Support</s-link>
      </s-app-nav>
      <s-page heading="TidyUp">
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>
            The page could not be loaded. Reload it in a moment; if it keeps happening, write to us from the Support page.
          </s-paragraph>
        </s-banner>
      </s-page>
    </AppProvider>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
