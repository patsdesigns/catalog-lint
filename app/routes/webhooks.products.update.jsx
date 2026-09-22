import { productWebhook } from "../lib/events.server";

// products/update: re-check the product at once on Quick Clean and up, queue it on Dust Off.
export const action = ({ request }) => productWebhook(request, { created: false });
