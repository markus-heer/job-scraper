-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('GLASSDOOR', 'JOBVECTOR', 'INDEED', 'STEPSTONE');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('LISTED', 'NO_LONGER_LISTED');

-- CreateEnum
CREATE TYPE "InterestFlag" AS ENUM ('UNMARKED', 'NOT_INTERESTING');

-- CreateEnum
CREATE TYPE "RelevanceVerdict" AS ENUM ('RELEVANT', 'NOT_RELEVANT', 'UNCERTAIN', 'NOT_ASSESSED');

-- CreateEnum
CREATE TYPE "PlatformStatus" AS ENUM ('COMPLETED', 'DISABLED', 'INCOMPLETE_CONFIGURATION', 'SIGN_IN_REQUIRED', 'PLATFORM_BLOCKED', 'PLATFORM_UNREACHABLE', 'PAGE_LAYOUT_UNKNOWN', 'PAGE_LIMIT_REACHED', 'FETCH_RATE_LIMITED', 'FAILED', 'EXCLUDED_BY_ROBOTS_TXT', 'ROBOTS_TXT_UNAVAILABLE', 'CANCELLED_BY_TIME_LIMIT', 'NOT_YET_RUN');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'FINISHED');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_TIME_LIMIT');

-- CreateEnum
CREATE TYPE "CommuteMode" AS ENUM ('BICYCLE', 'TRANSIT');

-- CreateEnum
CREATE TYPE "CommutePrecision" AS ENUM ('EXACT', 'IMPRECISE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "NormalizationSource" AS ENUM ('RULE_BASED', 'AI_PROVIDER');

-- CreateTable
CREATE TABLE "JobPosting" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "postingId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "employer" VARCHAR(150),
    "workLocation" VARCHAR(150),
    "publishedAt" TIMESTAMPTZ(3),
    "sourceUrl" TEXT NOT NULL,
    "descriptionText" VARCHAR(10000),
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "firstSeenRunId" TEXT NOT NULL,
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'LISTED',
    "interestFlag" "InterestFlag" NOT NULL DEFAULT 'UNMARKED',
    "relevanceVerdict" "RelevanceVerdict" NOT NULL DEFAULT 'NOT_ASSESSED',
    "relevanceReason" VARCHAR(300),
    "relevanceModel" TEXT,
    "relevanceAssessedAt" TIMESTAMPTZ(3),
    "relevanceSetManually" BOOLEAN NOT NULL DEFAULT false,
    "relevanceRank" INTEGER NOT NULL DEFAULT 2,
    "contentHash" TEXT NOT NULL,
    "relevanceContentHash" TEXT,
    "bicycleMinutes" INTEGER,
    "transitMinutes" INTEGER,
    "bestCommuteMinutes" INTEGER,
    "bestCommuteMode" "CommuteMode",
    "commutePrecision" "CommutePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "commuteLocationInput" TEXT,
    "commuteCheckedAt" TIMESTAMPTZ(3),

    CONSTRAINT "JobPosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "runOutcome" "RunOutcome",
    "closedByRecovery" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapeRunPlatformResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformStatus" "PlatformStatus" NOT NULL,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "newPostings" INTEGER NOT NULL DEFAULT 0,
    "updatedPostings" INTEGER NOT NULL DEFAULT 0,
    "partialResult" BOOLEAN NOT NULL DEFAULT false,
    "missingMandatoryFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveProfile" JSONB,

    CONSTRAINT "ScrapeRunPlatformResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogMessage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "platform" "Platform",
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "code" TEXT NOT NULL,
    "messageDe" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "LogMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommuteCacheEntry" (
    "id" TEXT NOT NULL,
    "homeAddress" TEXT NOT NULL,
    "lat" DECIMAL(9,4) NOT NULL,
    "lon" DECIMAL(9,4) NOT NULL,
    "mode" "CommuteMode" NOT NULL,
    "minutes" INTEGER,
    "precision" "CommutePrecision" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommuteCacheEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationNormalization" (
    "rawLocation" TEXT NOT NULL,
    "normalizedName" TEXT,
    "lat" DECIMAL(9,4),
    "lon" DECIMAL(9,4),
    "precision" "CommutePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "source" "NormalizationSource" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocationNormalization_pkey" PRIMARY KEY ("rawLocation")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "JobPosting_firstSeenAt_idx" ON "JobPosting"("firstSeenAt" DESC);

-- CreateIndex
CREATE INDEX "JobPosting_firstSeenRunId_idx" ON "JobPosting"("firstSeenRunId");

-- CreateIndex
CREATE INDEX "JobPosting_platform_postingStatus_idx" ON "JobPosting"("platform", "postingStatus");

-- CreateIndex
CREATE INDEX "JobPosting_postingStatus_interestFlag_relevanceVerdict_idx" ON "JobPosting"("postingStatus", "interestFlag", "relevanceVerdict");

-- CreateIndex
CREATE INDEX "JobPosting_bestCommuteMinutes_idx" ON "JobPosting"("bestCommuteMinutes");

-- CreateIndex
CREATE INDEX "JobPosting_publishedAt_idx" ON "JobPosting"("publishedAt");

-- CreateIndex
CREATE INDEX "JobPosting_relevanceRank_idx" ON "JobPosting"("relevanceRank");

-- CreateIndex
CREATE UNIQUE INDEX "JobPosting_platform_postingId_key" ON "JobPosting"("platform", "postingId");

-- CreateIndex
CREATE INDEX "ScrapeRun_status_idx" ON "ScrapeRun"("status");

-- CreateIndex
CREATE INDEX "ScrapeRun_runOutcome_finishedAt_idx" ON "ScrapeRun"("runOutcome", "finishedAt" DESC);

-- CreateIndex
CREATE INDEX "ScrapeRunPlatformResult_platform_idx" ON "ScrapeRunPlatformResult"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "ScrapeRunPlatformResult_runId_platform_key" ON "ScrapeRunPlatformResult"("runId", "platform");

-- CreateIndex
CREATE INDEX "LogMessage_runId_sequence_idx" ON "LogMessage"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "LogMessage_runId_sequence_key" ON "LogMessage"("runId", "sequence");

-- CreateIndex
CREATE INDEX "CommuteCacheEntry_expiresAt_idx" ON "CommuteCacheEntry"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommuteCacheEntry_homeAddress_lat_lon_mode_key" ON "CommuteCacheEntry"("homeAddress", "lat", "lon", "mode");

-- AddForeignKey
ALTER TABLE "JobPosting" ADD CONSTRAINT "JobPosting_firstSeenRunId_fkey" FOREIGN KEY ("firstSeenRunId") REFERENCES "ScrapeRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapeRunPlatformResult" ADD CONSTRAINT "ScrapeRunPlatformResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScrapeRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LogMessage" ADD CONSTRAINT "LogMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScrapeRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
