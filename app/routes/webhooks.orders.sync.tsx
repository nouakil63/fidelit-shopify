import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { syncOrderFromAdmin } from "../services/loyalty.server";

function orderGid(payload: Record<string, unknown>) {
  if (typeof payload.admin_graphql_api_id === "string") {
    return payload.admin_graphql_api_id;
  }
  if (typeof payload.order_id === "number" || typeof payload.order_id === "string") {
    return `gid://shopify/Order/${payload.order_id}`;
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  const id = orderGid(payload as Record<string, unknown>);

  // Les webhooks simulés par la CLI n'ont pas de session de boutique installée.
  if (!admin || !id) return new Response(null, { status: 200 });

  await syncOrderFromAdmin(admin, shop, id);
  return new Response(null, { status: 200 });
};
