import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  await prisma.$transaction([
    prisma.reward.deleteMany({ where: { shop } }),
    prisma.referral.deleteMany({ where: { shop } }),
    prisma.loyaltyOrder.deleteMany({ where: { shop } }),
    prisma.loyaltyCustomer.deleteMany({ where: { shop } }),
    prisma.programSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);

  return new Response(null, { status: 200 });
};
