import { ReferralStatus } from "@prisma/client";

import prisma from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { ensureReferralSignupRewards } from "../app/services/loyalty.server";

async function main() {
  const pending = await prisma.referral.findMany({
    where: { status: ReferralStatus.SIGNED_UP },
    include: { referred: true },
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  let friendCodes = 0;
  let advocateCodes = 0;

  for (const referral of pending) {
    const { admin } = await unauthenticated.admin(referral.shop);
    const result = await ensureReferralSignupRewards(
      admin,
      referral.shop,
      referral.referred,
    );
    processed += 1;
    if (result?.friendReward?.discountCode) friendCodes += 1;
    if (result?.advocateReward?.discountCode) advocateCodes += 1;
  }

  console.log(
    JSON.stringify(
      {
        pending: pending.length,
        processed,
        friendCodes,
        advocateCodes,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
