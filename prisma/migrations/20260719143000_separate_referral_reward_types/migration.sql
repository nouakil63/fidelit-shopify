ALTER TABLE "ProgramSettings"
ADD COLUMN "referralAdvocateRewardType" "RewardType" NOT NULL DEFAULT 'FIXED',
ADD COLUMN "referralFriendRewardType" "RewardType" NOT NULL DEFAULT 'FIXED';

UPDATE "ProgramSettings"
SET
  "referralAdvocateRewardType" = "referralRewardType",
  "referralFriendRewardType" = "referralRewardType";

ALTER TABLE "ProgramSettings"
DROP COLUMN "referralRewardType";
