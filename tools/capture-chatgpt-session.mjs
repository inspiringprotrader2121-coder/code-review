// One-time LOCAL capture of the dedicated ChatGPT account's browser session
// (Google SSO). Run on the Mac:
//   cd tools && npm init -y >/dev/null 2>&1 && npm i playwright && npx playwright install chromium
//   node capture-chatgpt-session.mjs
// A Chromium window opens → sign into chatgpt.com with "Continue with Google"
// (the DEDICATED account, not your personal one) → once you see the ChatGPT UI,
// come back here and press Enter. The profile is saved to ./chatgpt-profile/,
// which then gets shipped to the server for the auto-relogin bot.
import { chromium } from 'playwright';
import readline from 'node:readline';
import path from 'node:path';

const profileDir = path.resolve('./chatgpt-profile');

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 850 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://chatgpt.com/');

console.log('\n➡️  Sign in with Google (the DEDICATED account). When ChatGPT is fully loaded, press Enter here…');
await new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('', () => {
    rl.close();
    res();
  });
});

// touch both domains so their cookies are fresh in the profile
await page.goto('https://chatgpt.com/');
await page.waitForTimeout(2000);
await ctx.close();
console.log(`\n✅ Session captured in ${profileDir}`);
console.log('Ship it to the server with:');
console.log(
  '  tar -czf chatgpt-profile.tgz chatgpt-profile && scp -i <orvex-ssh-key> chatgpt-profile.tgz orvex@87.106.103.185:/home/orvex/orvex-data/',
);
