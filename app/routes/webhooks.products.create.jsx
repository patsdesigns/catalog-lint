import { productWebhook } from "../lib/events.server";

// products/create: re-check the new product at once on Quick Clean and up, queue it on Dust Off.
export const action = ({ request }) => productWebhook(request, { created: true });
