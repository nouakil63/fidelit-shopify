export function createRewardDiscountCode(
  shopifyCustomerId: string,
  rewardId: string,
) {
  const customerSuffix =
    shopifyCustomerId.replace(/\D/g, "").slice(-5) || "VIP";
  const rewardSuffix = rewardId.replace(/[^a-zA-Z0-9]/g, "").slice(-10);
  return `FID-${customerSuffix}-${rewardSuffix.toUpperCase()}`;
}

export function isRewardRetryable(
  status: "PENDING" | "PROCESSING" | "ISSUED" | "EMAILED" | "FAILED",
  updatedAt: Date,
  staleBefore: Date,
) {
  return (
    status === "FAILED" ||
    status === "PENDING" ||
    (status === "PROCESSING" && updatedAt < staleBefore)
  );
}

export function isReferralEligible(shopifyLifetimeSpend: string) {
  const amount = Number(shopifyLifetimeSpend);
  return Number.isFinite(amount) && amount <= 0;
}

export function isOrderThresholdReached(
  orderAmount: string | number,
  threshold: string | number,
) {
  const amount = Number(orderAmount);
  const minimum = Number(threshold);
  return (
    Number.isFinite(amount) &&
    Number.isFinite(minimum) &&
    minimum > 0 &&
    amount >= minimum
  );
}
