-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('FIXED', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "RewardKind" AS ENUM ('MILESTONE', 'REFERRER', 'REFERRED');

-- CreateEnum
CREATE TYPE "RewardStatus" AS ENUM ('PENDING', 'ISSUED', 'EMAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('SIGNED_UP', 'QUALIFIED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramSettings" (
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "threshold" DECIMAL(65,30) NOT NULL DEFAULT 100,
    "rewardType" "RewardType" NOT NULL DEFAULT 'FIXED',
    "rewardValue" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "repeatRewards" BOOLEAN NOT NULL DEFAULT true,
    "validityDays" INTEGER NOT NULL DEFAULT 30,
    "combineOrderDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "combineProductDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "combineShippingDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "popupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "popupTitle" TEXT NOT NULL DEFAULT 'Votre fidélité récompensée',
    "popupText" TEXT NOT NULL DEFAULT 'Créez votre compte et recevez une récompense à chaque palier atteint.',
    "popupButtonLabel" TEXT NOT NULL DEFAULT 'Créer mon compte',
    "popupDelaySeconds" INTEGER NOT NULL DEFAULT 5,
    "referralEnabled" BOOLEAN NOT NULL DEFAULT true,
    "referralRewardType" "RewardType" NOT NULL DEFAULT 'FIXED',
    "referralAdvocateRewardValue" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "referralFriendRewardValue" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "customerSyncCursor" TEXT,
    "customerSyncCompletedAt" TIMESTAMP(3),
    "rewardEvaluationCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "LoyaltyCustomer" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "lifetimeSpend" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "customerId" TEXT NOT NULL,
    "eligibleAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
    "financialStatus" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'SIGNED_UP',
    "qualifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "RewardKind" NOT NULL,
    "milestone" INTEGER,
    "dedupeKey" TEXT NOT NULL,
    "rewardType" "RewardType" NOT NULL,
    "rewardValue" DECIMAL(65,30) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" "RewardStatus" NOT NULL DEFAULT 'PENDING',
    "discountCode" TEXT,
    "shopifyDiscountId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "emailProviderId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyCustomer_shop_shopifyCustomerId_key" ON "LoyaltyCustomer"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyCustomer_shop_referralCode_key" ON "LoyaltyCustomer"("shop", "referralCode");

-- CreateIndex
CREATE INDEX "LoyaltyCustomer_shop_email_idx" ON "LoyaltyCustomer"("shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyOrder_shop_shopifyOrderId_key" ON "LoyaltyOrder"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "LoyaltyOrder_shop_customerId_idx" ON "LoyaltyOrder"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");

-- CreateIndex
CREATE INDEX "Referral_shop_advocateId_idx" ON "Referral"("shop", "advocateId");

-- CreateIndex
CREATE UNIQUE INDEX "Reward_dedupeKey_key" ON "Reward"("dedupeKey");

-- CreateIndex
CREATE INDEX "Reward_shop_customerId_status_idx" ON "Reward"("shop", "customerId", "status");

-- AddForeignKey
ALTER TABLE "LoyaltyCustomer" ADD CONSTRAINT "LoyaltyCustomer_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "LoyaltyCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOrder" ADD CONSTRAINT "LoyaltyOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
