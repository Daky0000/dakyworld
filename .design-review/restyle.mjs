import ts from '../server/client/node_modules/typescript/lib/typescript.js';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
const changed=[];
function restyle(s){
  s=s.replace(/rounded-\[(?:[0-9]|0[0-9])px\]/g,'rounded-[10px]').replace(/\brounded-(?:sm|md|lg)\b/g,'rounded-[10px]');
  s=s.replace(/text-\[(?:8|9|10)px\]/g,'text-[11px]');
  s=s.replace(/shadow-\[0_2px_8px_rgba\(8,16,31,0\.0[34]\)\]/g,'');
  s=s.replace(/\bactive:scale-(?:95|\[0\.9[89]\])\b/g,'');
  if(s.includes('uppercase')&&s.includes('font-mono'))s=s.replace(/\bfont-mono\b/g,'font-sans').replace(/tracking-\[\.[0-9]+em\]/g,'tracking-[.06em]');
  if(s.includes('font-display'))s=s.replace(/\bfont-(?:bold|extrabold)\b/g,'font-medium');
  return s;
}
for(const dir of ['pages','components'])for(const file of readdirSync('server/client/src/'+dir).filter(f=>f.endsWith('.tsx'))){
 const path='server/client/src/'+dir+'/'+file;const src=readFileSync(path,'utf8');const ast=ts.createSourceFile(path,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const edits=[];
 function inspect(n){if(ts.isJsxAttribute(n)&&n.name.getText(ast)==='className'&&n.initializer){
  function literals(c){if(ts.isStringLiteral(c)||ts.isNoSubstitutionTemplateLiteral(c)||c.kind===ts.SyntaxKind.TemplateHead||c.kind===ts.SyntaxKind.TemplateMiddle||c.kind===ts.SyntaxKind.TemplateTail){const start=c.getStart(ast),end=c.getEnd(),raw=src.slice(start,end),next=restyle(raw);if(raw!==next)edits.push({start,end,next});}else ts.forEachChild(c,literals)}literals(n.initializer);
 }else ts.forEachChild(n,inspect)}inspect(ast);
 if(edits.length){let out=src;for(const e of edits.sort((a,b)=>b.start-a.start))out=out.slice(0,e.start)+e.next+out.slice(e.end);writeFileSync(path,out);changed.push({file,styles:edits.length});}
}
writeFileSync('.design-review/component-style-coverage.json',JSON.stringify(changed,null,2));console.log(JSON.stringify({components:changed.length,styleEdits:changed.reduce((a,c)=>a+c.styles,0)}));
