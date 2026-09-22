import { redirect } from "react-router";

// The app root is Home. The admin sidebar opens the app at "/", so it goes straight to /app with
// the query string intact (shop, host, embedded); a request without a shop lands on the login page
// from there.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};
