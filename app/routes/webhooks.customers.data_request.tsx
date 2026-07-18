import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.webhook(request);
  // La demande est authentifiée et accusée réception. L'export destiné au
  // marchand peut ensuite être produit depuis les tables LoyaltyCustomer,
  // LoyaltyOrder, Referral et Reward.
  return new Response(null, { status: 200 });
};
