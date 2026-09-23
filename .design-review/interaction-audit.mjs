import {chromium} from 'file:///C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import {writeFileSync} from 'node:fs';
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];const results=[];page.on('pageerror',e=>errors.push(e.message));
// This review opens forms and menus only. It never submits business actions.
await page.route('**/api/**',route=>route.request().method()==='GET'?route.continue():route.abort());
for(const [path,label] of [['/leads','New lead'],['/leads','Columns'],['/proposals','Draft a proposal'],['/care-plans','New care plan'],['/emails','New email'],['/messages','New message'],['/agents','Hire a specialist'],['/team','Add someone'],['/website/sites','Guide & Tips'],['/website/sites','Connect a website']]){
 await page.goto('http://localhost:5199'+path);await page.waitForTimeout(600);
 const button=page.getByRole('button',{name:label,exact:true}).first();await button.click();await page.waitForTimeout(350);
 console.log('Opened',label);
 const dialog=page.locator('[role=dialog]').last();const count=await dialog.count();
 if(count){const name=await dialog.getAttribute('aria-labelledby');const fits=await dialog.evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1);const focus=await dialog.evaluate(el=>el.contains(document.activeElement));await page.screenshot({path:'.design-review/live/dialog-'+label.toLowerCase().replaceAll(' ','-')+'.png'});await page.keyboard.press('Escape');await page.waitForTimeout(150);results.push({path,label,dialog:true,named:Boolean(name)||Boolean(await dialog.count()&&await dialog.getAttribute('aria-label')),fits,focus,closed:await page.locator('[role=dialog]').count()===0});}
 else results.push({path,label,dialog:false,visibleForm:await page.locator('main form').count()});
}
await page.goto('http://localhost:5199/leads');await page.locator('summary').filter({hasText:'Export leads'}).click();results.push({label:'export dropdown',opened:await page.getByText('Excel workbook',{exact:false}).isVisible()});await page.keyboard.press('Escape');results.push({label:'export escape',closed:!await page.getByText('Excel workbook',{exact:false}).isVisible()});
await page.goto('http://localhost:5199/website');await page.locator('summary').filter({hasText:'Manage website'}).click();await page.locator('.os-dropdown-panel').getByRole('link',{name:'Settings',exact:true}).click();results.push({label:'website dropdown navigation',passed:page.url().endsWith('/website/settings')});
writeFileSync('.design-review/live/interaction-audit.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));await browser.close();
