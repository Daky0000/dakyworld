import { chromium } from 'file:///C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const base='http://127.0.0.1:5199';
const source=readFileSync('server/client/src/components/Layout.tsx','utf8');
const permissions=[...source.matchAll(/needs: "([^"]+)"/g)].map(m=>m[1]).concat(['leads.create','website.manage']);
const user={id:'preview',name:'Alex Morgan',email:'preview@example.test',role:'OWNER',roleName:'Owner',permissions};
const dashboard={revenueThisMonth:'84250',monthlyRecurringRevenue:'18600',activeCarePlanCount:12,outstandingInvoiceTotal:'22400',outstandingInvoiceCount:7,pipelineValue:'146800',openProposalCount:9,leadsByStatus:[{status:'NEW',_count:148},{status:'QUALIFYING',_count:86},{status:'QUALIFIED',_count:64},{status:'CONVERTED',_count:32},{status:'DISQUALIFIED',_count:18},{status:'LOST',_count:12}],carePlans:{active:12,paused:2,churnedThisQuarter:1,billingWithin7Days:4,reviewsDue:3,draftInvoices:2,nextBilling:{id:'one',client:'Northline Studio',at:'2026-09-25T10:00:00Z',amount:'2400',currency:'GHS'}}};
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let signedIn=true, failDashboard=false;
await page.route('**/api/**',route=>{
 const path=new URL(route.request().url()).pathname.replace('/api','');
 let body=[];
 if(path==='/clients') body=[{id:'northline',name:'Northline Studio',email:'hello@example.test',sector:'Architecture',lifetimeValue:'64200',_count:{projects:3,carePlans:1}},{id:'atlas',name:'Atlas Hospitality',email:'atlas@example.test',sector:'Hospitality',lifetimeValue:'38750',_count:{projects:2,carePlans:1}}];
 if(path==='/website/overview') body={counts:{sites:0,pages:0,hidden:0,drafts:0,unconnected:0},recent:[]};
 if(path==='/auth/me') return route.fulfill({status:signedIn?200:401,json:signedIn?user:{error:'Sign in'}});
 if(path==='/dashboard') return route.fulfill({status:failDashboard?500:200,json:failDashboard?{error:'Unavailable'}:dashboard});
 if(path==='/leads/grouped') body={groups:[],totalGroups:0,totalLeads:0,perGroup:50,skipGroups:0};
 if(path==='/leads/stats') body={total:0,averageScore:0,pipelineValue:'0',reachable:0,newThisWeek:0,byStatus:[],bySource:[],byMethod:[],cities:[],categories:[],groups:[]};
 if(path==='/leads') body={items:[],total:0};
 if(path==='/leads/groups/empty') body={removable:[],keptFeeding:[]};
 return route.fulfill({json:body});
});
const checks=[];
function check(label,pass){checks.push({label,pass});if(!pass)console.error('FAIL',label);}
for(const [route,name] of [['/','dashboard'],['/clients','clients'],['/projects','projects'],['/leads','leads'],['/website','website']]){
 await page.goto(base+route);await page.locator('h1').waitFor({timeout:15000});await page.evaluate(()=>document.fonts.ready);
 check(name+' renders',await page.locator('h1').count()>0);
 check(name+' desktop overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:`.design-review/${name}-desktop.png`,fullPage:true});
}
await page.setViewportSize({width:390,height:844});
for(const route of ['/clients','/projects','/leads','/website']) {
 await page.goto(base+route);await page.locator('h1').waitFor();
 check(route+' mobile workspace fits', await page.locator('.os-workspace').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.screenshot({path:'.design-review/'+route.slice(1)+'-mobile.png',fullPage:true});
}
await page.setViewportSize({width:1440,height:1050});
await page.goto(base+'/clients');
await page.getByPlaceholder('Search by client name, email, or sector', {exact:false}).fill('Northline');
check('client search filters rows',await page.locator('tbody tr').count()===1);
await page.getByPlaceholder('Search by client name, email, or sector', {exact:false}).fill('');
await page.getByRole('button',{name:'Hospitality',exact:true}).click();
check('client sector filter',await page.locator('tbody tr').count()===1 && (await page.locator('tbody').innerText()).includes('Atlas'));
await page.goto(base);await page.getByText('The bigger picture.').waitFor();
await page.getByLabel('Find a workspace page').fill('invoice');
check('navigation search',await page.locator('.os-nav-link').count()===1);
await page.getByLabel('Find a workspace page').fill('');
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:'.design-review/dashboard-mobile.png',fullPage:true});
check('mobile overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('button',{name:'Menu',exact:true}).click();
check('mobile drawer opens',await page.getByRole('dialog',{name:'Navigation'}).isVisible());
await page.keyboard.press('Escape');
check('mobile drawer escape',await page.getByRole('dialog',{name:'Navigation'}).count()===0);
check('focus restored',await page.getByRole('button',{name:'Menu',exact:true}).evaluate(el=>el===document.activeElement));
await page.getByRole('button',{name:'Menu',exact:true}).click();
await page.getByRole('navigation',{name:'Mobile navigation'}).getByRole('link',{name:'Clients',exact:true}).click();
check('navigation closes after route change',await page.getByRole('dialog',{name:'Navigation'}).count()===0);
await page.getByRole('heading',{name:'Clients',exact:true}).waitFor();
await page.screenshot({path:'.design-review/clients-mobile.png',fullPage:true});
failDashboard=true;await page.goto(base);await page.getByText('Overview unavailable').waitFor({timeout:15000});check('dashboard error shown',true);
signedIn=false;await page.goto(base);await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
await page.screenshot({path:'.design-review/login-mobile.png',fullPage:true});
await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.design-review/login-desktop.png',fullPage:true});
check('no browser runtime errors',errors.length===0);
console.log(JSON.stringify({checks,errors},null,2));await browser.close();
if(checks.some(c=>!c.pass))process.exitCode=1;
