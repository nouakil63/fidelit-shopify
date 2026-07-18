-- Record the instant from which purchases become eligible for loyalty rewards.
ALTER TABLE "ProgramSettings" ADD COLUMN "programStartedAt" TIMESTAMP(3);
