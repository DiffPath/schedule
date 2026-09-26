// Open schedule-mock.html in headless Chrome, signed in as the admin, with
// page-gen.js injected. puppeteer-core must be on NODE_PATH (kept out of
// the repo).
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');

async function openApp() {
    const profile = path.join(os.tmpdir(), 'sched-tune-prof-' + process.pid);
    const browser = await puppeteer.launch({
        executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
        headless: 'new', userDataDir: profile, protocolTimeout: 0,
    });
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('PAGEERROR', e.message));
    await page.goto('file:///' + ROOT + '/schedule-mock.html');
    await page.waitForSelector('#loginPath');
    await page.evaluate(() => {
        const sel = document.getElementById('loginPath');
        sel.value = [...sel.options].find(o => /Moravek/.test(o.textContent)).value;
        sel.dispatchEvent(new Event('change'));
        document.getElementById('loginPassword').value = 'demo';
    });
    await page.click('#loginSubmit');
    await new Promise(r => setTimeout(r, 1200));
    await page.addScriptTag({ path: path.join(__dirname, 'page-gen.js') });
    const close = async () => {
        await browser.close();
        fs.rmSync(profile, { recursive: true, force: true });
    };
    return { page, close };
}

module.exports = { openApp, ROOT };
