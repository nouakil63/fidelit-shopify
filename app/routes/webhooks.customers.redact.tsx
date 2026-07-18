import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);
  const raw = payload as {
    customer?: { id?: number | string };
  };
  const id = raw.customer?.id;

  if (id !== undefined) {
    await prisma.loyaltyCustomer.deleteMany({
      where: { shop, shopifyCustomerId: `gid://shopify/Customer/${id}` },
    });
  }

  return new Response(null, { status: 200 });
};
