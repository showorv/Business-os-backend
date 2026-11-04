import { describe, expect, it } from "vitest";
import { extractText } from "../src/app/ai/extractText.js";

// Slow, and downloads the models on first use. Run with `npm run test:models`.
const run = process.env.RUN_MODEL_TESTS ? describe : describe.skip;

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

run("the real embedding model", () => {
  const PASSAGES = [
    "This lease agreement ends on 30 June 2027 and the monthly rent is BDT 30,000.",
    "The supplier must be paid within 45 days of the invoice date.",
    "বিদ্যুৎ বিল প্রতি মাসের ১৫ তারিখের মধ্যে পরিশোধ করতে হবে।",
    "Employees receive two festival bonuses each year.",
  ];

  // Each question should find its passage, including across languages.
  const CASES: [string, number][] = [
    ["বাড়ি ভাড়ার চুক্তি কবে শেষ হবে?", 0],
    ["সরবরাহকারীকে কত দিনের মধ্যে টাকা দিতে হবে?", 1],
    ["when must the electricity bill be paid?", 2],
    ["কর্মীরা কয়টি বোনাস পায়?", 3],
    ["When does the rent contract finish?", 0],
  ];

  it("gives vectors the size of the database column", async () => {
    const { embedQuery, EMBEDDING_DIMENSIONS } = await import("../src/lib/embeddings.js");
    expect(await embedQuery("hello")).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  for (const [question, expected] of CASES) {
    it(`"${question}" finds the right passage`, async () => {
      const { embedPassages, embedQuery } = await import("../src/lib/embeddings.js");
      const vectors = await embedPassages(PASSAGES);
      const query = await embedQuery(question);
      const scores = vectors.map((vector) => cosine(query, vector));
      expect(scores.indexOf(Math.max(...scores))).toBe(expected);
    });
  }
});

const renderToFile = async (html: string) => {
  const fs = await import("node:fs");
  const puppeteer = (await import("puppeteer")).default;
  const font = fs.readFileSync("node_modules/@fontsource/noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff2").toString("base64");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 320 });
  await page.setContent(`<style>@font-face{font-family:B;src:url(data:font/woff2;base64,${font})}body{font:28px B;margin:30px}</style>${html}`);
  await page.evaluateHandle("document.fonts.ready");
  const png = Buffer.from(await page.screenshot());
  const pdf = Buffer.from(await page.pdf({ format: "A4" }));
  await browser.close();
  return { png, pdf };
};

run("the real OCR", () => {
  const HTML = "<p>বাড়ি ভাড়ার চুক্তি ৩০ জুন ২০২৭ তারিখে শেষ হবে।</p><p>Invoice No: INV-2041</p>";

  it("reads Bangla and English from an image", async () => {
    const { png } = await renderToFile(HTML);
    const { pages } = await extractText(png, "image/png");
    expect(pages[0]!.text).toContain("চুক্তি");
    expect(pages[0]!.text).toContain("২০২৭");
    expect(pages[0]!.text).toContain("INV-2041");
  });

  it("a bad image fails that one job, without stopping the worker", async () => {
    const { readImageText } = await import("../src/lib/ocr.js");
    await expect(readImageText(Buffer.from("this is not an image"))).rejects.toBeDefined();
    // Still running, and still able to work.
    const { png } = await renderToFile("<p>Invoice No: INV-2041</p>");
    expect(await readImageText(png)).toContain("INV-2041");
  });

  it("reads a Bangla PDF correctly, where its stored text would be garbled", async () => {
    const { pdf } = await renderToFile(HTML);
    const { pages } = await extractText(pdf, "application/pdf");
    expect(pages[0]!.text).toContain("চুক্তি");
    expect(pages[0]!.text).toContain("INV-2041");
  });
});
