import { RewardStatus } from "@prisma/client";

import prisma from "../app/db.server";
import { retryRewardEmail } from "../app/services/loyalty.server";

async function main() {
  const pending = await prisma.reward.findMany({
    where: {
      status: RewardStatus.ISSUED,
      emailedAt: null,
      discountCode: { not: null },
    },
    select: { id: true, shop: true },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  let sent = 0;
  const failures: string[] = [];
  for (const reward of pending) {
    const result = await retryRewardEmail(reward.shop, reward.id);
    if (result.sent) sent += 1;
    else failures.push(result.reason);
  }

  console.log(
    JSON.stringify(
      { pending: pending.length, sent, failed: failures.length, failures },
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
