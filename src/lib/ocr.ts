import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createWorker } from "tesseract.js";
import { env } from "../app/config/env.config.js";

const LANGUAGES = ["ben", "eng"];
const require = createRequire(import.meta.url);

// The language data comes from npm packages rather than a download at run time, so OCR works without
// internet and can't fail because a website is busy. The library wants both in one folder.
const prepareLanguageData = async () => {
  const folder = path.resolve(env.MODEL_CACHE_DIR, "tesseract");
  await fs.mkdir(folder, { recursive: true });
  for (const language of LANGUAGES) {
    const source = path.join(path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`)), "4.0.0_best_int", `${language}.traineddata.gz`);
    await fs.copyFile(source, path.join(folder, `${language}.traineddata.gz`));
  }
  return folder;
};

// Reads Bangla and English from an image, on this machine.
export const readImageText = async (image: Buffer) => {
  const worker = await createWorker(LANGUAGES, 1, {
    langPath: await prepareLanguageData(),
    cacheMethod: "none",
    gzip: true,
    // Without this the library throws where nothing can catch it, which stops the whole worker process.
    // With it, a failure rejects as usual and only this job fails and retries.
    errorHandler: () => {},
  });
  try {
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
};
