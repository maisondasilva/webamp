import { db, knex } from "../db";
import path from "path";
import logger from "../logger";
import { searchIndex } from "../algolia";
import { DBSkinRecord, SkinRecord, DBIARecord, TweetStatus } from "../types";
import fetch from "node-fetch";
import { analyseBuffer, NsfwPrediction } from "../nsfwImage";

const SKIN_TYPE = {
  CLASSIC: 1,
  MODERN: 2,
  PACK: 3,
  INVALID: 4,
};

const skins_DEPRECATED = db.get("skins");
const iaItems = db.get("internetArchiveItems");

const CLASSIC_QUERY = {
  type: "CLASSIC",
};

const TWEETABLE_QUERY = {
  tweeted: { $ne: true },
  approved: true,
  rejected: { $ne: true },
  type: "CLASSIC",
};

const REVIEWABLE_QUERY = {
  tweeted: { $ne: true },
  approved: { $ne: true },
  rejected: { $ne: true },
  type: "CLASSIC",
};

function getFilenames(skin: DBSkinRecord): string[] {
  return skin.filePaths.map((p) => path.basename(p));
}

function getCanonicalFilename(skin: DBSkinRecord): string | null {
  const fileNames = getFilenames(skin);
  return fileNames[0] || null;
}

function getSkinUrl(skin: DBSkinRecord): string {
  return `https://s3.amazonaws.com/webamp-uploaded-skins/skins/${skin.md5}.wsz`;
}
function getScreenshotUrl(skin: DBSkinRecord): string {
  return `https://s3.amazonaws.com/webamp-uploaded-skins/screenshots/${skin.md5}.png`;
}

function getWebampUrl(skin: DBSkinRecord): string {
  return `https://webamp.org?skinUrl=${getSkinUrl(skin)}`;
}

export async function addSkin({ md5, filePath, uploader, averageColor }) {
  skins_DEPRECATED.insert({
    md5,
    type: "CLASSIC",
    filePaths: [filePath],
    uploader,
    averageColor,
  });
  await knex("skins").insert(
    {
      md5,
      skin_type: SKIN_TYPE.CLASSIC,
      average_color: averageColor,
    },
    []
  );
  await knex("files").insert(
    {
      skin_md5: md5,
      file_path: filePath,
      source_attribution: uploader,
    },
    []
  );
}

const IA_URL = /^(https:\/\/)?archive.org\/details\/([^\/]+)\/?/;
const MD5 = /([a-fA-F0-9]{32})/;

// TODO: SQLITE
export async function getMd5ByAnything(
  anything: string
): Promise<string | null> {
  const md5Match = anything.match(MD5);
  if (md5Match != null) {
    const md5 = md5Match[1];
    const found = await skins_DEPRECATED.findOne({ md5, type: "CLASSIC" });
    if (found != null) {
      return md5;
    }
  }
  const itemMatchResult = anything.match(IA_URL);
  if (itemMatchResult != null) {
    const itemName = itemMatchResult[2];
    const md5 = await getMd5FromInternetArchvieItemName(itemName);
    if (md5 != null) {
      return md5;
    }
  }
  return getMd5FromInternetArchvieItemName(anything);
}

// TODO: SQLITE
export async function getSkinByMd5(md5: string): Promise<SkinRecord | null> {
  const skin: DBSkinRecord | null = await skins_DEPRECATED.findOne({
    md5,
    type: "CLASSIC",
  });
  if (skin == null) {
    logger.warn("Could not find skin in database", { md5, alert: true });
    return null;
  }
  const internetArchiveItem = await getInternetArchiveItem(md5);
  let internetArchiveUrl: string | null = null;
  let internetArchiveItemName: string | null = null;
  if (internetArchiveItem != null) {
    internetArchiveItemName = internetArchiveItem.identifier;
    internetArchiveUrl = getInternetArchiveUrl(internetArchiveItemName);
  }
  const tweetStatus = await getStatus(md5);

  return {
    ...skin,
    tweetStatus,
    skinUrl: getSkinUrl(skin),
    screenshotUrl: getScreenshotUrl(skin),
    fileNames: getFilenames(skin),
    canonicalFilename: getCanonicalFilename(skin),
    webampUrl: getWebampUrl(skin),
    internetArchiveItemName,
    internetArchiveUrl,
  };
}

async function getInternetArchiveItem(md5: string): Promise<DBIARecord> {
  return iaItems.findOne({ md5: md5 });
}

async function getMd5FromInternetArchvieItemName(itemName: string) {
  const item = await iaItems.findOne({ identifier: itemName }, { md5: 1 });
  return item == null ? null : item.md5;
}

export async function getMissingNsfwPredictions() {
  const results = await skins_DEPRECATED.find(
    { nsfwPredictions: null, type: "CLASSIC" },
    { md5: 1 }
  );
  return results.map(({ md5 }) => md5);
}

export function getInternetArchiveUrl(itemName: string | null): string | null {
  return itemName == null ? null : `https://archive.org/details/${itemName}`;
}

export function getTweetableSkinCount(): Promise<number> {
  return skins_DEPRECATED.count(TWEETABLE_QUERY);
}

export async function getClassicSkinCount(): Promise<number> {
  const rows = await knex("skins")
    .where({ skin_type: 1 })
    .count({ count: "*" });
  const row = rows[0];
  if (row == null || row.count == null) {
    throw new Error("Could not find count row");
  }
  const { count } = row;
  if (count == null) {
    throw new Error("Could not find count");
  }
  return Number(count);
}

// TODO: Also pass id
export async function markAsTweeted(md5: string, url: string): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate({ md5 }, { $set: { tweeted: true } });
  await knex("tweets").insert({ skin_md5: md5, url }, []);
}

// TODO: Also path actor
export async function markAsNSFW(md5: string): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate({ md5 }, { $set: { nsfw: true } });
  const indexes = [{ objectID: md5, nsfw: true }];
  // TODO: Await here, but for some reason this never completes
  new Promise((resolve, reject) => {
    searchIndex.partialUpdateObjects(indexes, function (err, content) {
      if (err != null) reject(err);
      resolve(content);
    });
  });
  await knex("skin_reviews").insert({ skin_md5: md5, review: "NSFW" }, []);
}

export async function getStatus(md5: string): Promise<TweetStatus> {
  const tweeted = await knex("tweets").where({ skin_md5: md5 }).limit(1);
  if (tweeted.length > 0) {
    return "TWEETED";
  }
  const reviewRows = await knex("skin_reviews")
    .where({ skin_md5: md5 })
    .limit(1);
  const reviews = new Set(reviewRows.map((row) => row.review));
  if (reviews.has("REJECTED")) {
    return "REJECTED";
  }
  if (reviews.has("APPROVED")) {
    return "APPROVED";
  }

  return "UNREVIEWED";
}

// TODO: Also path actor
export async function approve(md5: string): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate(
    { md5 },
    { $set: { approved: true } }
  );
  await knex("skin_reviews").insert({ skin_md5: md5, review: "APPROVED" }, []);
}

// TODO: Also path actor
export async function reject(md5: string): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate(
    { md5 },
    { $set: { rejected: true } }
  );
  await knex("skin_reviews").insert({ skin_md5: md5, review: "REJECTED" }, []);
}

export async function getSkinToReview(): Promise<{
  filename: string | null;
  md5: string;
}> {
  const skins = await knex("skins")
    .leftJoin("skin_reviews", "skin_reviews.skin_md5", "=", "skins.md5")
    .leftJoin("tweets", "tweets.skin_md5", "=", "skins.md5")
    .innerJoin("files", "files.skin_md5", "=", "skins.md5")
    .select("skins.md5", "files.file_path")
    .where({ "skin_reviews.id": null, "tweets.id": null, "skins.skin_type": 1 })
    .orderByRaw("random()")
    .limit(1);
  if (!skins.length) {
    throw new Error("Could not find any skins to review");
  }
  const skin = skins[0];
  return { filename: path.basename(skin.file_path), md5: skin.md5 };
}

export async function getSkinToReviewForNsfw(): Promise<{
  filename: string | null;
  md5: string;
}> {
  // TODO: This will not surface skins which have already been reviewed for the bot but not for NSFW.
  const skins = await knex("skins")
    .leftJoin("nsfw_predictions", "nsfw_predictions.skin_md5", "=", "skins.md5")
    .leftJoin("skin_reviews", "skin_reviews.skin_md5", "=", "skins.md5")
    .innerJoin("files", "files.skin_md5", "=", "nsfw_predictions.skin_md5")
    .select("nsfw_predictions.skin_md5", "files.file_path")
    .where({ "skin_reviews.id": null, skin_type: 1 })
    .orderBy("nsfw_predictions.porn", "desc")
    .limit(1);
  if (!skins.length) {
    throw new Error("Could not find any skins to review");
  }
  const skin = skins[0];
  return { filename: path.basename(skin.file_path), md5: skin.skin_md5 };
}

export async function getSkinToTweet(): Promise<SkinRecord | null> {
  // TODO: This does not account for skins that have been both approved and rejected
  const tweetables = await knex("skins")
    .leftJoin("skin_reviews", "skin_reviews.skin_md5", "=", "skins.md5")
    .leftJoin("tweets", "tweets.skin_md5", "=", "skins.md5")
    .where({
      "tweets.id": null,
      skin_type: 1,
      "skin_reviews.review": "APPROVED",
    })
    .select("skins.md5")
    .orderByRaw("random()")
    .limit(1);
  const skin = tweetables[0];
  if (skin == null) {
    return null;
  }
  return getSkinByMd5(skin.md5);
}

export async function getStats(): Promise<{
  approved: number;
  rejected: number;
  tweeted: number;
  tweetable: number;
}> {
  const result = await knex.raw(
    `SELECT COUNT(DISTINCT skin_md5) AS "approved_count" FROM skin_reviews WHERE review = "APPROVED";`
  );
  console.log(result);
  const approved = await skins_DEPRECATED.count({ approved: true });
  const rejected = await skins_DEPRECATED.count({ rejected: true });
  const tweeted = await skins_DEPRECATED.count({ tweeted: true });
  const tweetable = await getTweetableSkinCount();
  return { approved, rejected, tweeted, tweetable };
}

export async function getRandomClassicSkinMd5(): Promise<string> {
  const random = await skins_DEPRECATED.aggregate([
    { $match: CLASSIC_QUERY },
    { $sample: { size: 1 } },
  ]);
  if (random.length === 0) {
    throw new Error("Could not find any classic skins");
  }
  return random[0].md5;
}

export async function getScreenshotBuffer(md5: string): Promise<Buffer> {
  const skin = await getSkinByMd5(md5);
  if (skin == null) {
    throw new Error(`Could not find skin with hash ${md5}`);
  }
  const screenshotResponse = await fetch(skin?.screenshotUrl);
  if (!screenshotResponse.ok) {
    throw new Error(`Could not get screenshot at ${skin?.screenshotUrl}`);
  }
  return screenshotResponse.buffer();
}

export async function setNsfwPredictions(
  md5: string,
  nsfwPredictions: NsfwPrediction
): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate(
    { md5 },
    { $set: { nsfwPredictions } }
  );
  await knex("nsfw_predictions").insert(
    { skin_md5: md5, ...nsfwPredictions },
    []
  );
}

export async function setTweetInfo(
  md5: string,
  likes: number,
  tweetId: string
): Promise<void> {
  await skins_DEPRECATED.findOneAndUpdate(
    { md5 },
    { $set: { twitterLikes: likes, tweetId } }
  );
  await knex("tweets")
    .where({ skin_md5: md5 })
    .update({ tweet_id: tweetId, likes }, []);
}

export async function computeAndSetNsfwPredictions(md5: string): Promise<void> {
  const image = await getScreenshotBuffer(md5);
  const predictions = await analyseBuffer(image);
  await setNsfwPredictions(md5, predictions);
}

export async function getMuseumPage({
  offset,
  first,
}: {
  offset: number;
  first: number;
}): Promise<
  Array<{ color: string; fileName: string; md5: string; nsfw: boolean }>
> {
  const reviewable = await skins_DEPRECATED.find(
    { type: "CLASSIC" },
    {
      limit: first,
      skip: offset,
      sort: { twitterLikes: -1, approved: -1, rejected: 1 },
      fields: { averageColor: 1, md5: 1, nsfw: 1 },
    }
  );

  return reviewable.map(({ md5, averageColor, nsfw }) => {
    return {
      color: averageColor,
      filename: "FILENAME",
      md5,
      nsfw,
    };
  });
}
