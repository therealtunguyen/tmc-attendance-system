-- CreateTable
CREATE TABLE "PrivacyNotice" (
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT NOT NULL,

    CONSTRAINT "PrivacyNotice_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "NoticeAck" (
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeAck_pkey" PRIMARY KEY ("userId","version")
);
