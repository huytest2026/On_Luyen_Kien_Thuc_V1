import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/legacy/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/legacy/build/pdf.worker.min.mjs';

/* V44.1.13 — Integrated TOEIC Bank Builder
 * PDF đề + PDF đáp án -> Part 5 / 6 / 7 bank.
 * Source-first, review-before-official-export.
 */
const $=id=>document.getElementById(id);
let sourcePdf=null, sourcePdfs=new Map(), sourceFiles=[], answerPdf=null, worker=null, stopped=false;
let pageInfo=[], bank=[], groups=[], answerFindings=[], passageBlobs=new Map(), editingIndex=-1;
const status=t=>{const e=$('status');if(e)e.textContent=t};
const progress=x=>{const e=$('bar');if(e)e.style.width=Math.max(0,Math.min(100,x))+'%'};
const norm=s=>String(s||'').replace(/\u00a0/g,' ').replace(/[ \t]+/g,' ').replace(/\s+\n/g,'\n').trim();
const clean=s=>norm(s).replace(/www[.,]?nhantriviet\.com/gi,'').replace(/Go on\s*(to|the)?\s*next page/gi,'').replace(/TOEIC BOOK STORE/gi,'').trim();
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
function actualFromText(t){
 const s=String(t||'').replace(/\bActuaI\b/gi,'Actual').replace(/\bActua1\b/gi,'Actual').replace(/\bActuai\b/gi,'Actual');
 let m=s.match(/Actual\s*Test\s*0?([0-9]{1,2})\b/i)||s.match(/Actu[a-z0-9|]{0,3}\s*Test\s*[O0]?([0-9]{1,2})\b/i);
 return m?'Actual Test '+String(Number(m[1])).padStart(2,'0'):'';
}
function qNumbers(t){
 const a=[];
 // Do not require a newline: PDF text extraction from 2-column pages can put
 // question 101 and 105 on the same extracted line. We therefore detect the
 // question number by its numeric range + punctuation/space + sentence start.
 const re=/(?:^|[\s|])((?:10[1-9]|1[1-9]\d|19\d|200))\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g;
 let m;while((m=re.exec(String(t||''))))a.push(Number(m[1]));
 return [...new Set(a)];
}
function questionRangeForPart(part){return part==='Part 5'?[101,140]:part==='Part 6'?[141,152]:[153,200]}
function inferPart(n){return n<=140?'Part 5':n<=152?'Part 6':n>=153?'Part 7':''}
function actualByQuestionResets(records){
 let testNo=0,last=0;for(const r of records){if(r.n===101&&last>0)testNo++;if(!testNo)testNo=1; if(r.n<last && r.n!==101)testNo++;r.test='Actual Test '+String(testNo).padStart(2,'0');last=r.n}return records;
}
async function openPdf(file){return pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise}
async function pageLayout(doc,n){
 const p=await doc.getPage(n),tc=await p.getTextContent(),vp=p.getViewport({scale:1});
 const items=[];
 for(const it of tc.items){
  const text=clean(it.str);if(!text)continue;
  items.push({text,x:Number(it.transform?.[4]||0),y:Number(it.transform?.[5]||0),w:Number(it.width||0),h:Number(it.height||0)});
 }
 if(!items.length)return {page:n,text:'',lines:[],width:vp.width,height:vp.height,columns:1};

 // IMPORTANT: classify text items into columns BEFORE grouping by Y.
 // On the source TOEIC PDFs, question 101 and 105 can have exactly the same Y.
 // Grouping by Y first merges the two columns and loses A-D for the left question.
 // We detect a real two-column layout from question-number anchors, then build
 // lines independently inside each column.
 const qItems=items.filter(it=>/^(?:10[1-9]|1[1-9]\d|19\d|200)[.)]?$/.test(String(it.text).trim()));
 let twoCol=false,cut=vp.width/2;
 const leftQ=qItems.filter(it=>it.x<vp.width*.45),rightQ=qItems.filter(it=>it.x>vp.width*.55);
 if(leftQ.length>=2&&rightQ.length>=2){
   const lx=leftQ.reduce((a,b)=>a+b.x,0)/leftQ.length;
   const rx=rightQ.reduce((a,b)=>a+b.x,0)/rightQ.length;
   if(rx-lx>vp.width*.25){twoCol=true;cut=(lx+rx)/2;}
 }
 // Fallback for pages whose question numbers are OCR/text fragments: use the
 // strongest horizontal gap between item starts, but only when it is clearly a gutter.
 if(!twoCol){
   const xs=[...new Set(items.map(it=>Math.round(it.x*10)/10))].sort((a,b)=>a-b);
   let bestGap=0,bestI=-1;
   for(let i=1;i<xs.length;i++){const g=xs[i]-xs[i-1];if(g>bestGap){bestGap=g;bestI=i;}}
   if(bestI>0&&bestI<xs.length&&bestGap>vp.width*.22){
     const c=(xs[bestI-1]+xs[bestI])/2;
     const l=items.filter(it=>it.x<=c),r=items.filter(it=>it.x>c);
     if(l.length>10&&r.length>10){twoCol=true;cut=c;}
   }
 }
 const makeLines=(arr)=>{
   const ys=[];
   for(const it of arr){
     let row=ys.find(r=>Math.abs(r.y-it.y)<=3);
     if(!row){row={y:it.y,items:[]};ys.push(row)}
     row.items.push(it);
   }
   return ys.sort((a,b)=>b.y-a.y).map(r=>{
     r.items.sort((a,b)=>a.x-b.x);
     return {x:Math.min(...r.items.map(i=>i.x)),y:r.y,text:clean(r.items.map(i=>i.text).join(' '))};
   }).filter(r=>r.text);
 };
 let lines;
 if(twoCol){
   const left=makeLines(items.filter(it=>it.x<=cut));
   const right=makeLines(items.filter(it=>it.x>cut));
   lines=[...left,...right];
 }else{
   lines=makeLines(items);
 }
 return {page:n,text:lines.map(l=>l.text).join('\n'),lines,width:vp.width,height:vp.height,columns:twoCol?2:1};
}
async function pageText(doc,n){const x=await pageLayout(doc,n);return x.text}
async function renderPage(doc,n,scale=1){const p=await doc.getPage(n),vp=p.getViewport({scale}),c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;return {canvas:c,page:p}}
async function ocrCanvas(canvas){
 if(!worker)worker=await Tesseract.createWorker('eng',1,{logger:m=>{if(m.status&&m.progress!=null)status('🧠 '+m.status+' '+Math.round(m.progress*100)+'%')}});
 const r=await worker.recognize(canvas);return {text:clean(r.data.text),tsv:r.data.tsv||''};
}
function reset(){pageInfo=[];bank=[];groups=[];answerFindings=[];sourcePdfs.clear();sourceFiles=[];passageBlobs.clear();editingIndex=-1;for(const id of ['btnOCR','btnAnswers','btnExport','btnExportOfficial'])if($(id))$(id).disabled=true;$('bankRows').innerHTML='';$('answerRows').innerHTML='';$('tests').innerHTML='';$('summary').textContent='Chưa có dữ liệu.';$('answerStatus').textContent='Chưa nhận diện đáp án.';$('issues').textContent='Chưa phân tích.';$('editor').classList.add('hidden');$('editorEmpty').classList.remove('hidden');}
function detectPartPages(info){const t=info.text;return /PART\s*5\b/i.test(t)?'Part 5':/PART\s*6\b/i.test(t)?'Part 6':/PART\s*7\b/i.test(t)?'Part 7':''}
function detectTestsFromPages(pages){
 // Two complementary anchors are used:
 // 1) explicit Actual Test/divider markers when present;
 // 2) fallback: question-number reset 101 => next test.
 let current='',nextAuto=1,lastAnswerTest=0,afterAnswerPage=-1,boundarySet=false;const out=[];
 for(let i=0;i<pages.length;i++){
  const p=pages[i],raw=String(p.text||''),compact=raw.replace(/[–—]/g,'-').replace(/\s+/g,' ');
  const ans=compact.match(/Answers[._\s-]*Actual\s*Test\s*0?([0-9]{1,2})/i);
  const explicit=actualFromText(raw);
  const marker=compact.match(/(?:^|\s)(1[0-5]|[1-9])\s+Part\s*[5S]\s*Part\s*[6G]\b/i)||compact.match(/Part\s*[5S]\s*Part\s*[6G]\s*(1[0-5]|[1-9])(?:\s|$)/i);
  const genericDivider=/\bPart\s*[5S]\s*Part\s*[6G]\b/i.test(compact);
  if(ans){current='Actual Test '+String(Number(ans[1])).padStart(2,'0');lastAnswerTest=Number(ans[1]);afterAnswerPage=i;boundarySet=false;p.isAnswerPage=true;p.actual=current;out.push(p);continue}
  if(marker){current='Actual Test '+String(Number(marker[1])).padStart(2,'0');lastAnswerTest=Number(marker[1]);boundarySet=true;}
  else if(genericDivider && current && i>afterAnswerPage && !/READING\s*TEST/i.test(compact)){
   // Divider/footer without a visible number. If it follows an answer page, it belongs to the next test.
   current='Actual Test '+String(lastAnswerTest+1).padStart(2,'0');lastAnswerTest++;boundarySet=true;
  }
  // If the next test has no numbered divider, its first Reading Test page is a reliable boundary after an answer page.
  if(/READING\s*TEST/i.test(compact) && afterAnswerPage>=0 && i>afterAnswerPage && !/Answers[._\s-]*Actual/i.test(compact)){
   const candidate=lastAnswerTest+1;
   if(!marker && !boundarySet && candidate<=15){current='Actual Test '+String(candidate).padStart(2,'0');lastAnswerTest=candidate;boundarySet=true;}
  }
  if(explicit)current=explicit;
  if(current)p.actual=current;
  out.push(p);
 }
 return out;
}
function inferTestsFromQuestionPages(pages,fileName='',fallbackTestNo=1){
 // Many real TOEIC PDFs (including "De 1- TOEIC.pdf") do not print "Actual Test".
 // In those files each test starts again at question 101. Assign the test to the
 // PAGE before question parsing so parseQuestionsFromPages() can actually keep it.
 let testNo=0,seenAny=false,lastMax=0;
 const fileMatch=String(fileName||'').match(/(?:De|Test|TEST)\s*[-_ ]*0?(\d{1,2})/i);
 const fileNo=fileMatch?Number(fileMatch[1]):Number(fallbackTestNo)||1;
 for(const p of pages){
  const nums=qNumbers(p.text||'');
  const has101=nums.includes(101);
  const meaningful=nums.some(n=>n>=101&&n<=200);
  if(has101 && seenAny){testNo++;}
  if(has101 && !seenAny){testNo=fileNo||1;}
  if(meaningful && !testNo){testNo=fileNo||1;}
  if(meaningful){seenAny=true;lastMax=Math.max(lastMax,...nums);p.actual='Actual Test '+String(testNo||1).padStart(2,'0');}
 }
 // If the source has questions but no visible 101 on a page (rare split layout),
 // propagate the current test number forward to pages containing questions.
 if(seenAny){let cur=testNo||fileNo||1;for(const p of pages){if(p.actual)cur=Number(String(p.actual).slice(-2))||cur;else if(qNumbers(p.text||'').some(n=>n>=101&&n<=200))p.actual='Actual Test '+String(cur).padStart(2,'0');}}
 return pages;
}
function splitQuestionChunks(text){
 const s=String(text||'').replace(/\r/g,' ');
 // Robust against 1-column and 2-column PDF extraction. The old version only
 // accepted a question number at the beginning of a line; that caused valid
 // 2-column pages such as "101. ... 105. ..." to produce 0 câu.
 const re=/(?:^|[\s|])((?:10[1-9]|1[1-9]\d|19\d|200))\s*[.)\-:]?\s+(?=[A-Za-z(“"'])/g;
 const hits=[];let m;
 while((m=re.exec(s)))hits.push({n:Number(m[1]),start:m.index+m[0].length});
 const out=[];
 for(let i=0;i<hits.length;i++){
   const end=i+1<hits.length?hits[i+1].start:s.length;
   out.push({n:hits[i].n,text:clean(s.slice(hits[i].start,end))});
 }
 return out.filter(x=>x.n>=101&&x.n<=200);
}
function parseOptions(chunk){
 const s=clean(chunk).replace(/\s+/g,' ');const re=/(?:^|\s)(\(?([ABCD])\)?)[.)\-:]?\s+/gi;const hits=[];let m;while((m=re.exec(s)))hits.push({letter:m[2].toUpperCase(),start:m.index+m[0].length,markerStart:m.index});
 const o={A:'',B:'',C:'',D:''};if(!hits.length)return {q:s,...o};const q=s.slice(0,hits[0].markerStart).trim();for(let i=0;i<hits.length;i++){const end=i+1<hits.length?hits[i+1].start:s.length;const key=hits[i].letter;o[key]=clean(s.slice(hits[i].start,end)).replace(/^[.)\-:]\s*/,'').trim()}return {q:clean(q),...o};
}
function parseQuestionsFromPages(pages){
 const rows=[];for(const p of pages){
  if(!p.actual)continue;
  if(/Answers[._\s-]*Actual\s*Test/i.test(String(p.text||'')))continue;
  for(const ch of splitQuestionChunks(p.text)){
   const po=parseOptions(ch.text);
   if(!rows.some(r=>r.n===ch.n&&r.page===p.page))rows.push({n:ch.n,q:po.q,A:po.A,B:po.B,C:po.C,D:po.D,page:p.page,actual:p.actual,sourceFile:p.sourceFile,doc:p.doc});
  }
 }
 return rows;
}
function buildGroupsFromBankRows(rows){
 const gs=[];
 for(const test of [...new Set(rows.map(r=>r.actual).filter(Boolean))]){
  const rr=rows.filter(r=>r.actual===test).sort((a,b)=>a.n-b.n);
  const p6=rr.filter(r=>r.n>=141&&r.n<=152);
  for(let i=0;i<p6.length;i+=3){const chunk=p6.slice(i,i+3);if(chunk.length)gs.push({id:`P6-T${test.slice(-2)}-G${String(i/3+1).padStart(2,'0')}`,test,start:chunk[0].n,end:chunk.at(-1).n,startPage:chunk[0].page,endPage:chunk.at(-1).page,part:'Part 6'});}
  const p7=rr.filter(r=>r.n>=153&&r.n<=200);let idx=1;
  // Prefer explicit "Questions xxx–yyy refer to..." headers from the source pages.
  const headers=[];
  for(const p of pageInfo.filter(p=>p.actual===test)){
   const t=String(p.text||'').replace(/[–—]/g,'-').replace(/\s+/g,' ');
   const re=/Questions?\s*(153|1[5-9]\d|200)\s*(?:-|to)\s*(153|1[5-9]\d|200)\s*(?:refer|refe?r|r[e3]fer)\s*(?:to)?/gi;let m;
   while((m=re.exec(t))){const a=Number(m[1]),b=Number(m[2]);if(a>=153&&b<=200&&b>=a)headers.push({start:a,end:b,page:p.page});}
  }
  const uniq=[];const seen=new Set();for(const h of headers){const k=h.start+'-'+h.end;if(!seen.has(k)){seen.add(k);uniq.push(h)}}
  if(uniq.length){
   for(const h of uniq){const q0=p7.find(q=>q.n>=h.start&&q.n<=h.end),q1=[...p7].reverse().find(q=>q.n>=h.start&&q.n<=h.end);gs.push({id:`P7-T${test.slice(-2)}-G${String(idx++).padStart(2,'0')}`,test,start:h.start,end:h.end,startPage:q0?.page||h.page,endPage:q1?.page||h.page,part:'Part 7'});}
  }else{
   // Fallback when headers are lost: split at non-contiguous runs, but never fabricate a group boundary.
   for(let i=0;i<p7.length;){const start=p7[i].n;let end=start,j=i+1;while(j<p7.length&&p7[j].n===end+1){end=p7[j].n;j++}if(end-start+1>=2)gs.push({id:`P7-T${test.slice(-2)}-G${String(idx++).padStart(2,'0')}`,test,start,end,startPage:p7[i].page,endPage:p7[j-1]?.page||p7[i].page,part:'Part 7'});i=j;}
  }
 }
 return gs;
}
function makeRecord(r,part,group){
 const t=r.actual||'Actual Test 01',num=r.n,tid=t.slice(-2),gid=group?.id||'';
 const src=r.sourceFile||'PDF người dùng chọn';
 return {MaCau:`${part.replace(' ','')}-T${tid}-${num}`,Part:part,CauSo:num,ActualTest:t,GroupID:gid,ChuDe:'PDF người dùng chọn',DangBai:part==='Part 5'?'Hoàn thành câu':part==='Part 6'?'Đọc đoạn văn và chọn đáp án':'Đọc hiểu theo bài',CauHoi:r.q||'',DapAnA:r.A||'',DapAnB:r.B||'',DapAnC:r.C||'',DapAnD:r.D||'',DapAnDung:'',GiaiThich:'',PassageImageURL:'',HinhBaiDoc:'',SourcePageStart:r.page||'',SourcePageEnd:r.page||'',Source:src,DataStatus:'SOURCE_PDF_PARSED_PENDING_REVIEW',GroupIndex:group?Number(group.id.match(/G(\d+)$/)?.[1]||0):0,GroupStart:group?.start||'',GroupEnd:group?.end||'',ReviewStatus:'PENDING'};
}
function renderSummary(){
 const tests=[...new Set(bank.map(x=>x.ActualTest))];const counts={};for(const q of bank)counts[q.Part]=(counts[q.Part]||0)+1;
 $('summary').innerHTML=`<b>${bank.length}</b> câu · <b>${tests.length}</b> Actual Test · Part 5: <b>${counts['Part 5']||0}</b> · Part 6: <b>${counts['Part 6']||0}</b> · Part 7: <b>${counts['Part 7']||0}</b>`;
 $('tests').innerHTML=tests.map(t=>{const qs=bank.filter(q=>q.ActualTest===t);return `<div class="test-card"><h3>${esc(t)}</h3><span class="badge">${qs.length} câu</span><div class="small">${['Part 5','Part 6','Part 7'].filter(p=>qs.some(q=>q.Part===p)).map(p=>p+': '+qs.filter(q=>q.Part===p).length).join(' · ')}</div></div>`}).join('');
}
async function scan(){
 const files=[...($('pdfFile').files||[])];
 if(!files.length){status('⚠️ Hãy chọn ít nhất một PDF đề.');return}
 reset();stopped=false;$('btnScan').disabled=true;$('btnStop').disabled=false;progress(0);
 try{
  const startInput=Math.max(1,Number($('startPage').value)||1);
  const endInput=Number($('endPage').value)||0;
  const allPages=[]; sourceFiles=files.slice();
  let processed=0,total=0;
  for(const f of files){const d=await openPdf(f);total+=Math.max(0,Math.min(d.numPages,endInput||d.numPages)-startInput+1);sourcePdfs.set(f.name,d)}
  for(let fi=0;fi<files.length&&!stopped;fi++){
   const f=files[fi],doc=sourcePdfs.get(f.name);sourcePdf=doc;
   const s=Math.min(doc.numPages,startInput),e=Math.min(doc.numPages,endInput||doc.numPages);
   for(let n=s;n<=e&&!stopped;n++){
    let pg=await pageLayout(doc,n);
    if(!pg.text){const r=await renderPage(doc,n,.9),o=await ocrCanvas(r.canvas);pg={page:n,text:o.text,lines:o.text.split(/\n/).map(x=>({x:0,y:0,text:x})),source:'ocr'}}else pg.source='text';
    pg.doc=doc;pg.sourceFile=f.name;allPages.push(pg);processed++;progress(Math.min(55,processed/Math.max(1,total)*55));
   }
   status(`📖 Đã phân tích đề ${fi+1}/${files.length}: ${f.name}`);
  }
  const byFile=new Map();for(const p of allPages){if(!byFile.has(p.sourceFile))byFile.set(p.sourceFile,[]);byFile.get(p.sourceFile).push(p)}
  let fi=0;for(const [fname,pages] of byFile){detectTestsFromPages(pages);inferTestsFromQuestionPages(pages,fname,fi+1);fi++}
  pageInfo=allPages;
  let rows=[];for(const p of pageInfo)for(const r of parseQuestionsFromPages([p]))rows.push({...r,sourceFile:p.sourceFile,doc:p.doc});
  // If a PDF has a text layer but its line structure prevents question detection,
  // OCR only that source as a fallback instead of silently producing 0 câu.
  const filesWithRows=new Set(rows.map(r=>r.sourceFile));
  for(const f of files){
   if(stopped||filesWithRows.has(f.name))continue;
   const doc=sourcePdfs.get(f.name);if(!doc)continue;
   status(`🧠 OCR dự phòng cho ${f.name} vì chưa nhận được câu 101–200…`);
   const extra=[];
   for(let n=1;n<=doc.numPages&&!stopped;n++){
    const pg=pageInfo.find(x=>x.sourceFile===f.name&&x.page===n);if(!pg)continue;
    const r=await renderPage(doc,n,.9),o=await ocrCanvas(r.canvas);
    const op={...pg,text:o.text,source:'ocr'};extra.push(op);pageInfo[pageInfo.indexOf(pg)]=op;
   }
   const ep=extra.filter(x=>x.actual);for(const p of ep)for(const r of parseQuestionsFromPages([p]))rows.push({...r,sourceFile:f.name,doc});
  }
  const partRows=rows.filter(r=>r.n>=101&&r.n<=200);groups=buildGroupsFromBankRows(partRows);bank=[];
  for(const r of partRows){const part=inferPart(r.n),g=groups.find(x=>x.test===r.actual&&r.n>=x.start&&r.n<=x.end&&x.part===part);bank.push(makeRecord(r,part,g))}
  const seen=new Set();bank=bank.filter(q=>{const k=q.ActualTest+'|'+q.CauSo;if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.ActualTest.localeCompare(b.ActualTest)||a.CauSo-b.CauSo);
  renderSummary();renderBank();$('btnAnswers').disabled=!bank.length;$('btnExport').disabled=!bank.length;$('btnOCR').disabled=!bank.length;
  if($('answerFile')?.files?.[0]&&bank.length){status(`🔑 Đã phân tích ${bank.length} câu từ ${files.length} PDF. Đang tự động ghép đáp án…`);await recognizeAnswers();}
  else status(`✅ Đã phân tích ${bank.length} câu từ ${files.length} PDF đề.${bank.length?'':' ⚠️ Không nhận được câu 101–200 trong phạm vi trang đã chọn.'}`);
 }catch(e){console.error(e);status('❌ '+(e.message||e))}finally{$('btnScan').disabled=false;$('btnStop').disabled=true}
}
async function ocrAllMissing(){
 if(!sourcePdf||!bank.length)return;const missing=bank.filter(q=>!q.CauHoi||!q.DapAnA||!q.DapAnB||!q.DapAnC||!q.DapAnD);if(!missing.length){status('✅ Không có câu thiếu dữ liệu.');return}stopped=false;for(let i=0;i<missing.length&&!stopped;i++){const q=missing[i];const meta=pageInfo.find(p=>p.sourceFile===q.Source&&p.page===Number(q.SourcePageStart));const doc=meta?.doc||sourcePdf;if(!doc)continue;const r=await renderPage(doc,q.SourcePageStart,1.25),o=await ocrCanvas(r.canvas);const ch=splitQuestionChunks(o.text).find(x=>x.n===q.CauSo);if(ch){const po=parseOptions(ch);Object.assign(q,{CauHoi:po.q,DapAnA:po.A,DapAnB:po.B,DapAnC:po.C,DapAnD:po.D,DataStatus:'SOURCE_OCR_PENDING_REVIEW'})}progress((i+1)/missing.length*100);status(`🧠 OCR bổ sung ${q.ActualTest} câu ${q.CauSo}…`)}renderBank();status('✅ Đã hoàn tất OCR bổ sung.');}
function parseAnswerText(text){
 const out={};let s=String(text||'').replace(/\b(Actual\s*Test)\b/gi,'Actual Test');
 // Accept 101 (B), 101 B, 101. B and OCR-style 0/8/C/D after a number.
 const re=/(?:^|[\s|])(10[1-9]|1[1-9]\d|19\d|200)\s*[.)\-:]?\s*\(?([ABCD])\)?\b/gi;let m;while((m=re.exec(s)))out[Number(m[1])]=m[2].toUpperCase();
 // OCR sometimes turns B into 8 or D into 0. Only use when immediately following the question number.
 const re2=/(?:^|[\s|])(10[1-9]|1[1-9]\d|19\d|200)\s*[.)\-:]?\s*\(?([08])\)?\b/gi;while((m=re2.exec(s))){const a=m[2]==='8'?'B':'D';if(!out[Number(m[1])])out[Number(m[1])]=a}
 return out;
}
async function recognizeAnswers(){
 const f=$('answerFile')?.files?.[0];if(!f){status('⚠️ Hãy chọn PDF đáp án.');return}if(!bank.length){status('⚠️ Hãy phân tích PDF đề trước.');return}$('btnAnswers').disabled=true;answerFindings=[];
 try{
  answerPdf=await openPdf(f);
  // Build answer sections by explicit "Test N" headings. This prevents answers from
  // Test 2..10 overwriting Test 1 when the answer PDF contains many tests.
  const sections={};let currentTest=0;
  for(let p=1;p<=answerPdf.numPages;p++){
   const text=await pageText(answerPdf,p);
   const compact=String(text||'').replace(/\s+/g,' ');
   const hits=[...String(text||'').matchAll(/(?:^|\n)\s*Test\s*0?(\d{1,2})\s*$/gim)];
   if(hits.length)currentTest=Number(hits[hits.length-1][1]);
   // Also catch headings embedded in OCR/text flow, but avoid TOC lines with dots/page numbers.
   if(!currentTest){const m=compact.match(/\bTest\s*0?(\d{1,2})\s*$/i);if(m)currentTest=Number(m[1]);}
   if(currentTest){(sections[currentTest]??=[]).push({page:p,text});}
  }
  const byTest={};for(const q of bank)(byTest[q.ActualTest]??=[]).push(q);
  for(const [test,qs] of Object.entries(byTest)){
   const m=test.match(/(\d+)$/);const testNo=m?Number(m[1]):1;
   const candidatePages=sections[testNo]||[];
   // If the answer PDF has no Test headings, fall back to all pages.
   const pagesToUse=candidatePages.length?candidatePages:Array.from({length:answerPdf.numPages},(_,i)=>({page:i+1,text:''}));
   let answers={};let pagesUsed=[];
   for(const item of pagesToUse){
    const text=item.text||await pageText(answerPdf,item.page);
    const a=parseAnswerText(text);
    const useful=Object.keys(a).some(n=>qs.some(q=>q.CauSo===Number(n)));
    if(useful){Object.assign(answers,a);pagesUsed.push(item.page)}
   }
   let assigned=0;
   for(const q of qs){if(answers[q.CauSo]){q.DapAnDung=answers[q.CauSo];q.AnswerSource=`PDF đáp án · Test ${testNo} · trang ${pagesUsed.join(',')}`;q.AnswerStatus='AUTO_DETECTED_PENDING_VERIFY';assigned++}}
   answerFindings.push({test,pages:pagesUsed.join(','),detected:Object.keys(answers).length,assigned,confidence:assigned===qs.length?'HIGH':assigned?'MEDIUM':'NONE'});
  }
  renderAnswers();renderBank();status('✅ Đã phân tích đề và ghép đáp án từ PDF riêng. Tất cả đáp án vẫn ở trạng thái chờ xác nhận.');
 }catch(e){status('❌ Không đọc được PDF đáp án: '+e.message)}finally{$('btnAnswers').disabled=false}
}

function renderAnswers(){const total=answerFindings.reduce((n,x)=>n+x.assigned,0);$('answerStatus').innerHTML=`<b>${answerFindings.length}</b> Actual Test · <b>${total}</b> đáp án gán được. ⚠️ Cần kiểm tra trước khi xuất chính thức.`;$('answerRows').innerHTML=answerFindings.map(x=>`<tr><td>${esc(x.test)}</td><td>${esc(x.pages||'—')}</td><td>${x.detected}</td><td>${x.assigned}</td><td class="${x.confidence==='HIGH'?'ok':'bad'}">${x.confidence}</td></tr>`).join('')}

function isReviewComplete(q){
 return !!(q&&q.CauHoi&&q.DapAnA&&q.DapAnB&&q.DapAnC&&q.DapAnD&&/^[ABCD]$/.test(q.DapAnDung||''));
}
function syncIncompleteStatuses(){
 for(const q of bank){
   if(!isReviewComplete(q)) q.ReviewStatus='INCOMPLETE';
   else if(q.ReviewStatus==='INCOMPLETE') q.ReviewStatus='PENDING';
 }
}

function renderBank(){
 syncIncompleteStatuses();
 const missing=bank.filter(q=>!isReviewComplete(q)).length;
 const verified=bank.filter(q=>q.ReviewStatus==='VERIFIED').length;
 const pending=bank.filter(q=>q.ReviewStatus==='PENDING').length;
 $('issues').className=missing?'dangerbox':'warnbox';
 $('issues').innerHTML=`<span><b>${bank.length}</b> câu · <b>${verified}</b> đã xác nhận · <b>${pending}</b> PENDING · <b>${missing}</b> INCOMPLETE</span>
 <button id="btnPendingAll" class="btn secondary" style="margin-left:12px;padding:6px 10px" ${bank.length?'':'disabled'}>↩ Đưa tất cả về PENDING</button>
 <button id="btnVerifyAll" class="btn primary" style="margin-left:8px;padding:6px 10px" ${pending?'':'disabled'}>✅ Xác nhận tất cả PENDING</button>`;
 const btnPendingAll=$('btnPendingAll');
 if(btnPendingAll)btnPendingAll.onclick=()=>{
   if(!bank.length)return;
   if(!confirm(`Đưa các câu đủ A/B/C/D và đáp án về PENDING? Câu thiếu dữ liệu sẽ giữ INCOMPLETE.`))return;
   let n=0;bank.forEach(q=>{if(isReviewComplete(q)){q.ReviewStatus='PENDING';n++}else q.ReviewStatus='INCOMPLETE'});
   renderBank();
   if(editingIndex>=0)openEditor(editingIndex);
   status(`↩ Đã đưa ${n} câu đủ dữ liệu về PENDING; câu thiếu dữ liệu tự động INCOMPLETE.`);
 };
 const btnVerifyAll=$('btnVerifyAll');
 if(btnVerifyAll)btnVerifyAll.onclick=()=>{
   const candidates=bank.filter(q=>q.ReviewStatus==='PENDING'&&isReviewComplete(q));
   if(!candidates.length){status('ℹ️ Không có câu PENDING đủ dữ liệu để xác nhận.');return;}
   if(!confirm(`Xác nhận ${candidates.length} câu PENDING đủ Câu hỏi + A/B/C/D + đáp án?\n\nCâu INCOMPLETE sẽ không bị xác nhận.`))return;
   candidates.forEach(q=>{q.ReviewStatus='VERIFIED';q.DataStatus='SOURCE_VERIFIED_BY_USER';q.AnswerStatus='VERIFIED_BY_USER'});
   renderBank();
   if(editingIndex>=0)openEditor(editingIndex);
   status(`✅ Đã xác nhận hàng loạt ${candidates.length} câu. ${bank.filter(q=>q.ReviewStatus==='INCOMPLETE').length} câu INCOMPLETE vẫn chưa xác nhận.`);
 };
 $('bankRows').innerHTML=bank.map((q,i)=>`<tr data-i="${i}" style="cursor:pointer"><td>${esc(q.ActualTest)}</td><td>${esc(q.Part)}${q.GroupID?'<br><span class="small">'+esc(q.GroupID)+'</span>':''}</td><td><b>${q.CauSo}</b></td><td><b>${esc(q.CauHoi)}</b><br>A. ${esc(q.DapAnA)}<br>B. ${esc(q.DapAnB)}<br>C. ${esc(q.DapAnC)}<br>D. ${esc(q.DapAnD)}</td><td><b>${esc(q.DapAnDung||'—')}</b></td><td class="${q.ReviewStatus==='VERIFIED'?'ok':'bad'}">${esc(q.ReviewStatus)}</td></tr>`).join('');
 document.querySelectorAll('#bankRows tr').forEach(tr=>tr.onclick=()=>openEditor(Number(tr.dataset.i)));
 $('btnExportOfficial').disabled=!(bank.length&&bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||'')));
}
function openEditor(i){editingIndex=i;const q=bank[i];$('editorEmpty').classList.add('hidden');$('editor').classList.remove('hidden');$('eGroup').value=`${q.ActualTest} · ${q.Part}${q.GroupID?' · '+q.GroupID:''}`;$('eNo').value=q.CauSo;$('eAns').value=q.DapAnDung||'';$('eQ').value=q.CauHoi||'';$('eA').value=q.DapAnA||'';$('eB').value=q.DapAnB||'';$('eC').value=q.DapAnC||'';$('eD').value=q.DapAnD||'';$('eExp').value=q.GiaiThich||'';$('editorPreview').textContent=`Trang nguồn: ${q.SourcePageStart}–${q.SourcePageEnd} · ${q.DataStatus} · ${q.ReviewStatus} · ${q.AnswerSource||''}`}
function saveEditor(){if(editingIndex<0)return;const q=bank[editingIndex];q.CauHoi=$('eQ').value.trim();q.DapAnA=$('eA').value.trim();q.DapAnB=$('eB').value.trim();q.DapAnC=$('eC').value.trim();q.DapAnD=$('eD').value.trim();q.DapAnDung=$('eAns').value;q.GiaiThich=$('eExp').value.trim();q.ReviewStatus=isReviewComplete(q)?'PENDING':'INCOMPLETE';renderBank();openEditor(editingIndex);status(`💾 Đã lưu câu ${q.CauSo}.`)}
function verifyEditor(){if(editingIndex<0)return;const q=bank[editingIndex];if(!q.CauHoi||![q.DapAnA,q.DapAnB,q.DapAnC,q.DapAnD].every(Boolean)||!/^[ABCD]$/.test(q.DapAnDung||'')){alert('Cần đủ câu hỏi, A/B/C/D và đáp án đúng trước khi xác nhận.');return}q.ReviewStatus='VERIFIED';q.DataStatus='SOURCE_VERIFIED_BY_USER';q.AnswerStatus='VERIFIED_BY_USER';renderBank();openEditor(editingIndex);status(`✅ Đã xác nhận câu ${q.CauSo}.`)}
function unverifyEditor(){if(editingIndex<0)return;const q=bank[editingIndex];q.ReviewStatus=isReviewComplete(q)?'PENDING':'INCOMPLETE';renderBank();openEditor(editingIndex)}
async function exportZip(official=false){
 if(!bank.length)return;if(official&&!bank.every(q=>q.ReviewStatus==='VERIFIED'&&/^[ABCD]$/.test(q.DapAnDung||''))){alert('Chưa thể xuất chính thức: còn câu chưa xác nhận hoặc thiếu đáp án.');return}
 const zip=new JSZip(),out=JSON.parse(JSON.stringify(bank)),stamp=official?'verified':'draft';zip.file(`TOEIC_BANK_BUILDER_${stamp}.json`,JSON.stringify(out,null,2));zip.file('README_V44.1.13_BUILDER.txt',`V44.1.6 Integrated TOEIC Bank Builder\n\nPart 5 / Part 6 / Part 7.\nNguồn đề: ${sourceFiles.map(f=>f.name).join(' | ')||''}\nNguồn đáp án: ${$('answerFile')?.files[0]?.name||'không dùng'}\n${official?'Bản đã được người dùng rà soát/xác nhận.':'Bản nháp, cần rà soát.'}\n`);
 if(passageBlobs.size){const folder=zip.folder('TOEIC_PART7_GROUPS');for(const [id,blob] of passageBlobs)folder.file(id.toLowerCase().replace(/-/g,'_')+'.jpg',blob)}
 status('📦 Đang đóng ZIP…');const b=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=`V44.1.5_TOEIC_BANK_${stamp}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);status(`✅ Đã xuất ${official?'bản chính thức':'bản nháp'} ZIP.`)
}
async function makePart7Images(){
 // Keep this optional and conservative: only create images for detected Part 7 groups.
 for(const g of groups.filter(x=>x.part==='Part 7')){if(passageBlobs.has(g.id)||!sourcePdf)continue;const pages=pageInfo.filter(p=>p.page>=g.startPage&&p.page<=g.endPage);if(!pages.length)continue;const cs=[];for(const p of pages){const r=await renderPage(p.doc||sourcePdf,p.page,1.05);cs.push(r.canvas)}const w=Math.max(...cs.map(c=>c.width)),h=cs.reduce((n,c)=>n+c.height,0),c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');let y=0;for(const x of cs){ctx.drawImage(x,0,y);y+=x.height}const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',.86));passageBlobs.set(g.id,blob)}
}
function addBuilderUI(){
 const modal=$('toeic-bank-builder-modal');if(!modal)return;
 const first=modal.querySelector('#pdfFile');
 if(first&&!modal.querySelector('#answerFile')){
   first.parentElement.insertAdjacentHTML('afterend','<div class="field" style="flex:2"><label>File PDF đáp án chung <span class="small">(1 file dùng cho nhiều PDF đề)</span></label><input id="answerFile" type="file" accept="application/pdf"></div>');
 }
 const scan=$('btnScan');if(scan)scan.textContent='🔎 Phân tích + ghép đáp án';
 const ocr=$('btnOCR');if(ocr)ocr.textContent='🧠 OCR bổ sung câu thiếu';
 const ans=$('btnAnswers');if(ans)ans.textContent='🔑 Nạp PDF đáp án riêng';
 const p=modal.querySelector('.builder-content .card .small');if(p)p.innerHTML='Builder cho phép chọn <b>nhiều PDF đề</b> (ví dụ De 1–De 10) và <b>một PDF đáp án chung</b>. Tự nhận diện Part 5 (101–140), Part 6 (141–152), Part 7 (153–200), sau đó tự ghép đáp án theo Actual Test.';
 const rule=modal.querySelector('.builder-content .card:last-of-type .small');if(rule)rule.innerHTML='<p>• Part 5: câu 101–140.</p><p>• Part 6: câu 141–152, tự nhóm 3 câu.</p><p>• Part 7: câu 153–200, nhóm theo chuỗi câu liên tiếp.</p><p>• Có thể chọn nhiều PDF đề; một PDF đáp án chung sẽ được tự động ghép theo Actual Test.</p><p>• Đáp án chấp nhận dạng 101 (B), 101 B, 101. B và OCR B/8, D/0.</p><p>• Dữ liệu luôn ở trạng thái PENDING cho tới khi người dùng xác nhận.</p><p>• ZIP xuất ra dùng <b>TOEIC_PART7_GROUPS/</b>.</p>';
 const af=$('answerFile');
 if(af&&!af.dataset.bound){af.dataset.bound='1';af.addEventListener('change',()=>{const f=af.files[0];if(f)status(`🔑 PDF đáp án chung: ${f.name}. Sẽ tự động ghép cho tất cả PDF đề đã chọn.`)});}
}

$('btnSaveReview').onclick=saveEditor;$('btnVerify').onclick=verifyEditor;$('btnUnverify').onclick=unverifyEditor;$('btnExportOfficial').onclick=()=>exportZip(true);$('btnAnswers').onclick=recognizeAnswers;$('btnScan').onclick=scan;$('btnStop').onclick=()=>{stopped=true;status('⏹ Đã yêu cầu dừng.')};$('btnOCR').onclick=ocrAllMissing;$('btnExport').onclick=async()=>{await makePart7Images();await exportZip(false)};
$('pdfFile').addEventListener('change',async()=>{const fs=[...$('pdfFile').files];if(!fs.length)return;try{const info=await Promise.all(fs.map(async f=>{const d=await openPdf(f);return `${f.name} (${d.numPages} trang)`;}));status(`📄 Đã chọn ${fs.length} PDF đề: ${info.join(' · ')}`);}catch(e){status('❌ Không mở được PDF đề: '+e.message)}});
$('answerFile')?.addEventListener('change',()=>{const f=$('answerFile').files[0];if(f)status(`🔑 PDF đáp án chung: ${f.name}. Bấm “Phân tích + ghép đáp án”.`)});
window.openToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='flex';document.body.style.overflow='hidden';addBuilderUI()}};
window.closeToeicBankBuilder=function(){const m=document.getElementById('toeic-bank-builder-modal');if(m){m.style.display='none';document.body.style.overflow=''}};
window.addEventListener('beforeunload',()=>{if(worker)worker.terminate()});
