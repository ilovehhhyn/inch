// Renders the Margin film page to an H.264 MP4 by seeking its timeline frame by frame.
// Usage: node render-film.mjs <page.html> <out.mp4>
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import puppeteer from "puppeteer-core";

const FRAMES_PER_SECOND = 30;
const WIDTH_PX = 1920;
const HEIGHT_PX = 1080;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LOAD_TIMEOUT_MS = 60 * 1000;

const [pagePath, outputPath] = process.argv.slice(2);
if (pagePath === undefined || outputPath === undefined) {
  throw new Error("usage: node render-film.mjs <page.html> <out.mp4>");
}

const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH_PX, height: HEIGHT_PX, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href, { waitUntil: "networkidle0", timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction("window.marginFilm !== undefined", { timeout: LOAD_TIMEOUT_MS });
  // Show only the film stage, unscaled, filling the 1920x1080 viewport.
  await page.addStyleTag({ content: `
    .wrap > *:not(.player), .controls { display: none !important; }
    .viewport { position: fixed !important; inset: 0 !important; width: ${WIDTH_PX}px !important; height: ${HEIGHT_PX}px !important; border-radius: 0 !important; z-index: 99; }
    .input .caret { animation: none !important; }` });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const durationSeconds = await page.evaluate(() => window.marginFilm.duration());
  const frameCount = Math.ceil(durationSeconds * FRAMES_PER_SECOND);

  const encoder = spawn(ffmpegPath, [
    "-y", "-f", "image2pipe", "-framerate", String(FRAMES_PER_SECOND), "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
    "-movflags", "+faststart", outputPath,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const encoded = new Promise((resolve, reject) => {
    encoder.on("error", reject);
    encoder.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });

  for (let index = 0; index < frameCount; index += 1) {
    await page.evaluate((seconds) => window.marginFilm.seek(seconds), index / FRAMES_PER_SECOND);
    const frame = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: WIDTH_PX, height: HEIGHT_PX } });
    if (!encoder.stdin.write(frame)) await new Promise((resolve) => encoder.stdin.once("drain", resolve));
    if (index % 150 === 0) console.log(`frame ${index} / ${frameCount}`);
  }
  encoder.stdin.end();
  await encoded;
  console.log(`wrote ${frameCount} frames (${durationSeconds.toFixed(2)} s) to ${outputPath}`);
} finally {
  await browser.close();
}
