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
