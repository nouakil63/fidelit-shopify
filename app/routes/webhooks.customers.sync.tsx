import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { syncCustomerFromAdmin } from "../services/loyalty.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop } = await authenticate.webhook(request);
  const raw = payload as Record<string, unknown>;
  const customerId =
    typeof raw.admin_graphql_api_id === "string"
      ? raw.admin_graphql_api_id
      : typeof raw.id === "number" || typeof raw.id === "string"
        ? `gid://shopify/Customer/${raw.id}`
        : null;

  if (!admin || !customerId) return new Response(null, { status: 200 });
  await syncCustomerFromAdmin(admin, shop, customerId);
  return new Response(null, { status: 200 });
};
