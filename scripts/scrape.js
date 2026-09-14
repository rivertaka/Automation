// Daily evidence scraper for https://restaurant.ikyu.com/102893
//
// Purpose: capture, every day, the "regular price" (struck-through) and the
// "current / time-sale price" for every plan of three specific courses, as
// both a screenshot (tamper-evidence) and structured text, so that a
// possible "double pricing" pattern (inflating the struck-through price on
// ikyu.com "point up" campaign days, without actually lowering the real
// price) can be proven or disproven over time.
//
// This script intentionally keeps the RAW extracted text for every plan
// alongside any best-effort parsed numbers, so nothing is silently lost if
// the regex parsing below turns out to be wrong for some future page
// layout. When in doubt, trust the screenshot + rawText over the parsed
// fields, and fix the parsing here (this repo's git history is exactly the
// kind of evidence trail we care about).
//
// Runs headless in GitHub Actions. Not runnable from the Anthropic Cowork
// sandbox (that environment's network policy blocks restaurant.ikyu.com).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'https://restaurant.ikyu.com/102893';

const COURSES = [
  { slug: 'benvenuto', label: 'Menu Benvenuto', variants: ['Menu Benvenuto', 'Benvenuto'] },
  { slug: 'anniversario', label: 'Anniversario（アニバーサリオ）', variants: ['Anniversario', 'アニバーサリオ', 'アニヴェルサリオ', 'アニバーサリー'] },
  { slug: 'norio', label: 'Menu NORIO', variants: ['Menu NORIO', 'NORIO'] },
];

const EXPAND_BUTTON_TEXTS = [
  'すべてのプランをみる', 'すべてのプランを見る', 'プラン一覧をみる', 'プラン一覧を見る',
  '全てのプランをみる', '全てのプランを見る', 'もっと見る', 'すべて見る', 'すべてみる',
];

const POINT_CAMPAIGN_HINTS = [
  'ポイントアップ', 'ポイント UP', 'ポイントUP', 'ポイント倍', '倍アップ', 'ポイント還元アップ',
];

function jstNow() {
  // Compute JST (UTC+9) wall-clock time regardless of runner timezone.
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const iso = jst.toISOString(); // e.g. 2026-09-15T02:00:00.000Z (but values are JST wall-clock)
  const date = iso.slice(0, 10);
  const capturedAt = `${iso.slice(0, 19)}+09:00`;
  return { date, capturedAt };
}

async function clickAllExpandButtons(page) {
  let clickedTotal = 0;
  for (let round = 0; round < 5; round++) {
    let clickedThisRound = 0;
    for (const text of EXPAND_BUTTON_TEXTS) {
      const locator = page.locator(`text=${text}`);
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        try {
          const el = locator.nth(i);
          if (await el.isVisible()) {
            await el.scrollIntoViewIfNeeded();
            await el.click({ timeout: 3000 });
            clickedThisRound++;
            clickedTotal++;
            await page.waitForTimeout(500);
          }
        } catch (e) {
          // ignore - button may have disappeared after a previous click
        }
      }
    }
    if (clickedThisRound === 0) break;
    await page.waitForTimeout(500);
  }
  return clickedTotal;
}

async function findCourseContainer(page, variants) {
  // Find a heading/text node matching one of the course name variants, then
  // walk up the DOM to find an ancestor big enough to be "the whole card"
  // (contains at least one yen/price-looking string and is reasonably tall).
  for (const variant of variants) {
    const heading = page.locator(`text=${variant}`).first();
    const exists = (await heading.count().catch(() => 0)) > 0;
    if (!exists) continue;

    const handle = await heading.elementHandle().catch(() => null);
    if (!handle) continue;

    // Walk up to 8 ancestors looking for a container that plausibly holds
    // the whole plan list (has multiple "円" occurrences and decent height).
    const containerHandle = await page.evaluateHandle((node) => {
      let el = node;
      let best = node;
      for (let i = 0; i < 10 && el; i++) {
        const text = el.innerText || '';
        const yenCount = (text.match(/円|¥/g) || []).length;
        const rect = el.getBoundingClientRect();
        if (yenCount >= 2 && rect.height > 200) {
          best = el;
        }
        el = el.parentElement;
      }
      return best;
    }, handle);

    const el = containerHandle.asElement();
    if (el) return el;
  }
  return null;
}

function extractPointCampaignBanners(fullText) {
  const found = [];
  for (const hint of POINT_CAMPAIGN_HINTS) {
    if (fullText.includes(hint)) {
      // Grab a short surrounding snippet for context.
      const idx = fullText.indexOf(hint);
      const snippet = fullText.slice(Math.max(0, idx - 20), idx + 40).replace(/\s+/g, ' ').trim();
      found.push(snippet);
    }
  }
  return found;
}

function parsePlansFromText(rawText) {
  // Best-effort structured parse. The page text inside a course card is
  // expected to look roughly like repeated blocks of:
  //   <plan name>
  //   ¥12,000 (or 12,000円)   <- regular (struck-through) price
  //   ¥10,800 (or 10,800円)  <- sale / current price
  //   10%OFF (or 10% OFF)
  //   200円分獲得/人 (or similar points line)
  // We don't know the exact real layout, so we scan line-by-line and group
  // consecutive price-looking lines, keeping full raw context per group.
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const priceRe = /(?:¥|￥)?\s*([\d,]{3,7})\s*(?:円)?/;
  const percentRe = /(\d{1,3})\s*%/;
  const pointsRe = /(\d{1,6})\s*円分.{0,6}(?:獲得|ポイント)|ポイント.{0,10}(\d{1,6})/;

  const blocks = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isPriceLine = priceRe.test(line) && /[\d]/.test(line) && line.length < 40;
    const looksLikePlanTitle = !isPriceLine && line.length >= 2 && line.length < 60 && !percentRe.test(line) && !pointsRe.test(line);

    if (looksLikePlanTitle) {
      if (current) blocks.push(current);
      current = { planTitleGuess: line, rawLines: [line] };
    } else if (current) {
      current.rawLines.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks.map((b) => {
    const text = b.rawLines.join(' | ');
    const prices = [];
    for (const l of b.rawLines) {
      const m = l.match(priceRe);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(n) && n >= 1000 && n <= 200000) prices.push(n);
      }
    }
    let discountPct = null;
    for (const l of b.rawLines) {
      const m = l.match(percentRe);
      if (m) { discountPct = parseInt(m[1], 10); break; }
    }
    let pointsText = null;
    for (const l of b.rawLines) {
      if (pointsRe.test(l)) { pointsText = l; break; }
    }
    return {
      planTitleGuess: b.planTitleGuess,
      regularPriceGuess: prices.length > 0 ? Math.max(...prices) : null,
      salePriceGuess: prices.length > 1 ? Math.min(...prices) : (prices.length === 1 ? prices[0] : null),
      discountPctGuess: discountPct,
      pointsTextGuess: pointsText,
      rawText: text,
    };
  }).filter((b) => b.rawText && b.rawText.length > 1);
}

async function main() {
  const { date, capturedAt } = jstNow();
  const outDir = path.join(__dirname, '..');
  const dataDir = path.join(outDir, 'data');
  const shotDir = path.join(outDir, 'screenshots', date);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
  const page = await context.newPage();

  const result = {
    date,
    capturedAt,
    sourceUrl: TARGET_URL,
    pointCampaignBanners: [],
    courses: [],
    errors: [],
  };

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    await clickAllExpandButtons(page).catch((e) => result.errors.push(`expand click error: ${e.message}`));

    // Full page screenshot always, as a fallback / overview shot.
    await page.screenshot({ path: path.join(shotDir, 'full_page.png'), fullPage: true }).catch(() => {});

    const bodyText = await page.locator('body').innerText().catch(() => '');
    result.pointCampaignBanners = extractPointCampaignBanners(bodyText);

    for (const course of COURSES) {
      const courseResult = { course: course.label, slug: course.slug, screenshot: null, plans: [], rawText: null, error: null };
      try {
        const el = await findCourseContainer(page, course.variants);
        if (!el) {
          courseResult.error = `Could not locate a container for course variants: ${course.variants.join(', ')}`;
          result.errors.push(courseResult.error);
        } else {
          const shotPath = path.join(shotDir, `${course.slug}.png`);
          await el.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await el.screenshot({ path: shotPath });
          courseResult.screenshot = `screenshots/${date}/${course.slug}.png`;

          const text = await el.innerText();
          courseResult.rawText = text;
          courseResult.plans = parsePlansFromText(text);
        }
      } catch (e) {
        courseResult.error = e.message;
        result.errors.push(`${course.slug}: ${e.message}`);
      }
      result.courses.push(courseResult);
    }
  } catch (e) {
    result.errors.push(`fatal: ${e.message}`);
    // Dump whatever we can for debugging even on fatal failure.
    try {
      await page.screenshot({ path: path.join(shotDir, 'fatal_error.png'), fullPage: true });
      fs.writeFileSync(path.join(shotDir, 'fatal_error.html'), await page.content());
    } catch (e2) {
      result.errors.push(`could not save debug artifacts: ${e2.message}`);
    }
  } finally {
    await browser.close();
  }

  const outFile = path.join(dataDir, `${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Wrote ${outFile}`);
  console.log(JSON.stringify({ date, errors: result.errors, courseCount: result.courses.length }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
