import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/legacy/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/legacy/build/pdf.worker.min.mjs';
const $=id=>document.getElementById(id); let pdf=null,worker=null,stopped=false,pageInfo=[],groups=[],bank=[],passageBlobs=new Map(),answerFindings=[];
const status=t=>$('status').textContent=t; const progress=x=>$('bar').style.width=Math.max(0,Math.min(100,x))+'%';
function norm(s){return String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\s+\n/g,'\n').trim()}
function canonicalTestNo(raw){const m=String(raw||'').replace(/O/gi,'0').match(/([1-8])/);return m?Number(m[1]):0}
function actualFromText(t){
 const s=String(t||'').replace(/\u00a0/g,' ').replace(/\bActuaI\b/gi,'Actual').replace(/\bActua1\b/gi,'Actual').replace(/\bActuai\b/gi,'Actual');
 let m=s.match(/Actual\s*Test\s*0?([1-8])\b/i);
 if(!m){m=s.match(/Actual\s*T[eE]st\s*[O0]([1-8])\b/i)}
 return m?'Actual Test '+String(Number(m[1])).padStart(2,'0'):''
}
function fuzzyActualFromText(t){
 const s=String(t||'').replace(/\s+/g,' ');
 let m=s.match(/Actu[a-z0-9|]{0,3}\s*Test\s*[O0]?([1-8])\b/i);
 if(m)return 'Actual Test '+String(Number(m[1])).padStart(2,'0');
 m=s.match(/Actual\s*Test\s*[O0]?([1-8])\b/i);
 return m?'Actual Test '+String(Number(m[1])).padStart(2,'0'):''
}
function questionHits(t){
 const a=[]; const re=/(?:^|\s|\n)(1[5-9]\d|200)\s*[.)\-:]?\s+(?=[A-Za-z(])/g; let m;
 while((m=re.exec(String(t||''))))a.push(Number(m[1]));
 return [...new Set(a)]
}
function groupHeaderHits(t){
 const a=[]; const s=String(t||'').replace(/[—–]/g,'-').replace(/\s+/g,' ');
 const re=/(?:Questions?|Questlons?)\s*(1[5-9]\d|200)\s*(?:-|to)\s*(1[5-9]\d|200)\s*(?:refer|refe?r|r[e3]fer)\s*(?:to|t0)?/gi; let m;
 while((m=re.exec(s)))a.push([Number(m[1]),Number(m[2])]);
 return a
}
function cleanOCR(s){return norm(s).replace(/www[.,]?nhantriviet\.com/gi,'').replace(/Go on\s*(to|the)?\s*next page/gi,'').replace(/Stop!?/gi,'').replace(/TOEIC BOOK STORE/gi,'').trim()}
function markerLines(lines){let out=[]; for(const line of lines){let s=norm(line),m=s.match(/^\(?([A-D0-3])\)?[.\-:]\s*(.+)$/i)||s.match(/(?:^|\s)\(?([A-D])\)?[.\-:]\s*(.+)$/i); if(m){let l=m[1].toUpperCase(); if(l==='0'||l==='3')l='D'; if(l==='2')l='C'; if(l==='1')l='B'; out.push({letter:l,text:cleanOCR(m[2])})}} return out}
async function renderPage(n,scale=1){const p=await pdf.getPage(n),vp=p.getViewport({scale}),c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return {page:p,canvas:c,vp}}
async function pageText(n){const p=await pdf.getPage(n),tc=await p.getTextContent();return norm(tc.items.map(x=>x.str).join(' '))}
async function ocrCanvas(canvas){if(!worker)worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status&&m.progress!=null)status('🧠 '+m.status+' '+Math.round(m.progress*100)+'%')}});const r=await worker.recognize(canvas);return {text:cleanOCR(r.data.text),tsv:r.data.tsv||''}}
function resetAfterScan(){bank=[];groups=[];passageBlobs.clear();answerFindings=[];$('btnOCR').disabled=true;$('btnAnswers').disabled=true;$('btnExport').disabled=true;$('btnExportOfficial').disabled=true;$('bankRows').innerHTML='';$('answerRows').innerHTML='';$('answerStatus').textContent='Chưa nhận diện đáp án.'}
function addPageInfo(n,text,source,preview,tsv){const info={page:n,text:text||'',actual:actualFromText(text)||fuzzyActualFromText(text),hits:questionHits(text),headers:groupHeaderHits(text),source};if(preview)info.preview=preview;if(tsv)info.tsv=tsv;const old=pageInfo.findIndex(x=>x.page===n);if(old>=0)pageInfo[old]=info;else pageInfo.push(info);return info}
function uniqueSorted(a){return [...new Set(a)].sort((x,y)=>x-y)}
function mergeTestCandidates(cands){
 const by={}; for(const c of cands){if(!c.actual)continue;(by[c.actual]??=[]).push(c.page)}
 return Object.entries(by).map(([test,pages])=>({test,pages:uniqueSorted(pages),first:Math.min(...pages),last:Math.max(...pages)})).sort((a,b)=>a.first-b.first)
}
async function locateTestsSmart(s,e){
 const span=e-s+1, step=span>180?5:span>100?4:3;
 const samplePages=uniqueSorted([s,e,...Array.from({length:Math.floor(span/step)+1},(_,i)=>Math.min(e,s+i*step))]);
 const samples=[]; let idx=0;
 status(`🔎 Dò Actual Test tự động: quét mẫu ${samplePages.length} trang, không OCR toàn bộ PDF…`);
 for(const n of samplePages){if(stopped)break; let text='';try{text=await pageText(n)}catch{};
   if(!text){const r=await renderPage(n,.62),o=await ocrCanvas(r.canvas);text=o.text;samples.push(addPageInfo(n,text,'ocr-sample',r.canvas.toDataURL('image/jpeg',.65),o.tsv))}
   else samples.push(addPageInfo(n,text,'text',null,null));
   idx++;progress(idx/samplePages.length*30);status(`🔎 Dò Test: trang mẫu ${n}/${e}…`)
 }
 let tests=mergeTestCandidates(samples);
 // If OCR missed a marker, use pages containing Part 7 question numbers as anchors and inspect a small neighborhood.
 const anchors=[]; for(const p of samples)if(p.hits.some(q=>q>=153&&q<=200)||/Part\s*7/i.test(p.text))anchors.push(p.page);
 const neighborhoods=uniqueSorted(anchors.flatMap(n=>{const a=[];for(let k=-4;k<=4;k++)if(n+k>=s&&n+k<=e)a.push(n+k);return a}));
 for(const n of neighborhoods){if(stopped)break;if(pageInfo.some(p=>p.page===n&&p.source!=='text'&&p.source!=='ocr-sample'))continue;let info=pageInfo.find(p=>p.page===n);if(!info||!info.text){const r=await renderPage(n,.72),o=await ocrCanvas(r.canvas);info=addPageInfo(n,o.text,'ocr-locate',r.canvas.toDataURL('image/jpeg',.7),o.tsv)}else if(!info.actual){info.actual=fuzzyActualFromText(info.text)}if(info.actual&&!tests.some(t=>t.test===info.actual))tests=mergeTestCandidates([...tests,{actual:info.actual,page:info.page}]);}
 // Expand around each candidate to locate the earliest page carrying the same test marker or Part 7 content.
 const refined=[];
 for(const t of tests){if(stopped)break;let lo=Math.max(s,t.first-5),hi=Math.min(e,t.first+5),found=[];for(let n=lo;n<=hi;n++){let info=pageInfo.find(p=>p.page===n);if(!info||!info.text){const r=await renderPage(n,.75),o=await ocrCanvas(r.canvas);info=addPageInfo(n,o.text,'ocr-locate',r.canvas.toDataURL('image/jpeg',.7),o.tsv)}if(info.actual===t.test||fuzzyActualFromText(info.text)===t.test)found.push(n)};refined.push({...t,first:Math.min(t.first,...found),markerPages:uniqueSorted([...t.pages,...found])})}
 tests=refined.sort((a,b)=>a.first-b.first);
 // If the very first Actual Test marker is missed, infer the test start from the first Part 7 anchor and scan backward a few pages.
 if(!tests.length&&anchors.length){
   const a=Math.min(...anchors); let inferred='Actual Test 01'; for(let n=Math.max(s,a-8);n<=a;n++){const info=pageInfo.find(p=>p.page===n);if(info?.actual){inferred=info.actual;break}} tests=[{test:inferred,pages:[],first:Math.max(s,a-5),last:a,markerPages:[]}]
 }
 return tests
}
async function scan(){
 const f=$('pdfFile').files[0]; if(!f){status('⚠️ Hãy chọn PDF.');return}
 stopped=false;resetAfterScan();$('btnStop').disabled=false;$('btnScan').disabled=true;progress(0);
 status('⏳ Đang mở PDF…');pdf=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;
 const rawS=Number($('startPage').value),rawE=Number($('endPage').value); const s=Math.max(1,rawS||1),e=Math.min(pdf.numPages,rawE||pdf.numPages);
 $('endPage').placeholder=String(pdf.numPages);
 pageInfo=[];
 // First pass: text layer only — no OCR. This is fast and costs little even for a large PDF.
 let textCount=0; const textPages=[];
 for(let n=s;n<=e&&!stopped;n++){let text='';try{text=await pageText(n)}catch{};if(text)textCount++;textPages.push(addPageInfo(n,text,'text'));progress((n-s+1)/(e-s+1)*15);if((n-s+1)%20===0||n===s)status(`📖 Đọc text layer ${n}/${e}…`)}
 let tests=mergeTestCandidates(textPages);
 const textHasStructure=textPages.some(p=>p.headers.length||p.hits.some(q=>q>=153))&&tests.length;
 if(!textHasStructure){
   tests=await locateTestsSmart(s,e);
 } else {
   status(`✅ Text layer đã tìm thấy ${tests.length} Actual Test. Không OCR các trang ngoài vùng Test.`);
 }
 if(stopped){$('btnScan').disabled=false;$('btnStop').disabled=true;return}
 // Determine exact scan window: from first detected Test to just before the next Test. Pages before first Test are skipped.
 if(tests.length){
   const ordered=tests.sort((a,b)=>a.first-b.first);
   const firstTestPage=ordered[0].first;
   // Estimate each Test window from its start to the page before the next Test.
   // The last Test extends to the user/PDF end; later OCR/group detection will ignore non-Part-7 pages.
   const windows=[];
   for(let i=0;i<ordered.length;i++){
     const a=ordered[i].first;
     const b=i+1<ordered.length?ordered[i+1].first-1:e;
     windows.push([a,b,ordered[i].test]);
   }
   const lastTestPage=windows.at(-1)?.[1]||e;
   $('startPage').value=firstTestPage;
   $('endPage').value=lastTestPage;
   // Propagate the detected Test identity through its whole window. This lets buildGroups keep all continuation pages.
   for(const [a,b,test] of windows){
     for(const p of pageInfo){if(p.page>=a&&p.page<=b&&!p.actual)p.actual=test;}
   }
   // OCR only the detected Test windows when the PDF is scanned. Pages before the first Test are never OCRed.
   const needOCR=pageInfo.some(p=>p.source==='ocr-sample'||p.source==='ocr-locate')||textCount<Math.max(2,Math.floor((e-s+1)*.05));
   if(needOCR){
     let total=windows.reduce((n,w)=>n+w[1]-w[0]+1,0),done=0;
     for(const [a,b,test] of windows){for(let n=a;n<=b&&!stopped;n++){let info=pageInfo.find(p=>p.page===n);const needsDetailedOCR=!info||info.source!=='text'||!info.headers.length||!info.hits.length;if(needsDetailedOCR){const r=await renderPage(n,.78),o=await ocrCanvas(r.canvas);addPageInfo(n,o.text,'ocr-test',r.canvas.toDataURL('image/jpeg',.7),o.tsv)}done++;progress(30+done/Math.max(1,total)*60);status(`🧠 Quét vùng ${test}: trang ${n}/${b}…`)}}
   }
   buildGroups();
 } else {
   groups=[];buildGroups();
 }
 renderSummary();
 $('btnOCR').disabled=!groups.length;
 $('btnAnswers').disabled=true;
 $('btnScan').disabled=false;$('btnStop').disabled=true;
 if(groups.length)status(`🟢 Đã xác định vùng Test và Part 7: ${groups.length} nhóm. Các trang trước Test đã được bỏ qua. Có thể bấm “OCR vùng Part 7”.`);
 else status('⚠️ Chưa xác định được cấu trúc Actual Test/Part 7. Hãy kiểm tra phạm vi hoặc PDF có bố cục khác.');
}
function buildGroups(){
 groups=[];
 const sorted=pageInfo.slice().sort((a,b)=>a.page-b.page);
 // Propagate a detected Actual Test marker forward until the next marker.
 let current=''; for(const p of sorted){if(p.actual)current=p.actual;else if(current)p.actual=current}
 const byTest={}; for(const p of sorted){if(p.actual)(byTest[p.actual]??=[]).push(p)}
 Object.keys(byTest).sort().forEach(test=>{
   const pages=byTest[test].sort((a,b)=>a.page-b.page),starts=[];
   for(const p of pages)for(const h of p.headers||[]){if(h[0]>=153&&h[1]<=200&&h[1]>=h[0])starts.push({page:p.page,start:h[0],end:h[1]})}
   // Fallback: use first occurrence of each question number and infer group boundaries from header-like ranges when OCR loses words.
   if(!starts.length){
     const hits=[];for(const p of pages)for(const n of p.hits||[])if(n>=153&&n<=200)hits.push({page:p.page,n});
     const first=hits.find(x=>x.n===153);if(first)starts.push({page:first.page,start:153,end:154});
   }
   // Deduplicate starts and retain chronological order.
   const uniq=[];const seen=new Set();for(const g of starts.sort((a,b)=>a.page-b.page||a.start-b.start)){const k=`${g.start}-${g.end}-${g.page}`;if(!seen.has(k)){seen.add(k);uniq.push(g)}}
   uniq.forEach((g,i)=>{
     const next=uniq[i+1]; const endPage=next?next.page-1:pages.at(-1).page; const gp=pages.filter(p=>p.page>=g.page&&p.page<=endPage);
     groups.push({id:`P7-T${test.slice(-2)}-G${String(i+1).padStart(2,'0')}`,test,start:g.start,end:g.end,startPage:g.page,endPage,pages:gp})
   })
 });
 // Hard safety: discard groups outside Part 7 and sort by Test/page/question.
 groups=groups.filter(g=>g.start>=153&&g.end<=200&&g.end>=g.start).sort((a,b)=>a.startPage-b.startPage||a.start-b.start);
}
function renderSummary(){const tests=[...new Set(groups.map(g=>g.test))];$('summary').innerHTML=`<b>${groups.length}</b> nhóm phát hiện · <b>${tests.length}</b> Actual Test · ${pageInfo.filter(p=>String(p.source||'').startsWith('ocr')).length} trang dùng OCR.`;$('tests').innerHTML=tests.map(t=>{const gs=groups.filter(g=>g.test===t);return `<div class="test-card"><h3>${t}</h3><span class="badge">${gs.length} nhóm</span><span class="badge">${gs.reduce((n,g)=>n+(g.end-g.start+1),0)} câu dự kiến</span><div class="small" style="margin-top:6px">${gs.map(g=>`${g.start}–${g.end}`).join(' · ')}</div></div>`}).join('')||'<div class="small">Không tìm thấy cấu trúc Questions xxx–yyy. Với PDF khác mẫu, có thể cần kiểm tra thủ công.</div>'}
function splitColumnsTSV(tsv){const rows=String(tsv||'').split(/\r?\n/).slice(1).map(line=>line.split('\t'));const items=[];for(const r of rows){if(r.length<12)continue;const txt=norm(r[11]);if(!txt)continue;items.push({x:Number(r[6])||0,y:Number(r[7])||0,w:Number(r[8])||0,h:Number(r[9])||0,conf:Number(r[10])||0,text:txt})}return items}
function linesFromItems(items){items.sort((a,b)=>a.y-b.y||a.x-b.x);const lines=[];for(const it of items){let l=lines.find(z=>Math.abs(z.y-it.y)<Math.max(7,it.h*.65));if(!l){l={y:it.y,items:[]};lines.push(l)}l.items.push(it)}return lines.sort((a,b)=>a.y-b.y).map(l=>l.items.sort((a,b)=>a.x-b.x).map(x=>x.text).join(' '))}
function extractQuestions(text,range){let s=cleanOCR(text).replace(/\r/g,''),out=[],re=/(^|\n|\s)(1[5-9]\d|200)[.)]\s+/g,m,hits=[];while((m=re.exec(s))){const n=Number(m[2]);if(n>=range[0]&&n<=range[1])hits.push({n,pos:m.index+m[1].length})}for(let i=0;i<hits.length;i++){const h=hits[i],nxt=hits[i+1]?.pos??s.length;let chunk=s.slice(h.pos,nxt).trim().replace(/^\d+[.)]\s*/,''),qline=chunk.split(/\n/)[0]||chunk,opts=markerLines(chunk.split(/\n/)),q={n:h.n,q:qline,A:'',B:'',C:'',D:'',confidence:'LOW'};opts.forEach(o=>q[o.letter]=o.text);if(q.A&&q.B&&q.C&&q.D)q.confidence='MEDIUM';out.push(q)}return out}
async function cropPassage(group){const canvases=[];for(const p of group.pages){const r=await renderPage(p.page,1.15);let cropH=r.canvas.height,txt=pageInfo.find(x=>x.page===p.page)?.text||'',hits=questionHits(txt).filter(n=>n>=group.start&&n<=group.end);if(hits.length)cropH=Math.floor(r.canvas.height*.64);canvases.push({canvas:r.canvas,h:cropH})}const width=Math.max(...canvases.map(x=>x.canvas.width)),height=canvases.reduce((s,x)=>s+x.h,0),c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');let y=0;for(const x of canvases){ctx.drawImage(x.canvas,0,0,x.canvas.width,x.h,0,y,x.canvas.width,x.h);y+=x.h}return await new Promise(res=>c.toBlob(res,'image/jpeg',.86))}
async function runOCR(){if(!groups.length){status('⚠️ Chưa tìm thấy nhóm Part 7.');return}$('btnOCR').disabled=true;bank=[];passageBlobs.clear();const total=groups.length;let done=0;for(const g of groups){if(stopped)break;status(`🧠 OCR nhóm ${g.id} · ${g.start}–${g.end}`);const texts=[];for(const p of g.pages){const r=await renderPage(p.page,1.35),o=await ocrCanvas(r.canvas);texts.push(o.text)}const qs=extractQuestions(texts.join('\n'),[g.start,g.end]);for(let n=g.start;n<=g.end;n++){const existing=qs.find(q=>q.n===n),rec={MaCau:`P7-T${g.test.slice(-2)}-${n}`,Part:'Part 7',CauSo:n,ActualTest:g.test,GroupID:g.id,ChuDe:'PDF Part 7',DangBai:'Đọc hiểu theo bài trong sách / PDF',CauHoi:existing?.q||'',DapAnA:existing?.A||'',DapAnB:existing?.B||'',DapAnC:existing?.C||'',DapAnD:existing?.D||'',DapAnDung:'',GiaiThich:'',PassageImageURL:`TOEIC_PART7_PASSAGES/${g.id.toLowerCase().replace(/-/g,'_')}.jpg`,HinhBaiDoc:`TOEIC_PART7_PASSAGES/${g.id.toLowerCase().replace(/-/g,'_')}.jpg`,SourcePageStart:g.startPage,SourcePageEnd:g.endPage,Source:'PDF do người dùng chọn',DataStatus:existing?.confidence==='MEDIUM'?'SOURCE_OCR_TEXT_PENDING_VISUAL_REVIEW':'SOURCE_OCR_TEXT_LOW_CONFIDENCE',GroupIndex:Number(g.id.match(/G(\d+)$/)?.[1]||0),GroupStart:g.start,GroupEnd:g.end,ReviewStatus:'PENDING'};bank.push(rec)}passageBlobs.set(g.id,await cropPassage(g));done++;progress(done/total*100)}bank.sort((a,b)=>a.ActualTest.localeCompare(b.ActualTest)||a.CauSo-b.CauSo);renderBank();$('btnExport').disabled=!bank.length;$('btnOCR').disabled=false;$('btnAnswers').disabled=!bank.length;status(`✅ Hoàn tất OCR: ${bank.length} câu · ${groups.length} nhóm. Bây giờ có thể bấm “Nhận diện Answer Sheet”.`)}
function answerCandidates(){const c=[];for(const p of pageInfo){const t=String(p.text||'');if(/Answers?[_\s-]*Actual\s*Test|Answer\s*Sheet|Answer\s*Key/i.test(t)||/Part\s*7[\s\S]{0,80}Answers/i.test(t))c.push(p)}return c}
function clusterXs(items){const xs=items.map(x=>x.x).sort((a,b)=>a-b),clusters=[];for(const x of xs){let z=clusters.find(c=>Math.abs(c.mean-x)<35);if(!z){z={mean:x,items:[]};clusters.push(z)}z.items.push(x);z.mean=z.items.reduce((a,b)=>a+b,0)/z.items.length}return clusters.sort((a,b)=>a.mean-b.mean)}
function answerTokensFromTSV(tsv){const items=splitColumnsTSV(tsv).filter(x=>/^\(?[ABCD]\)?$/.test(x.text.toUpperCase())||/^\([ABCD]\)$/.test(x.text.toUpperCase()));return items.map(x=>({...x,letter:x.text.replace(/[()]/g,'').toUpperCase()}))}
function parseAnswerPage(info,test,range,orientation=0){const tokens=answerTokensFromTSV(info.tsv||'');if(!tokens.length)return null;const cols=clusterXs(tokens);if(cols.length<1)return null;const byCol=cols.map(c=>c.items.map(x=>tokens.find(t=>Math.abs(t.x-x)<.01)).filter(Boolean).sort((a,b)=>a.y-b.y));const expected=range[1]-range[0]+1;let flat=[];for(const col of byCol)flat.push(...col);if(flat.length<expected)return {page:info.page,test,detected:flat.length,assigned:0,confidence:'LOW',answers:{},orientation};flat=flat.slice(0,expected);const answers={};let n=range[0];for(const t of flat)answers[n++]=t.letter;return {page:info.page,test,detected:flat.length,assigned:Object.keys(answers).length,confidence:flat.length===expected?'HIGH':'MEDIUM',answers,orientation}}
async function recognizeAnswers(){if(!pdf){status('⚠️ Hãy chọn PDF trước.');return}answerFindings=[];const tests=[...new Set(groups.map(g=>g.test))];if(!tests.length){status('⚠️ Hãy chạy “Tự động tìm Part 7” trước.');return}$('btnAnswers').disabled=true;let done=0;for(const test of tests){const gs=groups.filter(g=>g.test===test).sort((a,b)=>a.startPage-b.startPage),range=[Math.min(...gs.map(g=>g.start)),Math.max(...gs.map(g=>g.end))];let candidates=answerCandidates().filter(p=>p.page>Math.max(...gs.map(g=>g.endPage))&&p.page<=Math.max(...gs.map(g=>g.endPage))+4);if(!candidates.length){const base=Math.max(...gs.map(g=>g.endPage));for(let p=base+1;p<=Math.min(pdf.numPages,base+3);p++){status(`🔑 Tìm Answer Sheet ${test}: trang ${p}`);const r0=await renderPage(p,.9),o0=await ocrCanvas(r0.canvas);let info={page:p,text:o0.text,tsv:o0.tsv};if(!/Answer|Answers|Part\s*7/i.test(info.text)){const r1=await renderPage(p,.9);r1.canvas.getContext('2d').translate(r1.canvas.width,0);/* orientation fallback below */}if(/Answer|Answers|Part\s*7/i.test(info.text))candidates.push(info)}}let best=null;for(const p of candidates){let info=p;if(!info.tsv){const r=await renderPage(p,.95),o=await ocrCanvas(r.canvas);info={...p,text:o.text,tsv:o.tsv}}const found=parseAnswerPage(info,test,range,0);if(found&&( !best||found.assigned>best.assigned))best=found;done++}if(best){for(const [no,ans] of Object.entries(best.answers)){const q=bank.find(x=>x.ActualTest===test&&x.CauSo===Number(no));if(q){q.DapAnDung=ans;q.AnswerSource=`Answer Sheet · trang ${best.page}`;q.AnswerStatus=best.confidence==='HIGH'?'AUTO_DETECTED_PENDING_VERIFY':'AUTO_DETECTED_LOW_CONFIDENCE'}}answerFindings.push(best)}else answerFindings.push({test,page:'—',detected:0,assigned:0,confidence:'NONE',answers:{}})}renderAnswers();renderBank();$('btnAnswers').disabled=false;status('✅ Đã quét Answer Sheet. Các đáp án tự nhận diện vẫn ở trạng thái chờ xác nhận.')}
function renderAnswers(){const total=answerFindings.reduce((n,x)=>n+(x.assigned||0),0);$('answerStatus').innerHTML=`<b>${answerFindings.length}</b> Actual Test · <b>${total}</b> đáp án nhận diện. ⚠️ Tất cả đáp án tự nhận diện vẫn phải được người dùng kiểm tra/xác nhận.`;$('answerRows').innerHTML=answerFindings.map(x=>`<tr><td>${escapeHtml(x.test||'')}</td><td>${escapeHtml(String(x.page||'—'))}</td><td>${x.detected||0}</td><td>${x.assigned||0}</td><td class="${x.confidence==='HIGH'?'ok':'bad'}">${escapeHtml(x.confidence||'NONE')}</td></tr>`).join('')}
let editingIndex=-1;function renderBank(){const low=bank.filter(x=>x.DataStatus.includes('LOW')).length,verified=bank.filter(x=>x.ReviewStatus==='VERIFIED').length;$('issues').className=low?'dangerbox':'warnbox';$('issues').innerHTML=`<b>${bank.length}</b> câu tạo được. ${verified} đã xác nhận · ${bank.length-verified} cần kiểm tra · ${low} LOW_CONFIDENCE.<br>⚠️ DapAnDung có thể được gợi ý từ Answer Sheet nhưng vẫn phải kiểm tra trước khi xác nhận.`;$('bankRows').innerHTML=bank.map((q,i)=>`<tr data-i="${i}" style="cursor:pointer"><td>${escapeHtml(q.ActualTest)}</td><td>${escapeHtml(q.GroupID)}</td><td><b>${q.CauSo}</b></td><td><b>${escapeHtml(q.CauHoi)}</b><br>A. ${escapeHtml(q.DapAnA)}<br>B. ${escapeHtml(q.DapAnB)}<br>C. ${escapeHtml(q.DapAnC)}<br>D. ${escapeHtml(q.DapAnD)}</td><td><b>${escapeHtml(q.DapAnDung||'—')}</b></td><td class="${q.ReviewStatus==='VERIFIED'?'ok':'bad'}">${escapeHtml(q.ReviewStatus||'PENDING')}</td></tr>`).join('');document.querySelectorAll('#bankRows tr').forEach(tr=>tr.onclick=()=>openEditor(Number(tr.dataset.i)));$('btnExportOfficial').disabled=!(bank.length&&bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||'')))}
function openEditor(i){editingIndex=i;const q=bank[i];$('editorEmpty').classList.add('hidden');$('editor').classList.remove('hidden');$('eGroup').value=`${q.ActualTest} · ${q.GroupID}`;$('eNo').value=q.CauSo;$('eAns').value=q.DapAnDung||'';$('eQ').value=q.CauHoi||'';$('eA').value=q.DapAnA||'';$('eB').value=q.DapAnB||'';$('eC').value=q.DapAnC||'';$('eD').value=q.DapAnD||'';$('eExp').value=q.GiaiThich||'';$('editorPreview').innerHTML=`Trang nguồn: ${q.SourcePageStart}–${q.SourcePageEnd} · ${q.DataStatus} · ${q.ReviewStatus||'PENDING'} · ${q.AnswerSource||''}`}
function saveEditor(){if(editingIndex<0)return;const q=bank[editingIndex];q.CauHoi=$('eQ').value.trim();q.DapAnA=$('eA').value.trim();q.DapAnB=$('eB').value.trim();q.DapAnC=$('eC').value.trim();q.DapAnD=$('eD').value.trim();q.DapAnDung=$('eAns').value;q.GiaiThich=$('eExp').value.trim();renderBank();openEditor(editingIndex);status(`💾 Đã lưu câu ${q.CauSo}.`)}
function verifyEditor(){if(editingIndex<0)return;const q=bank[editingIndex];if(!q.CauHoi||![q.DapAnA,q.DapAnB,q.DapAnC,q.DapAnD].every(Boolean)||!q.DapAnDung){alert('Cần đủ câu hỏi, A/B/C/D và đáp án đúng trước khi xác nhận.');return}q.ReviewStatus='VERIFIED';q.DataStatus='SOURCE_VERIFIED_BY_USER';q.AnswerStatus='VERIFIED_BY_USER';renderBank();openEditor(editingIndex);status(`✅ Đã xác nhận câu ${q.CauSo}.`)}
function unverifyEditor(){if(editingIndex<0)return;bank[editingIndex].ReviewStatus='PENDING';renderBank();openEditor(editingIndex);status(`↩ Câu ${bank[editingIndex].CauSo} đã đưa về trạng thái cần kiểm tra.`)}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
async function exportZip(official=false){if(!bank.length)return;if(official&&!bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||''))){alert('Chưa thể xuất bản chính thức: vẫn còn câu chưa xác nhận hoặc thiếu đáp án đúng.');return}const zip=new JSZip(),out=JSON.parse(JSON.stringify(bank));zip.file(official?'toeic_part7_group_bank_v43_9_3_verified.json':'toeic_part7_group_bank_v43_9_3_draft.json',JSON.stringify(out,null,2));zip.file('README_V43.9.3_BUILDER.txt',`V43.9.3 Smart PDF → Part 7 Bank Builder\n\n${official?'Đây là bản ĐÃ XÁC NHẬN bởi người dùng.':'Đây là bản NHÁP OCR; chưa được xác nhận đầy đủ.'}\n\nDữ liệu được tạo từ PDF người dùng chọn. Passage ảnh được xuất trong TOEIC_PART7_PASSAGES/.\n`);const folder=zip.folder('TOEIC_PART7_PASSAGES');for(const [id,blob] of passageBlobs)folder.file(id.toLowerCase().replace(/-/g,'_')+'.jpg',blob);status('📦 Đang đóng ZIP…');const b=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=official?'V43.9.3_PDF_PART7_BANK_VERIFIED.zip':'V43.9.3_PDF_PART7_BANK_DRAFT.zip';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);status(`✅ Đã xuất ${official?'bản chính thức':'bản nháp'} ZIP.`)}
$('btnSaveReview').onclick=saveEditor;$('btnVerify').onclick=verifyEditor;$('btnUnverify').onclick=unverifyEditor;$('btnExportOfficial').onclick=()=>exportZip(true);$('btnAnswers').onclick=recognizeAnswers;$('pdfFile').addEventListener('change',async()=>{const f=$('pdfFile').files[0];if(!f)return;try{pdf=await pdfjsLib.getDocument({data:await f.arrayBuffer()}).promise;$('endPage').value=pdf.numPages;$('btnOCR').disabled=true;$('btnAnswers').disabled=true;$('btnExport').disabled=true;$('btnExportOfficial').disabled=true;status(`📄 ${f.name}\n${pdf.numPages} trang. Sẵn sàng.`)}catch(e){status('❌ Không mở được PDF: '+e.message)}});$('btnScan').onclick=scan;$('btnStop').onclick=()=>{stopped=true;status('⏹ Đã yêu cầu dừng sau bước hiện tại.')};$('btnOCR').onclick=runOCR;$('btnExport').onclick=exportZip;window.addEventListener('beforeunload',()=>{if(worker)worker.terminate()});

window.openToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='flex';document.body.style.overflow='hidden';}};
window.closeToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='none';document.body.style.overflow='';}};
