-- Distinguish a reward actively being issued from one waiting to be retried.
ALTER TYPE "RewardStatus" ADD VALUE 'PROCESSING' BEFORE 'ISSUED';
