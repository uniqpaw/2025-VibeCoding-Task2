/**
 * 綜合檢查（HTML/SEO + 水平捲動）
 * - 所有檢查項目必須通過，否則 CI fail（exit code 1）
 * - 會把結果寫進 $GITHUB_STEP_SUMMARY（Checks -> Summary）
 * - 自動在 PR 上留言顯示檢查結果
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

// 1) 找 index.html（支援根目錄或 docs/）
const CANDIDATES = ["index.html", "docs/index.html"];
const htmlFile = CANDIDATES.find(p => fs.existsSync(path.join(process.cwd(), p)));

if (!htmlFile) {
  output({
    results: [],
    score: 0,
    note: "找不到 index.html 或 docs/index.html"
  });
  process.exit(1);
}

const raw = fs.readFileSync(htmlFile, "utf8");

// 檢查檔案是否為空
if (!raw.trim()) {
  output({
    results: [],
    score: 0,
    note: "HTML 檔案為空"
  });
  process.exit(1);
}

const $ = cheerio.load(raw);

// 2) 規則（HTML/SEO）
const rules = [
  {
    label: "基本結構 `<html><head><body>`",
    check: () => {
      // 檢查原始碼中是否真的存在這些標籤，不依賴 Cheerio 自動補全
      const hasHtml = /<html\b[^>]*>/i.test(raw);
      const hasHead = /<head\b[^>]*>/i.test(raw);
      const hasBody = /<body\b[^>]*>/i.test(raw);
      return hasHtml && hasHead && hasBody;
    }
  },
  { label: "`<html lang>`", check: () => $("html").attr("lang") },
  {
    label: "`<meta charset=\"UTF-8\">`",
    check: () => {
      const charset = $("meta[charset]").attr("charset");
      return charset && charset.toUpperCase() === "UTF-8";
    }
  },
  { label: "`<title>` 非空", check: () => $("title").text().trim().length > 0 },
  {
    label: "`<meta name=description>` 50~160",
    check: () => {
      const d = $('meta[name="description"]').attr("content");
      return d && d.length >= 50 && d.length <= 160;
    }
  },
  { label: "`<h1>` 有且僅一個", check: () => $("h1").length === 1 },
  {
    label: "`<img>` 皆有非空 alt",
    check: () => $("img").toArray().every(el => ($(el).attr("alt") || "").trim().length > 0)
  },
  {
    label: "`<a>` href 合法（非空/非 #）",
    check: () => $("a").toArray().every(el => {
      const h = ($(el).attr("href") || "").trim();
      return h && h !== "#";
    })
  }
];

// 3) 計分（含水平捲動 3 項）
const scrollTargets = [320, 768, 1440];
const totalItems = rules.length + scrollTargets.length;
const each = 100 / totalItems;

let score = 0;
const results = [];

for (const r of rules) {
  const passed = !!r.check();
  if (passed) score += each;
  results.push({ label: r.label, passed });
}

// 4) 水平捲動檢查（以本機檔案載入）
async function checkScroll(width) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto("file://" + path.join(process.cwd(), htmlFile), { waitUntil: "networkidle" });

  const { scrollWidth, innerWidth } = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    };
  });

  const ok = scrollWidth <= innerWidth;

  // 偵錯輸出
  if (!ok) {
    console.log(`  ⚠️  ${width}px: scrollWidth=${scrollWidth}, innerWidth=${innerWidth}, 超出=${scrollWidth - innerWidth}px`);
  }

  await browser.close();
  return ok;
}

for (const w of scrollTargets) {
  const ok = await checkScroll(w).catch((err) => {
    console.log(`  ❌ ${w}px 檢查時發生錯誤:`, err.message);
    return false;
  });
  if (ok) score += each;
  results.push({ label: `${w}px 無水平捲動`, passed: ok });
}

const finalScore = Math.round(score);

// 5) 輸出（console + Step Summary + PR Comment）
output({ results, score: finalScore });

// 6) 自動在 PR 留言
await postPRComment({ results, score: finalScore });

// 7) 檢查是否所有項目都通過，否則讓 CI 失敗
const allPassed = results.every(r => r.passed);
if (!allPassed) {
  console.log('\n❌ 有檢查項目未通過，CI 失敗');
  process.exit(1);
}

console.log('\n✅ 所有檢查項目通過！');
process.exit(0);

function output({ results, score, note }) {
  console.log(`🎯 本次檢查：${score}/100 分`);
  if (note) console.log(`ℹ️ ${note}`);
  for (const r of results) {
    console.log(`${r.passed ? "✅" : "❌"} ${r.label}`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const lines = [];
    lines.push(`# 網站檢查結果`);
    lines.push(`**總分：${score}/100**`);
    if (note) lines.push(`\n> ${note}\n`);
    lines.push("\n| 規則 | 結果 |");
    lines.push("|------|------|");
    for (const r of results) {
      lines.push(`| ${r.label} | ${r.passed ? "✅" : "❌"} |`);
    }
    fs.appendFileSync(summary, lines.join("\n"));
  }
}

async function postPRComment({ results, score, note }) {
  // 只在 PR 事件時留言
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' && process.env.GITHUB_EVENT_NAME !== 'pull_request_target') {
    console.log('ℹ️  非 PR 環境，跳過留言');
    return;
  }

  const prNumber = process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1];
  if (!prNumber) {
    console.log('⚠️  無法取得 PR 編號，跳過留言');
    return;
  }

  // 建立留言內容
  const lines = [];
  lines.push('## 🎯 網站檢查結果');
  lines.push('');
  lines.push(`### 總分：${score}/100`);
  if (note) lines.push(`\n> ${note}\n`);
  lines.push('');
  lines.push('| 規則 | 結果 |');
  lines.push('|------|------|');
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.passed ? '✅ 通過' : '❌ 失敗'} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('*自動檢查 by 六角學院*');

  const commentBody = lines.join('\n');

  // 使用 gh CLI 留言
  try {
    // 將留言內容寫入暫存檔案
    const tmpFile = '/tmp/pr-comment.md';
    fs.writeFileSync(tmpFile, commentBody);

    execSync(`gh pr comment ${prNumber} --body-file ${tmpFile}`, {
      stdio: 'inherit',
      env: { ...process.env }
    });

    console.log(`✅ 已在 PR #${prNumber} 留言`);
    fs.unlinkSync(tmpFile);
  } catch (err) {
    console.error('❌ 留言失敗:', err.message);
    console.error('提示：請確認 GITHUB_TOKEN 權限包含 pull-requests: write');
  }
}