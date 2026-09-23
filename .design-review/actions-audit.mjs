import {chromium} from 'file:///C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:1000}});
for(const path of ['/leads','/proposals','/invoices','/care-plans','/emails','/messages','/agents','/team','/website/sites']){await p.goto('http://localhost:5173'+path);await p.waitForTimeout(500);console.log(path,await p.locator('main button').evaluateAll(els=>[...new Set(els.filter(e=>e.getClientRects().length).map(e=>e.textContent.trim()))].slice(0,15)));}
await b.close();
